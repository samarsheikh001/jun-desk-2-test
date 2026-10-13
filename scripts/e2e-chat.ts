// End-to-end test of the M1 chat loop against a running dev server: a widget visitor and
// an agent talk in real time through the conversation Durable Object, with the workspace
// hub updating the inbox. Run after e2e-auth (it signs in as the owner via recovery).
//
//   npm run dev  &&  npm run test:e2e

import assert from "node:assert/strict";
import { AI_PROVIDER, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const agent = new Client();
let workspaceId = "";
let widgetKey = "";
let ownerId = "";
let hub!: TestSocket;

await step("owner signs in (recovery passkey) and finds the widget key", async () => {
  const res = await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const me = (await agent.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  ownerId = me.user.id;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  assert.match(widgetKey, /^wk_/);
  // This suite tests human chat: make sure the AI isn't answering (other suites may turn it on).
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: false, provider: AI_PROVIDER } });
});

await step("agent hub socket connects and reports presence", async () => {
  hub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookieHeader(agent) } });
  await hub.opened;
  const presence = await hub.next((e) => e.type === "presence");
  assert.ok(presence.online.some((o: { userId: string }) => o.userId === ownerId));
});

// ---------- visitor side (what the widget frame does) ----------
const visitor = new Client();
let visitorToken = "";
let conversationId = "";
let attachmentKey = "";

await step("widget config is public; visitor gets a token only when needed", async () => {
  const config = await visitor.call(`/widget/${widgetKey}/config`);
  assert.equal(config.status, 200);
  assert.ok(config.json.workspaceName);
  assert.equal((await visitor.call(`/widget/wk_nope/config`)).status, 404);
  assert.equal((await visitor.call(`/widget/${widgetKey}/conversations`)).status, 401);

  visitorToken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  assert.ok(visitorToken.length > 20);
});

const vh = () => ({ "X-Visitor-Token": visitorToken });

await step("visitor uploads a file and starts a conversation with it", async () => {
  const upload = await visitor.call(`/widget/${widgetKey}/files`, {
    body: new TextEncoder().encode("<script>alert(1)</script>"),
    headers: { ...vh(), "Content-Type": "text/html", "X-File-Name": encodeURIComponent("notes.html") },
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.json));
  attachmentKey = upload.json.attachment.key;

  const res = await visitor.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: "v-1", body: "Hi, billing page shows an error", attachments: [{ key: attachmentKey }] },
    headers: vh(),
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  conversationId = res.json.conversation.id;
  assert.equal(res.json.message.seq, 1);
  assert.equal(res.json.message.attachments[0].name, "notes.html");
});

