// End-to-end test of M7's inbox basics: internal notes and @mentions (I-05), saved replies
// (I-06), tags (I-07), offline email capture (W-08) and CSAT (W-12). Notes and tags must never
// reach the visitor. Run after e2e-polish.

import assert from "node:assert/strict";
import { signIdentityToken } from "../worker/lib/identity.ts";
import { Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const visitor = new Client();
const run = Date.now().toString(36);
const teammateName = `Ola ${run}`;
let workspaceId = "";
let widgetKey = "";
let teammateId = "";
let visitorToken = "";
let conversationId = "";
let visitorSocket: TestSocket;
const vh = () => ({ "X-Visitor-Token": visitorToken });

await step("owner signs in; a teammate joins", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: teammateName, email: `ola-${run}@acme.test` })).status, 200);
  teammateId = (await teammate.call("/me")).json.user.id;
});

await step("setup: a conversation the AI is handling, with the visitor connected", async () => {
  visitorToken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  const conv = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "My invoice export is broken" }, headers: vh() });
  assert.equal(conv.status, 200, JSON.stringify(conv.json));
  conversationId = conv.json.conversation.id;
  assert.deepEqual(conv.json.conversation.tags, []);
  // An agent reply, then "Hand back to AI": the last message isn't the visitor's, so no AI turn runs.
  await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Looking into it." } });
  assert.equal((await owner.call(`/conversations/${conversationId}`, { method: "PATCH", body: { handling: "ai" } })).json.conversation.handling, "ai");
  visitorSocket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=100000`, { protocols: [visitorToken] });
  await visitorSocket.opened;
});

await step("I-05: a note @mentioning a teammate stays with the team and doesn't take over from the AI", async () => {
  const hub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookieHeader(teammate) } });
  await hub.opened;
  const agentSocket = new TestSocket(`/api/conversations/${conversationId}/ws?since=100000`, { headers: { Cookie: cookieHeader(owner) } });
  await agentSocket.opened;
  const before = (await owner.call(`/conversations/${conversationId}`)).json.conversation;

  const clientMsgId = crypto.randomUUID();
  agentSocket.send({ type: "send", clientMsgId, body: `@${teammateName.toLowerCase()} can you check the export job? Customer is on Pro.`, internal: true });
  const ack = await agentSocket.next((e) => e.type === "message" && e.message.clientMsgId === clientMsgId);
  assert.equal(ack.message.internal, true);
  assert.equal(ack.message.authorType, "agent");
  assert.deepEqual(ack.message.meta.mentions, [teammateId]);

  const mention = await hub.next((e) => e.type === "mention");
  assert.equal(mention.conversationId, conversationId);
  assert.deepEqual(mention.userIds, [teammateId]);
  assert.match(mention.preview, /export job/);

  // A retry of the same note is a no-op: no second message, no second ping.
  agentSocket.send({ type: "send", clientMsgId, body: "@whoever retry", internal: true });
  assert.equal((await agentSocket.next((e) => e.type === "message" && e.message.clientMsgId === clientMsgId)).message.id, ack.message.id);
  await hub.none((e) => e.type === "mention", 800);

  // The visitor saw nothing: no message event, no typing, not in their transcript.
  await visitorSocket.none((e) => e.type === "message" || e.type === "typing", 300);
  const transcript = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as { body: string }[];
  assert.ok(!transcript.some((m) => /export job/.test(m.body)), "note leaked to the visitor");

  const after = (await owner.call(`/conversations/${conversationId}`)).json;
  assert.equal(after.conversation.handling, "ai", "a note doesn't take over");
  assert.ok(!after.messages.some((m: { body: string }) => /took over/.test(m.body)));
  assert.equal(after.conversation.lastMessagePreview, before.lastMessagePreview, "notes don't change the inbox preview");
  hub.close();
  agentSocket.close();
});

await step("I-05: the mentioned teammate sees it under 'Mentions me' until they open the conversation", async () => {
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/mentions`)).json.unread, 1);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/mentions`)).json.unread, 0, "the author isn't mentioned");
  const mine = (await teammate.call(`/workspaces/${workspaceId}/conversations?status=all&assignee=mentions`)).json.conversations as { id: string }[];
  assert.deepEqual(mine.map((c) => c.id), [conversationId]);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/conversations?status=all&assignee=mentions`)).json.conversations.length, 0);
  const opened = await teammate.call(`/conversations/${conversationId}`);
  assert.ok(opened.json.messages.some((m: { internal: boolean; body: string }) => m.internal && /export job/.test(m.body)), "agents see notes");
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/mentions`)).json.unread, 0);
  // Still listed (it's where they were mentioned), just not new.
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/conversations?status=all&assignee=mentions`)).json.conversations.length, 1);
});

