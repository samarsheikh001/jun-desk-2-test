// End-to-end test of the M2 AI agent against a running dev server, using real AI (E2E_AI_PROVIDER, default ChatGPT)
// models (embeddings, reranker, chat). Run after e2e-auth and e2e-chat.
//
// Model answers vary, so assertions check behaviour (cites the right source, hands off,
// never goes silent) rather than exact wording.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";
import { JOB_DEFAULTS } from "../worker/ai/models.ts";

const AI_TIMEOUT = 120_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

await step("owner signs in and turns on the AI (ChatGPT login, or E2E_AI_PROVIDER)", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const res = await agent.call(`/workspaces/${workspaceId}/ai`, {
    method: "PUT",
    body: { enabled: true, provider: AI_PROVIDER, instructions: "Be brief.", monthlyReplyCap: 100 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.settings.enabled, true);
});

await step("a snippet is chunked, embedded and searchable", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/knowledge/snippets`, {
    body: {
      title: "Refund policy",
      body: "# Refunds\n\nCustomers can get a full refund within 14 days of purchase by emailing billing@acme.test.\n\nAfter 14 days we offer account credit instead of a refund.",
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const hits = (await agent.call(`/workspaces/${workspaceId}/knowledge/search`, { body: { query: "how many days do I have to get my money back" } })).json.hits;
  assert.ok(hits.length > 0, "no search hits");
  assert.equal(hits[0].title, "Refund policy");
});

// A public page: workerd in local dev can't fetch its own dev server.
const CRAWL_URL = process.env.CRAWL_URL ?? "https://example.com/";

await step("a website source is crawled and indexed", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/knowledge/websites`, { body: { url: CRAWL_URL, maxPages: 5 } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const deadline = Date.now() + 60_000;
  let source: { status: string; pageCount: number; chunkCount: number; error: string | null } | undefined;
  while (Date.now() < deadline) {
    source = (await agent.call(`/workspaces/${workspaceId}/knowledge`)).json.sources.find((s: { id: string }) => s.id === res.json.id);
    if (source?.status === "ready" || source?.status === "error") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(source?.status, "ready", JSON.stringify(source));
  assert.equal(source?.pageCount, 1);
  assert.ok((source?.chunkCount ?? 0) > 0);
  const hits = (await agent.call(`/workspaces/${workspaceId}/knowledge/search`, { body: { query: "what is this domain for" } })).json.hits;
  assert.ok(hits.some((h: { url: string | null }) => h.url === CRAWL_URL), JSON.stringify(hits.map((h: { title: string }) => h.title)));
});

/** Starts a widget conversation and returns the visitor's socket to it. */
async function startChat(question: string) {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: question }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const conversationId = res.json.conversation.id as string;
  assert.equal(res.json.conversation.handling, "ai");
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  return { conversationId, socket, visitor, token };
}

/**
 * Next message matching `match`, whether it arrives live ("message") or in the catch-up
 * backlog sent on connect ("messages"), since fast AI turns can finish before we connect.
 */
async function nextMessage(socket: TestSocket, match: (m: any) => boolean, timeoutMs = AI_TIMEOUT): Promise<any> {
  const event = await socket.next((e) => (e.type === "message" && match(e.message)) || (e.type === "messages" && e.messages.some(match)), timeoutMs);
  return event.type === "message" ? event.message : event.messages.find(match);
}

const handling = async (conversationId: string) => (await agent.call(`/conversations/${conversationId}`)).json.conversation.handling as string;

await step("the AI answers from knowledge, streams, and cites the source", async () => {
  const { socket } = await startChat("How many days do I have to ask for a refund?");
  const answer = await nextMessage(socket, (m) => m.authorType === "ai", AI_TIMEOUT);
  const streamed = socket.events.filter((e) => e.type === "ai_delta").length;
  // (If the reply finished before we connected, it arrives in the backlog instead of streaming.)
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 160)}`);
  assert.match(answer.body, /14/);
  assert.ok(answer.meta.sources?.some((s: { title: string }) => s.title.startsWith("Refund policy")), JSON.stringify(answer.meta));
  assert.ok(streamed > 0 || socket.events.length === 0, "expected streamed ai_delta events");
  socket.close();
});

await step("a plain request for a person hands off instantly, with a brief for agents", async () => {
  const { conversationId, socket } = await startChat("Can I talk to a human please?");
  const notice = await nextMessage(socket, (m) => m.authorType === "system", AI_TIMEOUT);
  assert.match(notice.body, /teammate/i);
  assert.equal(await handling(conversationId), "human");
  const { messages } = (await agent.call(`/conversations/${conversationId}`)).json;
  assert.ok(messages.some((m: { internal: boolean; body: string }) => m.internal && /Handed off/.test(m.body)), "agents get an internal handoff note");
  // Visitors never see internal notes, live or in the backlog.
  await socket.none((e) => (e.type === "message" && e.message.internal) || (e.type === "messages" && e.messages.some((m: { internal: boolean }) => m.internal)), 300);
  socket.close();
});

await step("something only staff can do is handed off rather than guessed", async () => {
  const { conversationId, socket } = await startChat("Please change the email on my account to bob@example.com.");
  const reply = await nextMessage(socket, (m) => (m.authorType === "system" || m.authorType === "ai"), AI_TIMEOUT);
  console.log(`    ${reply.authorType}: ${reply.body.replace(/\s+/g, " ").slice(0, 160)}`);
  assert.equal(reply.authorType, "system", "expected a handoff, not an AI answer");
  assert.equal(await handling(conversationId), "human");
  socket.close();
});

await step('"Talk to a person" in the widget hands off', async () => {
  const { conversationId, socket } = await startChat("What is your refund window?");
  await nextMessage(socket, (m) => m.authorType === "ai", AI_TIMEOUT);
  socket.send({ type: "handoff" });
  await nextMessage(socket, (m) => m.authorType === "system", 10_000);
  assert.equal(await handling(conversationId), "human");
  socket.close();
});

await step("an agent replying takes over from the AI", async () => {
  const { conversationId, socket } = await startChat("Do you offer account credit?");
  await nextMessage(socket, (m) => m.authorType === "ai", AI_TIMEOUT);
  const agentSocket = new TestSocket(`/api/conversations/${conversationId}/ws?since=0`, { headers: { Cookie: cookieHeader(agent) } });
  await agentSocket.opened;
  agentSocket.send({ type: "send", clientMsgId: "takeover-1", body: "Hi, I'm a person. Let me check." });
  await nextMessage(socket, (m) => m.clientMsgId === "takeover-1", 10_000);
  assert.equal(await handling(conversationId), "human");
  const note = await agentSocket.next((e) => e.type === "message" && e.message.internal && /took over/.test(e.message.body), 10_000);
  assert.ok(note);
  agentSocket.close();
  socket.close();
});

// ---------- AI-16: a model per AI job ----------

const aiSettings = async () => (await agent.call(`/workspaces/${workspaceId}/ai`)).json;
const putAi = (body: Record<string, unknown>) => agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 100, ...body } });
const GENERIC_NUDGE = "Looks like something went wrong on this page. Want a hand?";
/** The loader's nudge request; a fresh page each time, since lines are cached per failure and page. */
async function nudgeLine(): Promise<string> {
  const page = `https://app.customer.test/billing/${crypto.randomUUID().slice(0, 8)}`;
  const res = await fetch(`${BASE}/api/widget/${widgetKey}/nudge`, {
    method: "POST",
    headers: { Origin: "https://customer.example", "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ event: { t: 1, kind: "network", method: "POST", url: "/api/billing/pay", status: 500 }, page: { url: page, title: "Billing" } }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { show: boolean; text?: string };
  assert.equal(json.show, true);
  return json.text!;
}
let workspaceModel = "";

await step("AI-16: per-job models are validated and reported with the model each job runs on", async () => {
  const before = await aiSettings();
  workspaceModel = before.effectiveModels.answer;
  assert.deepEqual(before.settings.models, {});
  // Every job runs on the workspace model, except a job with its own default for the provider
  // (JOB_DEFAULTS: the Agent page's `editor` on ChatGPT/OpenAI).
  const defaults = JOB_DEFAULTS[before.settings.provider as keyof typeof JOB_DEFAULTS] ?? {};
  for (const [job, model] of Object.entries(before.effectiveModels)) {
    assert.equal(model, defaults[job as keyof typeof defaults] ?? workspaceModel, `${job}: ${JSON.stringify(before.effectiveModels)}`);
  }
  for (const models of [{ triage: "x" }, { nudge: "has spaces" }, { nudge: "x".repeat(101) }, { nudge: 5 }, ["nudge"]]) {
    const res = await putAi({ models });
    assert.equal(res.status, 400, JSON.stringify(models));
    assert.equal(res.json.error.code, "invalid_field");
  }
  assert.equal((await putAi({ models: { nudge: workspaceModel, brief: "" } })).status, 200);
  const after = await aiSettings();
  assert.deepEqual(after.settings.models, { nudge: workspaceModel });
  // Not sent: kept.
  assert.equal((await putAi({})).status, 200);
  assert.deepEqual((await aiSettings()).settings.models, { nudge: workspaceModel });
});

await step("AI-16: with a nudge override, nudges and handoff briefs still work", async () => {
  const line = await nudgeLine();
  console.log(`    nudge: ${line}`);
  assert.notEqual(line, GENERIC_NUDGE);
  // A handoff the model decides on gets a model-written brief (job "brief", no override: workspace model).
  const { conversationId, socket } = await startChat("Please change the email on my account to bob@example.com.");
  await nextMessage(socket, (m) => m.authorType === "system", AI_TIMEOUT);
  socket.close();
  const deadline = Date.now() + 30_000;
  let brief: { body: string } | undefined;
  while (Date.now() < deadline && !brief) {
    const { messages } = (await agent.call(`/conversations/${conversationId}`)).json;
    brief = messages.find((m: { internal: boolean; body: string }) => m.internal && /^Handed off/.test(m.body));
    if (!brief) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(brief, "no handoff note");
  assert.match(brief.body, /\n\n\S/, `expected a model-written brief: ${brief.body}`);
});

await step("AI-16: an unknown override model falls back to the workspace model", async () => {
  assert.equal((await putAi({ models: { nudge: "does-not-exist-model", answer: "does-not-exist-model" } })).status, 200);
  const settings = await aiSettings();
  assert.equal(settings.effectiveModels.nudge, "does-not-exist-model");
  assert.equal(settings.effectiveModels.topics, workspaceModel);
  const line = await nudgeLine();
  console.log(`    nudge (fallback): ${line}`);
  assert.notEqual(line, GENERIC_NUDGE);
  const { conversationId, socket } = await startChat("How many days do I have to ask for a refund?");
  const answer = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system", AI_TIMEOUT);
  socket.close();
  assert.equal(answer.authorType, "ai", `expected an AI reply, got: ${answer.body}`);
  assert.equal(await handling(conversationId), "ai");
  // Restore: other suites share this workspace.
  assert.equal((await putAi({ models: {} })).status, 200);
  assert.deepEqual((await aiSettings()).settings.models, {});
});

await step("usage is counted, and at the cap chats go straight to the team", async () => {
  const usage = (await agent.call(`/workspaces/${workspaceId}/ai`)).json.usage;
  assert.ok(usage.replies >= 3, JSON.stringify(usage));
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 0 } });
  const { conversationId, socket } = await startChat("How do refunds work?");
  const notice = await nextMessage(socket, (m) => m.authorType === "system", 30_000);
  assert.match(notice.body, /teammate/i);
  assert.equal(await handling(conversationId), "human");
  socket.close();
});

await step("agents (not admins) can't change AI settings", async () => {
  const invite = await agent.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  const agentUser = new Client();
  await agentUser.register(`/invites/${token}`, new SoftAuthenticator(), { name: "Kim", email: `kim-${Date.now()}@acme.test` });
  assert.equal((await agentUser.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false } })).status, 403);
  assert.equal((await agentUser.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, models: { nudge: "gpt-6-luna" } } })).status, 403);
  // Agents can read which model each job uses.
  assert.ok((await agentUser.call(`/workspaces/${workspaceId}/ai`)).json.effectiveModels.answer);
  assert.equal((await agentUser.call(`/workspaces/${workspaceId}/knowledge/snippets`, { body: { title: "x", body: "y" } })).status, 403);
  assert.equal((await agentUser.call(`/workspaces/${workspaceId}/knowledge`)).status, 200);
});

summary();
