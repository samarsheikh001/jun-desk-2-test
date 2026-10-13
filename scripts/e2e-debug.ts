// End-to-end test of M4 / P1 "support that sees the bug" against a running dev server:
// the widget's debug snapshot is masked, stored, shown to agents, and used by the AI
// (real AI (E2E_AI_PROVIDER, default ChatGPT)) to explain the failure and flag it to the team. Run after e2e-ai.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 120_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

const now = Date.now();
/** What the loader on a customer's page would send (before its own masking, to prove the server masks too). */
const context = (extra: object[] = []) => ({
  page: { url: "https://app.customer.test/billing?session=abc123", title: "Billing · pat@customer.test" },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  viewport: { w: 1440, h: 900 },
  language: "en-GB",
  timezone: "Europe/London",
  capturedAt: now,
  events: [
    { t: now - 60_000, kind: "navigation", url: "https://app.customer.test/billing" },
    { t: now - 30_000, kind: "network", method: "POST", url: "https://app.customer.test/api/billing?email=pat@customer.test", status: 500, durationMs: 231 },
    { t: now - 29_000, kind: "error", message: "Payment failed for pat@customer.test: Bearer sk_live_51Hxyz", source: "https://app.customer.test/assets/checkout.js:120" },
    ...extra,
  ],
});

await step("owner signs in; AI on", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const res = await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 100 } });
  assert.equal(res.status, 200);
});

let conversationId = "";
let visitorToken = "";

await step("a visitor's message carries a debug snapshot; the server masks it again", async () => {
  const visitor = new Client();
  visitorToken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body: "Why can't I pay my invoice? It just says something went wrong.", context: context() },
    headers: { "X-Visitor-Token": visitorToken },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  conversationId = res.json.conversation.id;

  const data = (await agent.call(`/conversations/${conversationId}/context`)).json;
  assert.equal(data.issueCount, 2);
  assert.equal(data.context.page.url, "https://app.customer.test/billing?session=…");
  assert.equal(data.context.page.title, "Billing · [email]");
  assert.equal(data.context.timezone, "Europe/London");
  const raw = JSON.stringify(data);
  for (const secret of ["pat@customer.test", "abc123", "sk_live_51Hxyz"]) assert.ok(!raw.includes(secret), `leaked ${secret}`);
  const request = data.events.find((e: { kind: string }) => e.kind === "network");
  assert.deepEqual(request, { t: now - 30_000, kind: "network", method: "POST", url: "/api/billing?email=…", status: 500, durationMs: 231 });
});

await step("the inbox list shows the issue count; visitors can't read the debug context", async () => {
  const list = (await agent.call(`/workspaces/${workspaceId}/conversations?status=all`)).json.conversations;
  assert.equal(list.find((c: { id: string }) => c.id === conversationId).debugIssueCount, 2);
  assert.equal((await new Client().call(`/conversations/${conversationId}/context`)).status, 401);
});

await step("the AI explains what failed and hands it to the team with the technical details", async () => {
  // Wait for the AI turn to finish: it hands off, then writes the brief (another model call).
  type Msg = { authorType: string; internal: boolean; body: string };
  type State = { conversation: { handling: string }; messages: Msg[] };
  const load = async () => (await agent.call(`/conversations/${conversationId}`)).json as State;
  const deadline = Date.now() + AI_TIMEOUT;
  let state = await load();
  while (Date.now() < deadline && !state.messages.some((m) => m.internal && /Handed off/.test(m.body))) {
    await new Promise((r) => setTimeout(r, 1500));
    state = await load();
  }
  assert.equal(state.conversation.handling, "human", "expected the AI to flag this to the team");
  const { messages } = state;
  const ai = messages.find((m: { authorType: string }) => m.authorType === "ai");
  const brief = messages.find((m: { internal: boolean; body: string }) => m.internal && /Handed off/.test(m.body));
  if (ai) console.log(`    AI: ${ai.body.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`    brief: ${brief?.body.replace(/\s+/g, " ").slice(0, 240)}`);
  assert.ok(brief, "agents get a handoff brief");
  assert.match(brief.body, /\/api\/billing/, "the brief quotes the failing request");
  if (ai) assert.match(ai.body, /500|server error|api\/billing|payment/i, "the AI's answer refers to the failure");
});

await step("later messages over the socket add new browser events", async () => {
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=999`, { protocols: [visitorToken] });
  await socket.opened;
  socket.send({
    type: "send",
    clientMsgId: "v-ctx-2",
    body: "Now the usage chart is broken too",
    context: context([{ t: now - 5_000, kind: "error", message: "TypeError: Cannot read properties of undefined (reading 'series')", source: "/assets/chart.js:88" }]),
  });
  await socket.next((e) => e.type === "message" && e.message.clientMsgId === "v-ctx-2", 10_000);
  socket.close();
  const data = (await agent.call(`/conversations/${conversationId}/context`)).json;
  assert.equal(data.issueCount, 3);
  assert.match(data.events[0].message, /reading 'series'/);
});

