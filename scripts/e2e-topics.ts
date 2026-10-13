// End-to-end test of A-02 topic labels. Other suites share the workspace (and its topics), so
// this plays six chats about two clear subjects (billing, password reset), resolves them (which
// makes them eligible right away; "quiet for 10 minutes" isn't shortened for tests), runs
// "Label now" and checks: few topics, different ones per subject, Reports and the inbox filter
// reflect them, admins alone rename/merge/delete, visitors never see topics, AI off = no labels.
// Uses the real AI (E2E_AI_PROVIDER, default ChatGPT): a handful of model calls.

import assert from "node:assert/strict";
import { AI_PROVIDER, Client, SETUP_TOKEN, SoftAuthenticator, step, summary } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
let workspaceId = "";
let widgetKey = "";
let aiSettings: Record<string, unknown> = {};

const setAi = (enabled: boolean) =>
  owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } });
const report = async () => {
  const res = await owner.call(`/workspaces/${workspaceId}/metrics?days=7&tz=UTC`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.report;
};
const label = async (client = owner) => client.call(`/workspaces/${workspaceId}/topics/label`, { body: {} });
const topicOf = async (id: string) => (await owner.call(`/conversations/${id}`)).json.conversation.topic as { id: string; name: string } | null;

interface Chat { id: string; visitor: Client; token: string; subject: "billing" | "password" }
const chats: Chat[] = [];

async function startChat(subject: Chat["subject"], body: string, path: string): Promise<Chat> {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const context = { page: { url: `https://topics.e2e.test${path}`, title: "Topics e2e" }, userAgent: "e2e", viewport: { w: 1280, h: 800 }, language: "en", timezone: "UTC", capturedAt: Date.now(), events: [] };
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body, context }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: res.json.conversation.id, visitor, token, subject };
}
const resolve = async (id: string) => assert.equal((await owner.call(`/conversations/${id}`, { method: "PATCH", body: { status: "resolved" } })).json.conversation.status, "resolved");

let before: any;

await step("owner and an agent sign in; topics start out listed for members", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Tess ${run}`, email: `tess-${run}@acme.test` })).status, 200);

  const list = await teammate.call(`/workspaces/${workspaceId}/topics`);
  assert.equal(list.status, 200);
  assert.equal(list.json.max, 40);
  assert.equal((await new Client().call(`/workspaces/${workspaceId}/topics`)).status, 401);
  assert.equal((await owner.call(`/workspaces/ws_nope/topics`)).status, 404);
});

await step("six chats about two subjects (AI off, so no replies), with a note, all resolved", async () => {
  assert.equal((await setAi(false)).status, 200);
  const billing = [
    `I was charged twice for my subscription this month, can you refund one charge? (${run})`,
    `How do I change the credit card used to pay my invoices? (${run})`,
    `Our invoice shows the wrong amount for the annual plan, please fix the bill (${run})`,
  ];
  const password = [
    `I forgot my password and the reset email never arrives (${run})`,
    `The password reset link says it has expired, how do I reset my password? (${run})`,
    `Can't log in: I need to reset my password but don't get the email (${run})`,
  ];
  for (const body of billing) chats.push(await startChat("billing", body, "/billing/invoices/42"));
  for (const body of password) chats.push(await startChat("password", body, "/login"));
  // Notes never reach the model (nor visitors); the label still comes from the visitor's words.
  await owner.call(`/conversations/${chats[0]!.id}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Internal: VIP account, handle with care", internal: true } });
  for (const chat of chats) await resolve(chat.id);
  for (const chat of chats) assert.equal(await topicOf(chat.id), null);
  before = await report();
});

await step("AI off: labelling does nothing; agents can't run it", async () => {
  assert.equal((await label(teammate)).status, 403);
  const res = await label();
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json, { labeled: 0, ids: [], unlabeled: 0, skipped: "ai_off" });
  for (const chat of chats) assert.equal(await topicOf(chat.id), null);
});

const topicIds = new Map<string, string>();
await step(`AI on (${AI_PROVIDER}): "Label now" gives the six chats few topics, different per subject`, async () => {
  assert.equal((await setAi(true)).status, 200);
  // Other suites' chats are waiting too; ours are the newest, so the first pass reaches them.
  for (let i = 0; i < 3 && chats.some((c) => !topicIds.has(c.id)); i++) {
    const res = await label();
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.skipped, undefined);
    for (const chat of chats) {
      const topic = await topicOf(chat.id);
      if (topic) topicIds.set(chat.id, topic.id);
    }
  }
  const names = new Map<string, string>();
  for (const chat of chats) {
    const topic = await topicOf(chat.id);
    assert.ok(topic, `chat ${chat.subject} got a topic`);
    names.set(topic.id, topic.name);
  }
  const of = (subject: Chat["subject"]) => new Set(chats.filter((c) => c.subject === subject).map((c) => topicIds.get(c.id)!));
  const billing = of("billing");
  const password = of("password");
  console.log(`    topics: ${chats.map((c) => `${c.subject}=${names.get(topicIds.get(c.id)!)}`).join(", ")}`);
  assert.ok(new Set(topicIds.values()).size <= 3, "at most 3 distinct topics for 6 chats");
  assert.ok([...billing].every((t) => !password.has(t)), "billing and password chats never share a topic");

  // Nothing new to label for ours: a second pass leaves them alone.
  const again = await label();
  assert.ok(!chats.some((c) => again.json.ids.includes(c.id)), "already labelled chats aren't relabelled");
});

