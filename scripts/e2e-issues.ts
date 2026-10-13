// End-to-end test of S-08 (issues from a conversation, GitHub or Linear) against a running dev
// server. The draft uses real AI (E2E_AI_PROVIDER, default ChatGPT). Filing never reaches GitHub or Linear here: the e2e
// server has neither GITHUB_TOKEN nor LINEAR_API_KEY, and the pasted-credential step removes what it
// saves, so this checks validation and the "not configured" paths; the tracker requests are covered by worker/lib/{github,linear}.test.ts.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
let workspaceId = "";
let widgetKey = "";
let conversationId = "";
let visitorToken = "";
let aiSettings: Record<string, unknown> = {};

const now = Date.now();
/** What the loader would send, before its own masking (the server masks again). */
const context = {
  page: { url: "https://app.customer.test/billing?session=abc123", title: "Billing · pat@customer.test" },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  viewport: { w: 1280, h: 720 },
  language: "de-DE",
  timezone: "Europe/Berlin",
  capturedAt: now,
  events: [
    { t: now - 90_000, kind: "navigation", url: "https://app.customer.test/invoices" },
    { t: now - 60_000, kind: "navigation", url: "https://app.customer.test/billing" },
    { t: now - 30_000, kind: "network", method: "POST", url: "https://app.customer.test/api/billing/pay?email=pat@customer.test", status: 500, durationMs: 412 },
    { t: now - 29_000, kind: "error", message: "Payment failed for pat@customer.test: Bearer sk_live_51Hxyz", source: "https://app.customer.test/assets/checkout.js:120", stack: "Error: Payment failed\n    at pay (https://app.customer.test/assets/checkout.js:120:7)" },
  ],
};
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const setAi = (enabled: boolean) =>
  owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } });

