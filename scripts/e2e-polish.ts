// End-to-end test of M7's launch-critical items: knowledge source management (K-04), business
// hours and the away reply (I-10), widget branding (W-04) and the contact sidebar API (I-08).
// Run after e2e-ai (uses its knowledge sources) and e2e-visitors (identity secret).

import assert from "node:assert/strict";
import { signIdentityToken } from "../worker/lib/identity.ts";
import { AI_PROVIDER, BASE, Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const agent = new Client();
let workspaceId = "";
let widgetKey = "";
const kb = () => `/workspaces/${workspaceId}/knowledge`;

await step("owner signs in", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
});

await step("K-04: a snippet can be edited and is re-indexed right away", async () => {
  const created = await agent.call(`${kb()}/snippets`, { body: { title: "Office pets", body: "We have a cat called Biscuit." } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.id;
  const detail = (await agent.call(`${kb()}/${id}`)).json;
  assert.equal(detail.source.body, "We have a cat called Biscuit.");
  const patched = await agent.call(`${kb()}/${id}`, { method: "PATCH", body: { title: "Office pets", body: "Our office dog is called Pretzel and loves visitors." } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const hits = (await agent.call(`${kb()}/search`, { body: { query: "what is the office dog called" } })).json.hits;
  assert.ok(hits.some((h: { text: string }) => /Pretzel/.test(h.text)), JSON.stringify(hits.map((h: { text: string }) => h.text)));
  assert.ok(!hits.some((h: { text: string }) => /Biscuit/.test(h.text)), "old text is gone");
  await agent.call(`${kb()}/${id}`, { method: "DELETE" });
});

await step("K-04: a website source lists its pages and indexed text; a page can be removed and stays out", async () => {
  const sources = (await agent.call(kb())).json.sources as { id: string; kind: string; pageCount: number }[];
  const site = sources.find((s) => s.kind === "website" && s.pageCount > 0);
  assert.ok(site, "e2e-ai should have crawled a website");
  const detail = (await agent.call(`${kb()}/${site.id}`)).json;
  assert.ok(detail.documents.length >= 1);
  const doc = detail.documents[0];
  assert.ok(doc.chunkCount >= 1);
  const chunks = (await agent.call(`${kb()}/${site.id}/documents/${doc.id}`)).json.chunks;
  assert.ok(chunks.length === doc.chunkCount && chunks[0].text.length > 0);

  assert.equal((await agent.call(`${kb()}/${site.id}`, { method: "PATCH", body: { exclude: "blog" } })).status, 400, "paths must start with /");
  assert.equal((await agent.call(`${kb()}/${site.id}`, { method: "PATCH", body: { maxPages: 0 } })).status, 400);
  assert.equal((await agent.call(`${kb()}/${site.id}`, { method: "PATCH", body: { maxPages: 50, exclude: "/blog/\n/changelog*" } })).status, 200);

  assert.equal((await agent.call(`${kb()}/${site.id}/documents/${doc.id}`, { method: "DELETE" })).status, 200);
  const after = (await agent.call(`${kb()}/${site.id}`)).json;
  assert.ok(!after.documents.some((d: { id: string }) => d.id === doc.id));
  assert.deepEqual(after.source.exclude, ["/blog/", "/changelog*", doc.url]);
  assert.equal(after.source.maxPages, 50);
  // Re-sync: the removed page doesn't come back.
  await agent.call(`${kb()}/${site.id}/sync`, { body: {} });
  const deadline = Date.now() + 60_000;
  let status = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    status = ((await agent.call(kb())).json.sources as { id: string; status: string }[]).find((s) => s.id === site.id)!.status;
    if (status === "ready" || status === "error") break;
  }
  const resynced = (await agent.call(`${kb()}/${site.id}`)).json;
  assert.ok(!resynced.documents.some((d: { url: string }) => d.url === doc.url), "excluded page stays out after a sync");
  // Put it back for the other suites.
  await agent.call(`${kb()}/${site.id}`, { method: "PATCH", body: { exclude: "" } });
  await agent.call(`${kb()}/${site.id}/sync`, { body: {} });
});

await step("W-04: appearance is validated, served cross-origin to the loader, and the logo is safe", async () => {
  const inbox = `/workspaces/${workspaceId}/inbox`;
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { color: "blue" } })).status, 400);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { position: "top" } })).status, 400);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { radius: 40 } })).status, 400);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { theme: "neon" } })).status, 400);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { suggestions: ["1", "2", "3", "4", "5"] } })).status, 400);
  const ok = await agent.call(inbox, {
    method: "PATCH",
    body: { color: "#FF6600", position: "left", greeting: "Hey there 👋", replyTime: "Replies in under an hour", displayName: "Acme Help", theme: "dark", radius: 6, launcher: "card", placeholder: "Ask us anything", suggestions: ["How much is it?", " "] },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const config = await fetch(`${BASE}/api/widget/${widgetKey}/config`, { headers: { Origin: "https://customer.example" } });
  assert.equal(config.headers.get("access-control-allow-origin"), "*");
  const c = (await config.json()) as Record<string, unknown>;
  assert.equal(c.color, "#ff6600");
  assert.equal(c.position, "left");
  assert.equal(c.greeting, "Hey there 👋");
  assert.equal(c.replyTime, "Replies in under an hour");
  assert.equal(c.workspaceName, "Acme Help");
  assert.equal(c.logoUrl, null);
  assert.equal(c.theme, "dark");
  assert.equal(c.radius, 6);
  assert.equal(c.launcher, "card");
  assert.equal(c.placeholder, "Ask us anything");
  assert.deepEqual(c.suggestions, ["How much is it?"]);
  // The loader's text colour on the button comes from the desk, for a data-color override too.
  assert.equal(c.text, "#ffffff");
  const light = (await (await fetch(`${BASE}/api/widget/${widgetKey}/config?color=%23ffe066`)).json()) as Record<string, unknown>;
  assert.equal(light.text, "#1c1c1a");
  assert.equal(light.color, "#ff6600", "the override changes only the text colour it's paired with");
  // D-32: the "Ask anything…" bar launcher.
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { launcher: "bar" } })).status, 200);
  assert.equal(((await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as Record<string, unknown>).launcher, "bar");
  // D-39: the morphing island.
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { launcher: "island" } })).status, 200);
  const islandCfg = (await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as Record<string, unknown>;
  assert.equal(islandCfg.launcher, "island");
  assert.equal(islandCfg.neon, true, "the neon border is on unless turned off");
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { neon: false } })).status, 200);
  assert.equal(((await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as Record<string, unknown>).neon, false);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { neon: "yes" } })).status, 400);
  // W-20: the reply sound, on unless turned off.
  assert.equal(islandCfg.sound, true, "the reply sound is on unless turned off");
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { sound: false } })).status, 200);
  assert.equal(((await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as Record<string, unknown>).sound, false);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { sound: "on" } })).status, 400);
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { launcher: "banner" } })).status, 400);

  // A 1×1 PNG.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
  const svg = await agent.call(`${inbox}/logo`, { body: new TextEncoder().encode("<svg onload=alert(1)>"), headers: { "Content-Type": "image/svg+xml", "X-Jun-Upload": "1" } });
  assert.equal(svg.status, 400, "SVG logos are refused");
  const up = await agent.call(`${inbox}/logo`, { body: png, headers: { "Content-Type": "image/png", "X-Jun-Upload": "1" } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const logoUrl = ((await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as { logoUrl: string }).logoUrl;
  const logo = await fetch(`${BASE}${logoUrl}`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.equal(logo.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await logo.arrayBuffer()).byteLength, png.byteLength);
  assert.equal((await agent.call(`${inbox}/logo`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${BASE}${logoUrl}`)).status, 404);
  // W-21: the optional logo for dark surfaces, beside the main one.
  assert.equal((await agent.call(`${inbox}/logo-dark`, { body: new TextEncoder().encode("<svg/>"), headers: { "Content-Type": "image/svg+xml", "X-Jun-Upload": "1" } })).status, 400, "SVG refused here too");
  assert.equal((await agent.call(`${inbox}/logo-dark`, { body: new Uint8Array(512 * 1024 + 1), headers: { "Content-Type": "image/png", "X-Jun-Upload": "1" } })).status, 400, "over 512 KB refused");
  assert.equal((await agent.call(`${inbox}/logo`, { body: png, headers: { "Content-Type": "image/png", "X-Jun-Upload": "1" } })).status, 200);
  const upDark = await agent.call(`${inbox}/logo-dark`, { body: png, headers: { "Content-Type": "image/webp", "X-Jun-Upload": "1" } });
  assert.equal(upDark.status, 200, JSON.stringify(upDark.json));
  const both = (await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as { logoUrl: string | null; logoDarkUrl: string | null };
  assert.ok(both.logoDarkUrl?.startsWith(`/api/widget/${widgetKey}/logo-dark?v=`), both.logoDarkUrl ?? "no logoDarkUrl");
  assert.ok(both.logoUrl && both.logoUrl !== both.logoDarkUrl);
  const darkLogo = await fetch(`${BASE}${both.logoDarkUrl}`);
  assert.equal(darkLogo.status, 200);
  assert.equal(darkLogo.headers.get("content-type"), "image/webp");
  assert.equal(darkLogo.headers.get("x-content-type-options"), "nosniff");
  assert.equal(darkLogo.headers.get("access-control-allow-origin"), "*");
  assert.equal((await darkLogo.arrayBuffer()).byteLength, png.byteLength);
  // Removing the dark one leaves the main logo alone, and the other way round.
  assert.equal((await agent.call(`${inbox}/logo-dark`, { method: "DELETE" })).status, 200);
  const afterDark = (await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as { logoUrl: string | null; logoDarkUrl: string | null };
  assert.equal(afterDark.logoDarkUrl, null);
  assert.equal(afterDark.logoUrl, both.logoUrl);
  assert.equal((await fetch(`${BASE}${both.logoDarkUrl}`)).status, 404);
  assert.equal((await fetch(`${BASE}${both.logoUrl}`)).status, 200);
  assert.equal((await agent.call(`${inbox}/logo`, { method: "DELETE" })).status, 200);
  // Back to defaults for the other suites.
  await agent.call(inbox, { method: "PATCH", body: { color: "#2f5bea", position: "right", greeting: "", replyTime: "", displayName: "", theme: "auto", radius: 16, launcher: "card", neon: true, sound: true, placeholder: "", suggestions: [] } });
});

await step("I-10: outside business hours a chat with the team gets one away reply; the widget says when you're back", async () => {
  const inbox = `/workspaces/${workspaceId}/inbox`;
  assert.equal((await agent.call(inbox, { method: "PATCH", body: { hours: { enabled: true, timezone: "Mars/Base", days: [] } } })).status, 400);
  // Open only on a day that isn't today (UTC), so it's closed now.
  const openDay = (new Date().getUTCDay() + 3) % 7;
  const set = await agent.call(inbox, { method: "PATCH", body: { hours: { enabled: true, timezone: "UTC", days: [{ day: openDay, start: "09:00", end: "17:00" }], awayMessage: "" } } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const config = (await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as { hours: { open: boolean; back: string } };
  assert.equal(config.hours.open, false);
  assert.match(config.hours.back, /at 09:00 \(UTC time\)$/);

  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: AI_PROVIDER, monthlyReplyCap: 1000 } });
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const started = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Hello? Anyone there?" }, headers: { "X-Visitor-Token": token } });
  const id = started.json.conversation.id;
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${id}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const away = await socket.next((e) => (e.type === "message" && e.message.meta?.away) || (e.type === "messages" && e.messages.some((m: { meta: { away?: boolean } }) => m.meta?.away)), 20_000);
  const message = away.type === "message" ? away.message : away.messages.find((m: { meta: { away?: boolean } }) => m.meta?.away);
  assert.match(message.body, /^Thanks for your message! Our team is away right now and will reply here on \w+ at 09:00 \(UTC time\)\.$/);
  socket.send({ type: "send", clientMsgId: crypto.randomUUID(), body: "Still there?" });
  await new Promise((r) => setTimeout(r, 2500));
  const messages = (await agent.call(`/conversations/${id}`)).json.messages as { meta: { away?: boolean } }[];
  assert.equal(messages.filter((m) => m.meta?.away).length, 1, "one away reply per closed period");
  socket.close();
  await agent.call(inbox, { method: "PATCH", body: { hours: { enabled: false, timezone: "UTC", days: [] } } });
  assert.equal(((await (await fetch(`${BASE}/api/widget/${widgetKey}/config`)).json()) as { hours: unknown }).hours, null);
});

await step("I-08: the sidebar lists a contact's other conversations; agents can name anonymous visitors only", async () => {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const start = async (body: string) =>
    (await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body }, headers: { "X-Visitor-Token": token } })).json.conversation;
  const first = await start("First question");
  const second = await start("Second question");
  const contactId = first.contact.id;
  const history = (await agent.call(`/workspaces/${workspaceId}/contacts/${contactId}/conversations`)).json.conversations as { id: string }[];
  assert.deepEqual(new Set(history.map((h) => h.id)), new Set([first.id, second.id]));

  assert.equal((await agent.call(`/workspaces/${workspaceId}/contacts/${contactId}`, { method: "PATCH", body: { email: "nope" } })).status, 400);
  const named = await agent.call(`/workspaces/${workspaceId}/contacts/${contactId}`, { method: "PATCH", body: { name: "Sam Rivera", email: "sam@rivera.test" } });
  assert.equal(named.status, 200, JSON.stringify(named.json));
  const summary = (await agent.call(`/conversations/${second.id}`)).json.conversation;
  assert.equal(summary.contact.name, "Sam Rivera");
  assert.equal(summary.contact.email, "sam@rivera.test");

  // A verified contact's details belong to the customer's app.
  let secret = (await agent.call(`/workspaces/${workspaceId}/identity`)).json.secret as string | null;
  secret ??= (await agent.call(`/workspaces/${workspaceId}/identity`, { body: {} })).json.secret as string;
  const jwt = await signIdentityToken({ sub: `polish-${crypto.randomUUID().slice(0, 8)}`, name: "Verified Vic", exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  const identified = await new Client().call(`/widget/${widgetKey}/identify`, { body: { userToken: jwt } });
  assert.equal((await agent.call(`/workspaces/${workspaceId}/contacts/${identified.json.contactId}`, { method: "PATCH", body: { name: "Renamed" } })).status, 409);
});

summary();