await step("uploaded HTML downloads instead of rendering on our origin", async () => {
  const res = await fetch(new URL(`/api/files/${attachmentKey}`, process.env.BASE_URL ?? "http://localhost:5173"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

await step("the agent's inbox updates live and lists the conversation as unread", async () => {
  const event = await hub.next((e) => e.type === "conversation" && e.conversation.id === conversationId);
  assert.equal(event.conversation.lastMessagePreview, "Hi, billing page shows an error");
  const list = (await agent.call(`/workspaces/${workspaceId}/conversations?status=open`)).json.conversations;
  const summaryRow = list.find((c: { id: string }) => c.id === conversationId);
  assert.ok(summaryRow);
  assert.ok(summaryRow.lastSeq > summaryRow.agentReadSeq);
});

let agentSocket!: TestSocket;
let visitorSocket!: TestSocket;

await step("both sides connect to the conversation; the agent gets the backlog", async () => {
  agentSocket = new TestSocket(`/api/conversations/${conversationId}/ws?since=0`, { headers: { Cookie: cookieHeader(agent) } });
  visitorSocket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [visitorToken] });
  await Promise.all([agentSocket.opened, visitorSocket.opened]);
  const backlog = await agentSocket.next((e) => e.type === "messages");
  assert.deepEqual(backlog.messages.map((m: { seq: number }) => m.seq), [1]);
  assert.deepEqual((await visitorSocket.next((e) => e.type === "messages")).messages, []);
});

await step("typing indicators reach the other side only", async () => {
  visitorSocket.send({ type: "typing", typing: true });
  const typing = await agentSocket.next((e) => e.type === "typing");
  assert.equal(typing.authorType, "visitor");
  await visitorSocket.none((e) => e.type === "typing");
});

await step("agent replies over the socket; the visitor receives it live", async () => {
  agentSocket.send({ type: "send", clientMsgId: "a-1", body: "Sorry about that! Looking now." });
  const ack = await agentSocket.next((e) => e.type === "message" && e.message.clientMsgId === "a-1");
  assert.equal(ack.message.seq, 2);
  const received = await visitorSocket.next((e) => e.type === "message" && e.message.clientMsgId === "a-1");
  assert.equal(received.message.authorType, "agent");
  assert.ok(received.message.authorName);
});

await step("a retried send with the same clientMsgId doesn't duplicate", async () => {
  agentSocket.send({ type: "send", clientMsgId: "a-1", body: "Sorry about that! Looking now." });
  const ack = await agentSocket.next((e) => e.type === "message" && e.message.clientMsgId === "a-1");
  assert.equal(ack.message.seq, 2);
  const { messages } = (await agent.call(`/conversations/${conversationId}`)).json;
  assert.equal(messages.length, 2);
});

await step("read receipts: the visitor reads, the agent sees it", async () => {
  visitorSocket.send({ type: "read", seq: 2 });
  const read = await agentSocket.next((e) => e.type === "read");
  assert.deepEqual(read, { type: "read", by: "visitor", seq: 2 });
});

await step("assign + resolve updates the inbox; a new visitor message reopens it", async () => {
  const patched = await agent.call(`/conversations/${conversationId}`, { method: "PATCH", body: { status: "resolved", assigneeId: ownerId } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const resolved = await hub.next((e) => e.type === "conversation" && e.conversation.status === "resolved");
  assert.equal(resolved.conversation.assigneeId, ownerId);

  visitorSocket.send({ type: "send", clientMsgId: "v-2", body: "Actually, one more thing" });
  const reopened = await hub.next((e) => e.type === "conversation" && e.conversation.status === "open" && e.conversation.lastSeq === 3);
  assert.equal(reopened.conversation.lastMessageAuthor, "visitor");
});

await step("security: wrong tokens, other visitors, other origins and foreign files are refused", async () => {
  const stranger = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws`, { protocols: ["not-a-real-token"] });
  await assert.rejects(stranger.opened);

  const other = new Client();
  const otherToken = (await other.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  assert.equal((await other.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: { "X-Visitor-Token": otherToken } })).status, 404);

  const signedOut = new TestSocket(`/api/conversations/${conversationId}/ws`);
  await assert.rejects(signedOut.opened);

  const crossOrigin = new TestSocket(`/api/conversations/${conversationId}/ws`, { headers: { Cookie: cookieHeader(agent), Origin: "https://evil.example" } });
  await assert.rejects(crossOrigin.opened);

  // The other visitor can't attach the first visitor's upload to their own conversation.
  const res = await other.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: "o-1", body: "hi", attachments: [{ key: attachmentKey }] },
    headers: { "X-Visitor-Token": otherToken },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "unknown_file");
  // ...and the rejected first message doesn't leave an empty conversation behind.
  assert.deepEqual((await other.call(`/widget/${widgetKey}/conversations`, { headers: { "X-Visitor-Token": otherToken } })).json.conversations, []);
});

await step("returning visitor sees their conversation history", async () => {
  const list = (await visitor.call(`/widget/${widgetKey}/conversations`, { headers: vh() })).json.conversations;
  assert.equal(list[0].id, conversationId);
  const { messages } = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json;
  assert.deepEqual(messages.map((m: { seq: number }) => m.seq), [1, 2, 3]);
});

for (const s of [hub, agentSocket, visitorSocket]) s.close();
summary();