await step("agents see the same context live in the conversation socket backlog's summary", async () => {
  const agentSocket = new TestSocket(`/api/conversations/${conversationId}/ws?since=0`, { headers: { Cookie: cookieHeader(agent) } });
  await agentSocket.opened;
  await agentSocket.next((e) => e.type === "messages");
  agentSocket.close();
  const list = (await agent.call(`/workspaces/${workspaceId}/conversations?status=all`)).json.conversations;
  assert.equal(list.find((c: { id: string }) => c.id === conversationId).debugIssueCount, 3);
});

await step("S-12: an app's reportError event is masked again, shown to agents, never to visitors", async () => {
  const appError = { t: now - 2_000, kind: "app_error", message: "Row 42: missing email for pat@customer.test (token=abc123)", code: "import.row_invalid<script>", stack: "should go", status: 500 };
  const res = await new Client().call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: "v-ctx-3", body: "The contacts import keeps failing", context: context([appError]) },
    headers: { "X-Visitor-Token": visitorToken },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const data = (await agent.call(`/conversations/${conversationId}/context`)).json;
  assert.equal(data.issueCount, 4, "app errors count as issues");
  const event = data.events.find((e: { kind: string }) => e.kind === "app_error");
  assert.deepEqual(event, { t: now - 2_000, kind: "app_error", message: "Row 42: missing email for [email] (token=[redacted])", code: "import.row_invalidscript" });
  const list = (await agent.call(`/workspaces/${workspaceId}/conversations?status=all`)).json.conversations;
  // The list counts the latest snapshot: the failed request, the JS error and the app error.
  assert.equal(list.find((c: { id: string }) => c.id === conversationId).debugIssueCount, 3);
  // What the widget can read: the thread and the list, without the timeline or the count.
  const headers = { "X-Visitor-Token": visitorToken };
  const visible = JSON.stringify([
    (await new Client().call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers })).json,
    (await new Client().call(`/widget/${widgetKey}/conversations`, { headers })).json,
  ]);
  assert.ok(visible.includes("contacts import keeps failing"), "the visitor sees their own message");
  for (const hidden of ["Row 42", "row_invalid", "app_error"]) assert.ok(!visible.includes(hidden), `visitor sees ${hidden}`);
  assert.ok(!/"debugIssueCount":[1-9]/.test(visible), "visitors don't get the issue count");
});

await step("S-02 / S-13: rage clicks and stuck pages are masked again, shown to agents, never to visitors", async () => {
  const rage = {
    t: now - 1_500,
    kind: "rage_click",
    count: 4,
    target: { tag: "BUTTON", id: "export-pat@customer.test", label: "Export", role: "button", text: "Export CSV", value: "hunter2", html: "<b>secret</b>" },
    message: "should go",
  };
  const stuck = { t: now - 1_000, kind: "stuck", url: "/import/pat@customer.test?file=abc123", seconds: 181, issue: "rage_click", target: { tag: "a" }, message: "should go" };
  const res = await new Client().call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: "v-ctx-4", body: "The export button does nothing", context: context([rage, stuck]) },
    headers: { "X-Visitor-Token": visitorToken },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const data = (await agent.call(`/conversations/${conversationId}/context`)).json;
  const events = data.events as { kind: string }[];
  assert.deepEqual(events.find((e) => e.kind === "rage_click"), { t: now - 1_500, kind: "rage_click", target: { tag: "button", id: "[email]", label: "Export", role: "button", text: "Export CSV" }, count: 4 });
  assert.deepEqual(events.find((e) => e.kind === "stuck"), { t: now - 1_000, kind: "stuck", url: "/import/[email]", seconds: 181, issue: "rage_click" });
  const raw = JSON.stringify(data);
  for (const secret of ["pat@customer.test", "hunter2", "abc123", "should go", "<b>"]) assert.ok(!raw.includes(secret), `leaked ${secret}`);
  // The rage click counts as an issue; being stuck doesn't (it follows one): 4 before, plus the rage click.
  assert.equal(data.issueCount, 5);
  const headers = { "X-Visitor-Token": visitorToken };
  const visible = JSON.stringify([
    (await new Client().call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers })).json,
    (await new Client().call(`/widget/${widgetKey}/conversations`, { headers })).json,
  ]);
  assert.ok(visible.includes("export button does nothing"));
  for (const hidden of ["rage_click", "stuck", "Export CSV", "seconds"]) assert.ok(!visible.includes(hidden), `visitor sees ${hidden}`);
});