await step("I-05: visitors can't write notes; an HTTP note works like the socket", async () => {
  const id = crypto.randomUUID();
  visitorSocket.send({ type: "send", clientMsgId: id, body: "Am I hidden?", internal: true });
  const ack = await visitorSocket.next((e) => e.type === "message" && e.message.clientMsgId === id);
  assert.equal(ack.message.internal, false);
  const note = await owner.call(`/conversations/${conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Logged as BUG-12", internal: true } });
  assert.equal(note.json.message.internal, true);
  await visitorSocket.none((e) => e.type === "message" && /BUG-12/.test(e.message.body), 300);
});

await step("I-06: the team's saved replies (any member can add and edit)", async () => {
  const base = `/workspaces/${workspaceId}/saved-replies`;
  assert.equal((await owner.call(base, { body: { title: "", body: "x" } })).status, 400);
  const created = await teammate.call(base, { body: { title: "Refund policy", body: "Hi {first_name}, refunds are possible within 30 days. – {agent_name}" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.savedReply.id;
  assert.equal((await owner.call(`${base}/${id}`, { method: "PATCH", body: { title: "Refund policy", body: "Hi {first_name}, refunds within 60 days." } })).status, 200);
  const list = (await owner.call(base)).json.savedReplies as { id: string; body: string }[];
  assert.equal(list.find((r) => r.id === id)?.body, "Hi {first_name}, refunds within 60 days.");
  assert.equal((await owner.call(`${base}/sr_missing`, { method: "PATCH", body: { title: "a", body: "b" } })).status, 404);
  assert.equal((await new Client().call(base)).status, 401);
  assert.equal((await teammate.call(`${base}/${id}`, { method: "DELETE" })).status, 200);
  assert.ok(!(await owner.call(base)).json.savedReplies.some((r: { id: string }) => r.id === id));
});

await step("I-07: tags are set per conversation, deduped, filterable, and hidden from the visitor", async () => {
  visitorSocket.events.length = 0;
  const set = await teammate.call(`/conversations/${conversationId}/tags`, { method: "PUT", body: { tags: [`Billing-${run}`, ` billing-${run} `, `#Bug-${run}`] } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.deepEqual(set.json.conversation.tags, [`Billing-${run}`, `Bug-${run}`]);
  assert.equal((await teammate.call(`/conversations/${conversationId}/tags`, { method: "PUT", body: { tags: ["x".repeat(41)] } })).status, 400);

  // The visitor's socket got the update, without tags; so does their conversation list.
  const event = await visitorSocket.next((e) => e.type === "conversation");
  assert.deepEqual(event.conversation.tags, []);
  const visitorList = (await visitor.call(`/widget/${widgetKey}/conversations`, { headers: vh() })).json.conversations as { tags: string[] }[];
  assert.ok(visitorList.every((c) => c.tags.length === 0));

  const filtered = (await owner.call(`/workspaces/${workspaceId}/conversations?status=all&tag=${encodeURIComponent(`bug-${run}`)}`)).json.conversations as { id: string }[];
  assert.deepEqual(filtered.map((c) => c.id), [conversationId], "tag filter is case-insensitive");
  const tags = (await owner.call(`/workspaces/${workspaceId}/tags`)).json.tags as { id: string; name: string; conversations: number }[];
  const billing = tags.find((t) => t.name === `Billing-${run}`)!;
  const bug = tags.find((t) => t.name === `Bug-${run}`)!;
  assert.equal(billing.conversations, 1);

  // Admins manage tags; agents can't.
  assert.equal((await teammate.call(`/workspaces/${workspaceId}/tags/${billing.id}`, { method: "PATCH", body: { name: "Money" } })).status, 403);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/tags/${billing.id}`, { method: "PATCH", body: { name: `bug-${run}` } })).status, 409);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/tags/${billing.id}`, { method: "PATCH", body: { name: `Payments-${run}` } })).status, 200);
  assert.equal((await owner.call(`/workspaces/${workspaceId}/tags/${bug.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await owner.call(`/conversations/${conversationId}`)).json.conversation.tags, [`Payments-${run}`]);

  const cleared = await owner.call(`/conversations/${conversationId}/tags`, { method: "PUT", body: { tags: [] } });
  assert.deepEqual(cleared.json.conversation.tags, []);
  visitorSocket.close();
});

await step("W-08: a visitor waiting for the team leaves an email; agents get it as a note", async () => {
  // Whether anyone's online decides if the widget asks right away (only a yes/no reaches visitors).
  assert.deepEqual((await visitor.call(`/widget/${widgetKey}/online`)).json, { online: false });
  const hub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookieHeader(owner) } });
  await hub.opened;
  assert.deepEqual((await visitor.call(`/widget/${widgetKey}/online`)).json, { online: true });
  hub.close();

  const path = `/widget/${widgetKey}/conversations/${conversationId}/email`;
  assert.equal((await visitor.call(path, { body: { email: "not-an-email" }, headers: vh() })).status, 400);
  assert.equal((await new Client().call(path, { body: { email: "a@b.co" } })).status, 401);
  for (let i = 0; i < 2; i++) {
    const saved = await visitor.call(path, { body: { email: " Dana@Northwind.test " }, headers: vh() });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.email, "dana@northwind.test");
  }
  const agentView = (await owner.call(`/conversations/${conversationId}`)).json;
  assert.equal(agentView.conversation.contact.email, "dana@northwind.test");
  const notes = (agentView.messages as { body: string; internal: boolean }[]).filter((m) => m.internal && /left their email/.test(m.body));
  assert.equal(notes.length, 1, "saving the same email twice adds one note");
  const transcript = (await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}`, { headers: vh() })).json.messages as { body: string }[];
  assert.ok(!transcript.some((m) => /left their email/.test(m.body)));

  // Verified customers' email comes from the host app.
  let secret = (await owner.call(`/workspaces/${workspaceId}/identity`)).json.secret as string | null;
  secret ??= (await owner.call(`/workspaces/${workspaceId}/identity`, { body: {} })).json.secret as string;
  const jwt = await signIdentityToken({ sub: `inbox-${run}`, email: `vic-${run}@acme.test`, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  const vic = new Client();
  const vicToken = (await vic.call(`/widget/${widgetKey}/identify`, { body: { userToken: jwt } })).json.token as string;
  const vicConv = (await vic.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "hello" }, headers: { "X-Visitor-Token": vicToken } })).json.conversation;
  const blocked = await vic.call(`/widget/${widgetKey}/conversations/${vicConv.id}/email`, { body: { email: "other@x.test" }, headers: { "X-Visitor-Token": vicToken } });
  assert.equal(blocked.status, 409);
  assert.equal((await owner.call(`/conversations/${vicConv.id}`)).json.conversation.contact.email, `vic-${run}@acme.test`);
});

