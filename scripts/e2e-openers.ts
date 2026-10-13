// End-to-end test of P-01 page openers: admins alone save the rules (validated), the widget
// config gives the loader only regex + delay + id, the nudge route sends the fixed text or an
// AI-written line (nothing technical) for a matching page, nothing for other pages or unknown
// rules, and the proactive toggle turns it all off. Uses the real AI (E2E_AI_PROVIDER): one or two model calls.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
let workspaceId = "";
let widgetKey = "";
let aiSettings: Record<string, unknown> = {};
const inbox = () => `/workspaces/${workspaceId}/inbox`;
const patch = (client: Client, body: Record<string, unknown>) => client.call(inbox(), { method: "PATCH", body });
const config = async () => {
  const res = await fetch(`${BASE}/api/widget/${widgetKey}/config`, { headers: { Origin: "https://customer.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  return (await res.json()) as { openers: { id: string; match: string; delay: number }[] } & Record<string, unknown>;
};
/** The loader's request when an opener's delay is up, from a customer's site. */
const open = async (id: string, url: string, title = "Pricing") => {
  const res = await fetch(`${BASE}/api/widget/${widgetKey}/nudge`, {
    method: "POST",
    headers: { Origin: "https://customer.example", "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ event: { kind: "opener", id }, page: { url, title } }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { show: boolean; text?: string; page?: boolean };
};

let fixedId = "";
let aiId = "";

await step("owner and an agent sign in; proactive help on, any website", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(inbox())).json.inbox.widgetKey;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Opal ${run}`, email: `opal-${run}@acme.test` })).status, 200);
  assert.equal((await patch(owner, { proactive: true, allowedDomains: "", openers: [] })).status, 200);
});

await step("only owners and admins save openers; bad rules are rejected with a reason", async () => {
  const rule = { path: "/pricing", delay: 20, text: "Comparing plans? Happy to help you pick one." };
  const agent = await patch(teammate, { openers: [rule] });
  assert.equal(agent.status, 403);
  assert.equal((await new Client().call(inbox(), { method: "PATCH", body: { openers: [rule] } })).status, 401);

  const bad = async (openers: unknown, message: RegExp) => {
    const res = await patch(owner, { openers });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.error.code, "invalid_field");
    assert.match(res.json.error.message, message);
  };
  await bad("nope", /must be a list/);
  await bad([{ path: "pricing", delay: 20, text: "Hi" }], /Opener 1: .*must start with/);
  await bad([{ path: "/pricing?x=1", delay: 20, text: "Hi" }], /\?/);
  await bad([{ path: "/pricing", delay: 4, text: "Hi" }], /from 5 to 600/);
  await bad([{ path: "/pricing", delay: 601, text: "Hi" }], /from 5 to 600/);
  await bad([{ path: "/pricing", delay: 20, text: "x".repeat(141) }], /at most 140/);
  await bad([{ path: "/pricing", delay: 20, text: "  " }], /write a message/);
  await bad([{ path: "/docs/*", delay: 20, text: null, hint: "x".repeat(201) }], /at most 200/);
  await bad(Array.from({ length: 11 }, () => rule), /At most 10/);
  assert.deepEqual((await owner.call(inbox())).json.inbox.settings.openers, [], "nothing saved by a rejected request");
});

await step("owner saves a fixed-text and an AI opener; ids are assigned and kept on re-save", async () => {
  const res = await patch(owner, {
    openers: [
      { path: "/pricing", delay: 20, text: "  Comparing plans?  Happy to help you pick one. " },
      { path: "/docs/*", delay: 45, text: null, hint: "help finding the right setup guide" },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const saved = res.json.settings.openers;
  assert.equal(saved.length, 2);
  assert.match(saved[0].id, /^op_/);
  assert.equal(saved[0].text, "Comparing plans? Happy to help you pick one.");
  assert.equal(saved[1].text, null);
  assert.equal(saved[1].hint, "help finding the right setup guide");
  [fixedId, aiId] = [saved[0].id, saved[1].id];
  const again = await patch(owner, { openers: saved });
  assert.deepEqual(again.json.settings.openers.map((r: { id: string }) => r.id), [fixedId, aiId]);
  // Agents can read the inbox settings (as before) but not change them.
  assert.equal((await teammate.call(inbox())).json.inbox.settings.openers.length, 2);
});

await step("widget config gives the loader regex, delay and id only (no text, no hint)", async () => {
  const cfg = await config();
  assert.deepEqual(cfg.openers, [
    { id: fixedId, match: "^/pricing/?$", delay: 20 },
    { id: aiId, match: "^/docs(/.*)?$", delay: 45 },
  ]);
  const raw = JSON.stringify(cfg);
  assert.doesNotMatch(raw, /Comparing plans|setup guide|hint/);
  assert.ok(new RegExp(cfg.openers[1]!.match).test("/docs/install/cloudflare"));
});

await step("fixed text passes through for a matching page; other pages and unknown rules show nothing", async () => {
  assert.deepEqual(await open(fixedId, "https://app.customer.test/pricing"), { show: true, text: "Comparing plans? Happy to help you pick one.", page: true });
  assert.deepEqual(await open(fixedId, "https://app.customer.test/pricing/?plan=…"), { show: true, text: "Comparing plans? Happy to help you pick one.", page: true });
  assert.deepEqual(await open(fixedId, "https://app.customer.test/billing"), { show: false });
  assert.deepEqual(await open("op_unknown123", "https://app.customer.test/pricing"), { show: false });
  assert.deepEqual(await open(fixedId, "not a url"), { show: false });
});

await step("AI opener: one friendly line from the page and hint, nothing technical", async () => {
  const set = await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled: true, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const res = await open(aiId, `https://app.customer.test/docs/install-${run}`, "Install on Cloudflare – Docs");
  console.log(`    opener: ${res.text}`);
  assert.equal(res.show, true);
  assert.equal(res.page, true);
  assert.ok(res.text && res.text.length <= 140, res.text);
  assert.doesNotMatch(res.text!, /https?:|\/docs|\b(error|problem|wrong|fail\w*|api|http|status|404|500)\b/i);
  assert.doesNotMatch(res.text!, /\n/);
});

await step("AI off: the AI opener falls back to a generic offer", async () => {
  assert.equal((await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled: false, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } })).status, 200);
  const res = await open(aiId, `https://app.customer.test/docs/other-${run}`, "Docs");
  assert.deepEqual(res, { show: true, text: "Have a question? We're happy to help.", page: true });
});

await step("allowed websites: openers don't run on other sites", async () => {
  assert.equal((await patch(owner, { allowedDomains: "acme.com" })).status, 200);
  assert.deepEqual(await open(fixedId, "https://app.customer.test/pricing"), { show: false });
  assert.equal((await patch(owner, { allowedDomains: "" })).status, 200);
});

await step("proactive help off: no rules served and the route shows nothing; on again restores them", async () => {
  assert.equal((await patch(owner, { proactive: false })).status, 200);
  assert.deepEqual((await config()).openers, []);
  assert.deepEqual(await open(fixedId, "https://app.customer.test/pricing"), { show: false });
  assert.equal((await patch(owner, { proactive: true })).status, 200);
  assert.equal((await config()).openers.length, 2);
});

await step("clean up: no openers left for the other suites", async () => {
  assert.deepEqual((await patch(owner, { openers: [] })).json.settings.openers, []);
  assert.deepEqual((await config()).openers, []);
});

summary();