/** The loader's nudge request, from a customer's site. */
const nudge = async (body: string) => {
  const res = await fetch(`${BASE}/api/widget/${widgetKey}/nudge`, { method: "POST", headers: { Origin: "https://customer.example", "Content-Type": "text/plain;charset=UTF-8" }, body });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  return (await res.json()) as { show: boolean; text?: string };
};

await step("S-11: the nudge is worded by the AI from the failure, cross-origin, with nothing technical", async () => {
  const pay = await nudge(JSON.stringify({ event: { t: 1, kind: "network", method: "POST", url: "/api/billing/pay", status: 500 }, page: { url: "https://app.customer.test/billing", title: "Billing" } }));
  assert.equal(pay.show, true);
  assert.match(pay.text!, /Want a hand\?$/);
  assert.match(pay.text!, /pay|invoice|billing/i, pay.text);
  assert.doesNotMatch(pay.text!, /\/api|500|error/i);
  const chart = await nudge(JSON.stringify({ event: { t: 1, kind: "error", message: "TypeError: Cannot read properties of undefined (reading 'series')", source: "/assets/usage-chart.js:41" }, page: { url: "https://app.customer.test/usage", title: "Usage" } }));
  assert.match(chart.text!, /chart|usage/i, chart.text);
  assert.doesNotMatch(chart.text!, /pay/i, "no more keyword guesses");
  assert.deepEqual(await nudge("not json"), { show: false });
});

await step("S-12: a nudge from the app's own error says what failed, without the code or tech words", async () => {
  const res = await nudge(
    JSON.stringify({
      event: { t: 1, kind: "app_error", message: "Row 42: missing email for pat@customer.test", code: "import.row_invalid" },
      page: { url: "https://app.customer.test/contacts/import", title: "Import contacts" },
    }),
  );
  console.log(`    nudge: ${res.text}`);
  assert.equal(res.show, true);
  assert.match(res.text!, /Want a hand\?$/);
  assert.match(res.text!, /42|email|import/i, res.text);
  assert.doesNotMatch(res.text!, /row_invalid|pat@|\[email\]|error|code|\/api|https?:/i, res.text);
  assert.doesNotMatch(res.text!, /^Looks like something went wrong/, "the AI wrote it, not the generic line");
});

const TECH = /\/api|https?:|\b[1-5]\d\d\b|error|status|rage|click count|stuck_|button#|\[email\]|pat@/i;

await step("S-02: a rage-click nudge says the button isn't responding, nothing technical", async () => {
  const res = await nudge(
    JSON.stringify({
      event: { t: 1, kind: "rage_click", count: 4, target: { tag: "button", id: "export-pat@customer.test", text: "Export CSV" } },
      page: { url: "https://app.customer.test/reports", title: "Reports" },
    }),
  );
  console.log(`    nudge: ${res.text}`);
  assert.equal(res.show, true);
  assert.match(res.text!, /Want a hand\?$/);
  assert.match(res.text!, /export|button|respond|working|nothing/i, res.text);
  assert.doesNotMatch(res.text!, TECH, res.text);
  assert.doesNotMatch(res.text!, /^Looks like something went wrong/, "the AI wrote it, not the generic line");
});

await step("S-13: a stuck nudge asks if they're still working on it, nothing technical", async () => {
  const res = await nudge(
    JSON.stringify({
      event: { t: 1, kind: "stuck", url: "/settings/billing", seconds: 190, issue: "network" },
      page: { url: "https://app.customer.test/settings/billing", title: "Billing settings" },
    }),
  );
  console.log(`    nudge: ${res.text}`);
  assert.equal(res.show, true);
  assert.match(res.text!, /Want a hand\?$/);
  assert.doesNotMatch(res.text!, TECH, res.text);
  assert.doesNotMatch(res.text!, /^Looks like something went wrong/, "the AI wrote it, not the generic line");
});

summary();