// ---------- W-12: CSAT ----------
let csatId = "";
const ratePath = () => `/widget/${widgetKey}/conversations/${csatId}/rating`;
const rate = (body: Record<string, unknown>) => visitor.call(ratePath(), { body, headers: vh() });
const agentNotes = async (pattern: RegExp) =>
  ((await owner.call(`/conversations/${csatId}`)).json.messages as { body: string; internal: boolean }[]).filter((m) => m.internal && pattern.test(m.body));
const resolve = async () => {
  const res = await owner.call(`/conversations/${csatId}`, { method: "PATCH", body: { status: "resolved" } });
  assert.equal(res.json.conversation.status, "resolved");
};

await step("W-12: no rating until the conversation is resolved and someone replied", async () => {
  assert.equal((await visitor.call(`/widget/${widgetKey}/config`)).json.csat, true, "on by default");
  const conv = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Can I change my plan mid-month?" }, headers: vh() });
  assert.equal(conv.status, 200, JSON.stringify(conv.json));
  csatId = conv.json.conversation.id;
  assert.deepEqual(conv.json.conversation.csat, { rating: null, ratedThisRound: false });
  assert.equal((await rate({ rating: "good" })).json.error.code, "not_resolved");
  // An agent answers (taking it from the AI), so no AI turn writes after this.
  await owner.call(`/conversations/${csatId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Yes, it's prorated." } });
  assert.equal((await rate({ rating: "meh" })).status, 400);
  assert.equal((await new Client().call(ratePath(), { body: { rating: "good" } })).status, 401);
});

await step("W-12: resolved, the visitor rates 👍 once; agents get a note, the visitor doesn't", async () => {
  await resolve();
  assert.deepEqual((await visitor.call(`/widget/${widgetKey}/conversations/${csatId}`, { headers: vh() })).json.conversation.csat, { rating: null, ratedThisRound: false });
  const rated = await rate({ rating: "good" });
  assert.equal(rated.status, 200, JSON.stringify(rated.json));
  assert.deepEqual(rated.json.conversation.csat, { rating: "good", ratedThisRound: true });
  assert.equal((await agentNotes(/rated this conversation 👍 Good\./)).length, 1);
  const transcript = (await visitor.call(`/widget/${widgetKey}/conversations/${csatId}`, { headers: vh() })).json.messages as { body: string }[];
  assert.ok(!transcript.some((m) => /rated this conversation/.test(m.body)), "rating note leaked to the visitor");

  // Rated this round: no second rating, no switching to 👎; a comment on the same rating is fine (once).
  assert.equal((await rate({ rating: "good" })).json.error.code, "already_rated");
  assert.equal((await rate({ rating: "bad", comment: "Actually no" })).json.error.code, "already_rated");
  assert.equal((await rate({ rating: "good", comment: "x".repeat(1001) })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await rate({ rating: "good", comment: " Quick and clear " })).status, 200);
  const comments = await agentNotes(/commented on their 👍 Good rating: Quick and clear$/);
  assert.equal(comments.length, 1, "the same comment twice adds one note");

  // Pending and back to resolved without the visitor writing: still the same, rated round.
  await owner.call(`/conversations/${csatId}`, { method: "PATCH", body: { status: "pending" } });
  await resolve();
  assert.deepEqual((await visitor.call(`/widget/${widgetKey}/conversations/${csatId}`, { headers: vh() })).json.conversation.csat, { rating: "good", ratedThisRound: true });
  assert.equal((await rate({ rating: "good" })).json.error.code, "already_rated");
});

await step("W-12: writing again reopens it; resolved again, they can rate again (👎) and agents can filter", async () => {
  const again = await visitor.call(`/widget/${widgetKey}/conversations/${csatId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "The proration looks wrong on my invoice" }, headers: vh() });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const reopened = (await visitor.call(`/widget/${widgetKey}/conversations/${csatId}`, { headers: vh() })).json.conversation;
  assert.equal(reopened.status, "open");
  assert.deepEqual(reopened.csat, { rating: "good", ratedThisRound: false }, "the old rating stays until a new one");
  assert.equal((await rate({ rating: "bad" })).json.error.code, "not_resolved");
  await owner.call(`/conversations/${csatId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Fixed, sorry about that." } });
  await resolve();
  const rated = await rate({ rating: "bad", comment: "Took two tries" });
  assert.equal(rated.status, 200, JSON.stringify(rated.json));
  assert.deepEqual(rated.json.conversation.csat, { rating: "bad", ratedThisRound: true });
  assert.equal((await agentNotes(/rated this conversation 👎 Bad: Took two tries$/)).length, 1);
  assert.equal((await agentNotes(/rated this conversation/)).length, 2, "both ratings are kept");

  const list = (rating: string) => owner.call(`/workspaces/${workspaceId}/conversations?status=all&rating=${rating}`);
  const bad = (await list("bad")).json.conversations as { id: string; csat: { rating: string } }[];
  assert.ok(bad.some((c) => c.id === csatId) && bad.every((c) => c.csat.rating === "bad"), JSON.stringify(bad));
  assert.ok(!(await list("good")).json.conversations.some((c: { id: string }) => c.id === csatId), "the latest rating wins");
  assert.equal((await list("great")).status, 400);
});

await step("W-12: turned off, the widget doesn't ask and ratings are refused", async () => {
  const inbox = `/workspaces/${workspaceId}/inbox`;
  assert.equal((await owner.call(inbox, { method: "PATCH", body: { csat: false } })).json.settings.csat, false);
  try {
    assert.equal((await visitor.call(`/widget/${widgetKey}/config`)).json.csat, false);
    await visitor.call(`/widget/${widgetKey}/conversations/${csatId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "One more thing" }, headers: vh() });
    await resolve();
    assert.equal((await rate({ rating: "good" })).json.error.code, "csat_off");
  } finally {
    assert.equal((await owner.call(inbox, { method: "PATCH", body: { csat: true } })).json.settings.csat, true);
  }
  assert.equal((await rate({ rating: "good" })).status, 200, "back on: this round can be rated");
});

summary();