await step("owner signs in; a teammate (agent role) joins", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Gus ${run}`, email: `gus-${run}@acme.test` })).status, 200);
});

await step("tracker settings: anyone in the workspace sees the status, never a credential", async () => {
  const status = await teammate.call(`/workspaces/${workspaceId}/trackers`);
  assert.equal(status.status, 200);
  assert.equal(status.json.github.tokenSet, false, "this e2e expects no GITHUB_TOKEN on the dev server (it must never reach real GitHub)");
  assert.equal(status.json.linear.keySet, false, "this e2e expects no LINEAR_API_KEY on the dev server (it must never reach real Linear)");
  // Only non-secret fields (a rerun may find a repo/team saved by an earlier run).
  assert.deepEqual(Object.keys(status.json.github).sort(), ["configured", "repo", "tokenHint", "tokenSet", "tokenSource"]);
  assert.deepEqual(Object.keys(status.json.linear).sort(), ["configured", "keyHint", "keySet", "keySource", "team"]);
  assert.equal(status.json.github.configured || status.json.linear.configured, false);
  assert.equal((await new Client().call(`/workspaces/${workspaceId}/trackers`)).status, 401);
  assert.equal((await owner.call(`/workspaces/ws_nope/trackers`)).status, 404);
});

await step("GitHub settings: only admins change the repo; it's validated; Test connection needs the secret", async () => {
  const base = `/workspaces/${workspaceId}/github`;
  assert.equal((await teammate.call(base, { method: "PUT", body: { repo: "acme/web-app" } })).status, 403);
  assert.equal((await teammate.call(`${base}/test`, { body: {} })).status, 403);
  for (const bad of ["acme", "acme/web app", "a/b/c", 42]) {
    const res = await owner.call(base, { method: "PUT", body: { repo: bad } });
    assert.equal(res.status, 400, `repo ${String(bad)}`);
    assert.match(res.json.error.message, /owner\/name/);
  }
  // Non-JSON writes are refused (CSRF guard).
  assert.equal((await owner.call(base, { method: "PUT", body: "repo=acme/web-app", headers: { "Content-Type": "text/plain" } })).status, 400);

  const saved = await owner.call(base, { method: "PUT", body: { repo: "https://github.com/acme/web-app.git" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.github, { repo: "acme/web-app", tokenSet: false, tokenSource: null, tokenHint: null, configured: false });
  const test = await owner.call(`${base}/test`, { body: {} });
  assert.equal(test.status, 200);
  assert.deepEqual([test.json.ok, test.json.reason], [false, "no_token"]);
  assert.match(test.json.message, /GitHub token/);
});

await step("pasted credentials: admins only, validated, saved write-only (last 4 shown), removable", async () => {
  const token = `github_pat_e2e${run}WXYZ`;
  const key = `lin_api_e2e${run}ABCD`;
  const tokenPath = `/workspaces/${workspaceId}/github/token`;
  const keyPath = `/workspaces/${workspaceId}/linear/key`;
  assert.equal((await teammate.call(tokenPath, { method: "PUT", body: { token } })).status, 403);
  assert.equal((await teammate.call(keyPath, { method: "PUT", body: { apiKey: key } })).status, 403);
  for (const bad of ["short", "has a space in it", 42, "x".repeat(501)]) {
    assert.equal((await owner.call(tokenPath, { method: "PUT", body: { token: bad } })).status, 400, `token ${String(bad).slice(0, 20)}`);
  }
  const saved = await owner.call(tokenPath, { method: "PUT", body: { token: `  ${token}
` } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.github.tokenSet, saved.json.github.tokenSource, saved.json.github.tokenHint], [true, "settings", "WXYZ"]);
  const savedKey = await owner.call(keyPath, { method: "PUT", body: { apiKey: key } });
  assert.deepEqual([savedKey.json.linear.keySet, savedKey.json.linear.keySource, savedKey.json.linear.keyHint], [true, "settings", "ABCD"]);
  // Never returned, to anyone.
  for (const who of [owner, teammate]) {
    const raw = JSON.stringify((await who.call(`/workspaces/${workspaceId}/trackers`)).json);
    assert.ok(!raw.includes(token) && !raw.includes(key), "a credential leaked into the status");
  }
  // Removed again, so nothing below can reach the real GitHub or Linear.
  const cleared = await owner.call(tokenPath, { method: "PUT", body: { token: null } });
  assert.deepEqual([cleared.json.github.tokenSet, cleared.json.github.tokenSource, cleared.json.github.tokenHint], [false, null, null]);
  assert.equal((await owner.call(keyPath, { method: "PUT", body: { apiKey: "" } })).json.linear.keySet, false);
});

await step("Linear settings: only admins pick the team; it's validated; Test connection needs the secret", async () => {
  const base = `/workspaces/${workspaceId}/linear`;
  const team = { id: "5a1c3f1e-0000-4000-8000-000000000001", key: "eng", name: "Engineering" };
  assert.equal((await teammate.call(base, { method: "PUT", body: { team } })).status, 403);
  assert.equal((await teammate.call(`${base}/test`, { body: {} })).status, 403);
  for (const bad of [{ id: "", key: "ENG", name: "x" }, { id: "t", key: "not a key", name: "x" }, { id: "t", key: "ENG" }, "ENG"]) {
    const res = await owner.call(base, { method: "PUT", body: { team: bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(res.json.error.message, /Linear team/);
  }
  const test = await owner.call(`${base}/test`, { body: {} });
  assert.deepEqual([test.status, test.json.ok, test.json.reason, test.json.teams], [200, false, "no_key", []]);
  assert.match(test.json.message, /Linear API key/);

  const saved = await owner.call(base, { method: "PUT", body: { team } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.linear, { team: { ...team, key: "ENG" }, keySet: false, keySource: null, keyHint: null, configured: false });
  assert.deepEqual(saved.json.github.repo, "acme/web-app", "GitHub and Linear are independent");
});

await step("setup: a visitor reports a failed payment with a debug snapshot", async () => {
  assert.equal((await setAi(false)).status, 200); // the support AI stays out of this conversation
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  visitorToken = token;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body: `I can't pay my invoice, it says something went wrong. My email is pat@customer.test (${run})`, context },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  conversationId = res.json.conversation.id;
  const reply = await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Sorry about that! Which card did you use?" } });
  assert.equal(reply.status, 200);
  await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: crypto.randomUUID(), body: "A Visa card. I clicked Pay on the billing page twice." },
    headers: { "X-Visitor-Token": token },
  });
  await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Looks like the payment provider timed out", internal: true } });
  // An agent noted the (unverified) contact's email: it must not reach the issue either.
  const contactId = res.json.conversation.contact.id;
  assert.equal((await owner.call(`/workspaces/${workspaceId}/contacts/${contactId}`, { method: "PATCH", body: { email: "pat@customer.test" } })).status, 200);
});