await step("Reports counts the topics; the inbox filters by them; visitors never see them", async () => {
  const after = await report();
  assert.ok(after.topics.labeled - before.topics.labeled >= chats.length);
  const count = (r: any, id: string) => r.topics.list.find((t: { id: string }) => t.id === id)?.count ?? 0;
  const mine = new Map<string, number>();
  for (const id of topicIds.values()) mine.set(id, (mine.get(id) ?? 0) + 1);
  for (const [id, n] of mine) assert.ok(count(after, id) - count(before, id) >= n, `report counts topic ${id}`);
  const entry = after.topics.list.find((t: { id: string }) => t.id === [...mine.keys()][0]);
  assert.ok(entry.share > 0 && entry.share <= 1 && typeof entry.name === "string");

  const billingTopic = topicIds.get(chats[0]!.id)!;
  const filtered = (await owner.call(`/workspaces/${workspaceId}/conversations?status=all&topic=${billingTopic}`)).json.conversations as { id: string; topic: { id: string } }[];
  assert.ok(filtered.every((c) => c.topic.id === billingTopic));
  for (const chat of chats) assert.equal(filtered.some((c) => c.id === chat.id), topicIds.get(chat.id) === billingTopic, `filter ${chat.subject}`);

  for (const chat of chats.slice(0, 2)) {
    const headers = { "X-Visitor-Token": chat.token };
    const one = (await chat.visitor.call(`/widget/${widgetKey}/conversations/${chat.id}`, { headers })).json;
    assert.equal(one.conversation.topic, null);
    assert.ok(!JSON.stringify(one).includes(billingTopic), "no topic id anywhere in the visitor's view");
    const list = (await chat.visitor.call(`/widget/${widgetKey}/conversations`, { headers })).json.conversations as { topic: unknown }[];
    assert.ok(list.length > 0 && list.every((c) => c.topic === null));
  }
});

await step("a resumed chat with fewer than three visitor messages is relabelled once it's done", async () => {
  const chat = chats[0]!;
  const sent = await chat.visitor.call(`/widget/${widgetKey}/conversations/${chat.id}/messages`, {
    body: { clientMsgId: crypto.randomUUID(), body: "Also, can I get the refund as account credit instead?" },
    headers: { "X-Visitor-Token": chat.token },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await resolve(chat.id);
  const res = await label();
  assert.ok(res.json.ids.includes(chat.id), "relabelled");
  assert.ok(!chats.slice(1).some((c) => res.json.ids.includes(c.id)));
  topicIds.set(chat.id, (await topicOf(chat.id))!.id);
});

await step("admins rename, merge and delete topics; agents can't", async () => {
  const billingTopic = topicIds.get(chats[1]!.id)!;
  const passwordTopic = topicIds.get(chats[3]!.id)!;
  const topics = (await owner.call(`/workspaces/${workspaceId}/topics`)).json.topics as { id: string; name: string; conversations: number }[];
  const original = topics.find((t) => t.id === billingTopic)!.name;
  const passwordName = topics.find((t) => t.id === passwordTopic)!.name;
  assert.ok(topics.find((t) => t.id === billingTopic)!.conversations >= 2);

  assert.equal((await teammate.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "PATCH", body: { name: "Nope" } })).status, 403);
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/topics/${billingTopic}/merge`, { body: { into: passwordTopic } })).status, 403);
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "DELETE" })).status, 403);

  // Rename: a clash is refused (merge instead); the new name shows on the conversation.
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "PATCH", body: { name: passwordName.toUpperCase() } })).status, 409);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "PATCH", body: { name: "" } })).status, 400);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/top_nope`, { method: "PATCH", body: { name: "X" } })).status, 404);
  const renamed = `Billing ${run}`;
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "PATCH", body: { name: renamed } })).status, 200);
  assert.equal((await topicOf(chats[1]!.id))!.name, renamed);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "PATCH", body: { name: original } })).status, 200);

  // Merge: the password chats move to the billing topic and the password topic is gone.
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}/merge`, { body: { into: billingTopic } })).status, 400);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}/merge`, { body: { into: "top_nope" } })).status, 404);
  const merged = await owner.call(`/workspaces/${workspaceId}/topics/${passwordTopic}/merge`, { body: { into: billingTopic } });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  assert.ok(merged.json.moved >= 1);
  for (const chat of chats.filter((c) => topicIds.get(c.id) === passwordTopic)) assert.equal((await topicOf(chat.id))!.id, billingTopic);
  const listed = (await owner.call(`/workspaces/${workspaceId}/topics`)).json.topics as { id: string }[];
  assert.ok(!listed.some((t) => t.id === passwordTopic));

  // Delete: its conversations become unlabeled.
  assert.equal((await owner.call(`/workspaces/${workspaceId}/topics/${billingTopic}`, { method: "DELETE" })).status, 200);
  for (const chat of chats.filter((c) => [billingTopic, passwordTopic].includes(topicIds.get(c.id)!))) assert.equal(await topicOf(chat.id), null);
});

await step("deleted topics' chats wait while the AI is off, then get labelled again", async () => {
  const unlabeled = [];
  for (const chat of chats) if ((await topicOf(chat.id)) === null) unlabeled.push(chat);
  assert.ok(unlabeled.length >= 2);
  assert.equal((await setAi(false)).status, 200);
  assert.equal((await label()).json.skipped, "ai_off");
  for (const chat of unlabeled) assert.equal(await topicOf(chat.id), null);
  assert.equal((await setAi(true)).status, 200);
  try {
    const res = await label();
    assert.equal(res.status, 200, JSON.stringify(res.json));
    for (const chat of unlabeled) assert.ok(await topicOf(chat.id), `relabelled ${chat.subject}`);
  } finally {
    await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: aiSettings });
  }
});

summary();