const assertDraftShape = (draft: { title: string; body: string }) => {
  assert.ok(draft.title.trim().length > 0 && draft.title.length <= 256, `title: ${draft.title}`);
  const headings = [...draft.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["Summary", "Steps to reproduce", "Expected vs actual", "Failing requests", "Errors", "Environment"]);
  assert.match(draft.body, /_Inferred from the visitor's session/);
  assert.match(draft.body, /\n1\. /, "numbered steps");
  assert.match(draft.body, /\| `POST \/api\/billing\/pay\?email=…` \| 500 \| 412 ms \|/, "the failing request, masked");
  assert.match(draft.body, /`Payment failed for \[email\]: Bearer \[token\]`/);
  assert.match(draft.body, /- Browser: Safari 18\n- OS: macOS\n- Screen: 1280×720\n- Locale: de-DE · Europe\/Berlin/);
  assert.ok(draft.body.endsWith(`From a support conversation in Jun Desk: ${new URL(BASE).origin}/inbox/${conversationId}`), "links back to the conversation");
  for (const leaked of ["pat@customer.test", "abc123", "sk_live_51Hxyz"]) assert.ok(!`${draft.title}\n${draft.body}`.includes(leaked), `leaked ${leaked}`);
  assert.doesNotMatch(`${draft.title}\n${draft.body}`, EMAIL, "no email addresses at all");
};

await step("the AI drafts the issue (real AI (E2E_AI_PROVIDER, default ChatGPT)) from the transcript and the masked browser details", async () => {
  assert.equal((await setAi(true)).status, 200);
  const usageBefore = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.usage;
  const started = Date.now();
  const res = await owner.call(`/conversations/${conversationId}/issue-draft`, { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  console.log(`    ${Date.now() - started} ms, ${res.json.source}: ${res.json.title}`);
  console.log(`    ${res.json.body.split("## Steps")[0].replace(/\s+/g, " ").slice(0, 260)}`);
  assert.equal(res.json.source, "ai", `expected an AI draft, got the template (${res.json.notice})`);
  assert.equal(res.json.notice, null);
  assertDraftShape(res.json as { title: string; body: string });
  assert.match(res.json.body, /billing|pay/i);
  // Nothing invented: no version numbers, card numbers or people that aren't in the facts.
  assert.doesNotMatch(res.json.body.split("## Failing requests")[0], /\bv?\d+\.\d+\.\d+\b|\b(?:\d[ -]?){13,19}\b/);
  // Tokens count toward usage, but a draft isn't a reply.
  await new Promise((r) => setTimeout(r, 500));
  const usageAfter = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.usage;
  assert.ok(usageAfter.inputTokens > usageBefore.inputTokens, "input tokens recorded");
  assert.equal(usageAfter.replies, usageBefore.replies);
});

await step("with AI off the button still works: a template draft from the facts", async () => {
  assert.equal((await setAi(false)).status, 200);
  const res = await teammate.call(`/conversations/${conversationId}/issue-draft`, { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.source, "template");
  assert.match(res.json.notice, /AI is off/);
  assert.match(res.json.title, /^I can't pay my invoice, it says something went wrong\. My email is \[email\]/);
  assertDraftShape(res.json as { title: string; body: string });
  assert.match(res.json.body, /\*\*Expected:\*\* Unknown/);
  assert.match(res.json.body, /\*\*Actual:\*\* `POST \/api\/billing\/pay\?email=…` returned HTTP 500\./);
  assert.match(res.json.body, /1\. Open `\/invoices`\n2\. Open `\/billing`\n3\. The page sends `POST \/api\/billing\/pay\?email=…`, which fails with HTTP 500/);

  assert.equal((await new Client().call(`/conversations/${conversationId}/issue-draft`, { body: {} })).status, 401);
  assert.equal((await owner.call(`/conversations/cv_nope/issue-draft`, { body: {} })).status, 404);
});

// S-14: a 1×1 PNG and JPEG are enough; type and size come from the stored file, not the message.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (ch) => ch.charCodeAt(0));
const imageKeys = { visitor: "", note: "", pdf: "", foreign: "" };

await step("screenshots: the dialog lists the conversation's images (visitor's and a note's), not other files or conversations", async () => {
  const upload = async (who: Client, path: string, name: string, type: string, headers: Record<string, string> = {}) => {
    const res = await who.call(path, { body: PNG, headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(name), ...headers } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.attachment as { key: string; name: string; type: string; size: number };
  };
  const visitor = new Client();
  const shot = await upload(visitor, `/widget/${widgetKey}/files`, "Screenshot 2026-10-05.png", "image/png", { "X-Visitor-Token": visitorToken });
  const pdf = await upload(visitor, `/widget/${widgetKey}/files`, "invoice.pdf", "application/pdf", { "X-Visitor-Token": visitorToken });
  const sent = await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: crypto.randomUUID(), body: "Here's what I see", attachments: [shot, pdf] },
    headers: { "X-Visitor-Token": visitorToken },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const noteShot = await upload(owner, `/workspaces/${workspaceId}/files`, "stripe-dashboard.jpg", "image/jpeg");
  const note = await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Stripe shows a timeout", internal: true, attachments: [noteShot] } });
  assert.equal(note.status, 200, JSON.stringify(note.json));
  // Someone else's conversation, with its own image.
  const other = new Client();
  const otherToken = (await other.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const foreign = await upload(other, `/widget/${widgetKey}/files`, "other.png", "image/png", { "X-Visitor-Token": otherToken });
  const otherConversation = await other.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Unrelated", attachments: [foreign] }, headers: { "X-Visitor-Token": otherToken } });
  assert.equal(otherConversation.status, 200, JSON.stringify(otherConversation.json));
  Object.assign(imageKeys, { visitor: shot.key, note: noteShot.key, pdf: pdf.key, foreign: foreign.key });

  const list = await teammate.call(`/conversations/${conversationId}/issue-images`);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.deepEqual(
    list.json.images.map((i: Record<string, unknown>) => [i.key, i.name, i.type, i.size, i.from, i.internal]),
    [
      [shot.key, "Screenshot 2026-10-05.png", "image/png", PNG.byteLength, "visitor", false],
      [noteShot.key, "stripe-dashboard.jpg", "image/jpeg", PNG.byteLength, "agent", true],
    ],
  );
  assert.equal(list.json.githubPrivate, null, "no GitHub token on the e2e server, so privacy is unknown (images start unticked for GitHub)");
  assert.equal((await new Client().call(`/conversations/${conversationId}/issue-images`)).status, 401);
  assert.equal((await owner.call(`/conversations/cv_nope/issue-images`)).status, 404);
  // GitHub gets links to these URLs: unguessable, served without a session.
  const res = await fetch(`${BASE}/api/files/${shot.key}`);
  assert.deepEqual([res.status, res.headers.get("content-type")], [200, "image/png"]);
});

await step("screenshots: filing accepts only this conversation's images (400 otherwise), checked before the tracker", async () => {
  const path = `/conversations/${conversationId}/issues`;
  const issue = { provider: "github", title: "Pay fails", body: "Steps…" };
  const cases: [unknown, RegExp][] = [
    [[imageKeys.foreign], /isn't attached to this conversation/],
    [["f_doesnotexist"], /isn't attached to this conversation/],
    [[imageKeys.visitor, imageKeys.pdf], /Only images/],
    [imageKeys.visitor, /list of file keys/],
    [[42], /list of file keys/],
    [Array.from({ length: 11 }, (_, i) => `f_${i}`), /At most 10 images/],
  ];
  for (const [images, message] of cases) {
    const res = await owner.call(path, { body: { ...issue, images } });
    assert.equal(res.status, 400, JSON.stringify(images));
    assert.match(res.json.error.message, message);
  }
  // Valid images pass validation and reach the (unconfigured) tracker check.
  for (const provider of ["github", "linear"]) {
    const res = await owner.call(path, { body: { ...issue, provider, images: [imageKeys.visitor, imageKeys.note], clientId: crypto.randomUUID() } });
    assert.deepEqual([res.status, res.json.error.code], [409, `${provider}_not_configured`]);
  }
});

await step("filing validates provider and issue, then says the tracker isn't configured (409) without calling it", async () => {
  const path = `/conversations/${conversationId}/issues`;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ title: "Pay fails", body: "x" }, /provider must be github or linear/],
    [{ provider: "jira", title: "Pay fails", body: "x" }, /provider must be github or linear/],
    [{ provider: "github", title: "  ", body: "x" }, /needs a title/],
    [{ provider: "linear", title: "x".repeat(257), body: "x" }, /256/],
    [{ provider: "linear", title: "Pay fails", body: "y".repeat(60_001) }, /60,000/],
    [{ provider: "github", title: "Pay fails", body: "x", labels: "bug" }, /list/],
    [{ provider: "github", title: "Pay fails", body: "x", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }, /At most 10/],
    [{ provider: "github", title: "Pay fails", body: "x", clientId: "" }, /clientId/],
  ];
  for (const [body, message] of cases) {
    const res = await owner.call(path, { body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.json.error.message, message);
  }
  // Repo and team are set, the secrets aren't.
  const github = await teammate.call(path, { body: { provider: "github", title: "Pay fails", body: "Steps…", labels: ["bug"], clientId: crypto.randomUUID() } });
  assert.deepEqual([github.status, github.json.error.code], [409, "github_not_configured"]);
  assert.match(github.json.error.message, /GitHub token/);
  const linear = await teammate.call(path, { body: { provider: "linear", title: "Pay fails", body: "Steps…", clientId: crypto.randomUUID() } });
  assert.deepEqual([linear.status, linear.json.error.code], [409, "linear_not_configured"]);
  assert.match(linear.json.error.message, /Linear API key/);
  // Without a repo / team the message says that instead.
  assert.equal((await owner.call(`/workspaces/${workspaceId}/github`, { method: "PUT", body: { repo: "" } })).json.github.repo, null);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/linear`, { method: "PUT", body: { team: null } })).json.linear.team, null);
  const noRepo = await owner.call(path, { body: { provider: "github", title: "Pay fails", body: "x" } });
  assert.deepEqual([noRepo.status, noRepo.json.error.code], [409, "github_not_configured"]);
  assert.match(noRepo.json.error.message, /No GitHub repository/);
  const noTeam = await owner.call(path, { body: { provider: "linear", title: "Pay fails", body: "x" } });
  assert.deepEqual([noTeam.status, noTeam.json.error.code], [409, "linear_not_configured"]);
  assert.match(noTeam.json.error.message, /No Linear team/);
  assert.equal((await new Client().call(path, { body: { provider: "github", title: "x" } })).status, 401);

  // Nothing was recorded and nothing reached the timeline.
  const thread = (await owner.call(`/conversations/${conversationId}`)).json;
  assert.deepEqual(thread.issues, []);
  assert.deepEqual((await owner.call(path)).json.issues, []);
  assert.ok(!thread.messages.some((m: { body: string }) => /Issue created/.test(m.body)));
});

await step("cleanup: AI settings restored", async () => {
  const res = await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: aiSettings });
  assert.equal(res.status, 200, JSON.stringify(res.json));
});

summary();
