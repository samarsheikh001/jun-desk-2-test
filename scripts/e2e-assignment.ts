// End-to-end test of I-02 auto-assignment against a running dev server: round robin to
// teammates with the dashboard open, a per-teammate cap, and the cases that leave a chat
// unassigned. No AI turns (the AI is off, or the visitor asks for a person). Run after e2e-knowledge.

import assert from "node:assert/strict";
import { Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
const teammateName = `Rui ${run}`;
let workspaceId = "";
let widgetKey = "";
let ownerId = "";
let teammateId = "";
let aiSettings: Record<string, unknown> = {};
let inboxSettings: Record<string, unknown> = {};

const online = async (client: Client) => {
  const hub = new TestSocket(`/api/workspaces/${workspaceId}/ws`, { headers: { Cookie: cookieHeader(client) } });
  await hub.opened;
  await hub.next((e) => e.type === "presence");
  return hub;
};
const setAssignment = (assignment: unknown, client = owner) => client.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { assignment } });
const setAi = (enabled: boolean) => owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...aiSettings, enabled } });

/** A new visitor chat; returns its id. */
async function newChat(body: string): Promise<string> {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: `${body} (${run})` }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.conversation.id;
}

/** The assignee once auto-assignment has run (it runs right after the request returns). */
async function assigneeOf(conversationId: string, expectSomeone = true): Promise<string | null> {
  for (let i = 0; i < (expectSomeone ? 40 : 6); i++) {
    const c = (await owner.call(`/conversations/${conversationId}`)).json.conversation;
    if (c.assigneeId) return c.assigneeId;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const openCount = async (userId: string) => {
  const list = (await owner.call(`/workspaces/${workspaceId}/conversations?status=open`)).json.conversations as { assigneeId: string | null }[];
  return list.filter((c) => c.assigneeId === userId).length;
};

await step("owner signs in; a teammate joins; assignment is manual by default", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  const me = (await owner.call("/me")).json;
  workspaceId = me.memberships[0].workspaceId;
  ownerId = me.user.id;
  const inbox = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox;
  widgetKey = inbox.widgetKey;
  inboxSettings = inbox.settings;
  aiSettings = (await owner.call(`/workspaces/${workspaceId}/ai`)).json.settings;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: teammateName, email: `rui-${run}@acme.test` })).status, 200);
  teammateId = (await teammate.call("/me")).json.user.id;
  assert.ok(!inboxSettings.assignment || (inboxSettings.assignment as { mode: string }).mode === "manual");
});

await step("settings: admins only; validated", async () => {
  assert.equal((await setAssignment({ mode: "round_robin", capacity: 0 }, teammate)).status, 403);
  for (const bad of [{ mode: "random" }, { mode: "round_robin", capacity: -1 }, { mode: "round_robin", capacity: 1.5 }, { mode: "round_robin", capacity: 101 }, "round_robin"]) {
    assert.equal((await setAssignment(bad)).status, 400, JSON.stringify(bad));
  }
  const saved = await setAssignment({ mode: "round_robin", capacity: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.settings.assignment, { mode: "round_robin", capacity: 0 });
});

try {
  await step("AI off: a new chat goes to the one teammate online, with a note for the team", async () => {
    assert.equal((await setAi(false)).status, 200);
    const hub = await online(teammate);
    try {
      const id = await newChat("Can someone look at my account?");
      assert.equal(await assigneeOf(id), teammateId);
      const messages = (await owner.call(`/conversations/${id}`)).json.messages as { body: string; internal: boolean }[];
      const note = messages.find((m) => m.body === `Assigned to ${teammateName} automatically (round robin).`);
      assert.ok(note?.internal, "an internal note says who got it");
    } finally {
      hub.close();
    }
  });

  await step("round robin: with both online, chats alternate", async () => {
    const hubs = [await online(owner), await online(teammate)];
    try {
      const got = [];
      for (let i = 0; i < 4; i++) got.push(await assigneeOf(await newChat(`Question ${i}`)));
      // The teammate had the last turn, so the owner is next.
      assert.deepEqual(got, [ownerId, teammateId, ownerId, teammateId]);
    } finally {
      hubs.forEach((h) => h.close());
    }
  });

  await step("an AI handoff (\"talk to a person\") is assigned too", async () => {
    assert.equal((await setAi(true)).status, 200);
    const hub = await online(teammate);
    try {
      const id = await newChat("Can I talk to a person please?");
      assert.equal(await assigneeOf(id), teammateId);
      const c = (await owner.call(`/conversations/${id}`)).json.conversation;
      assert.equal(c.handling, "human");
    } finally {
      hub.close();
      await setAi(false);
    }
  });

  await step("the cap: a teammate at the limit gets no more; the chat waits in Unassigned", async () => {
    const hub = await online(teammate);
    try {
      const open = await openCount(teammateId);
      assert.ok(open > 0);
      assert.equal((await setAssignment({ mode: "round_robin", capacity: open })).status, 200);
      const id = await newChat("Anyone there?");
      assert.equal(await assigneeOf(id, false), null);
      assert.equal((await setAssignment({ mode: "round_robin", capacity: open + 1 })).status, 200);
      assert.equal(await assigneeOf(await newChat("Hello?")), teammateId, "under the cap again");
    } finally {
      hub.close();
    }
  });

  await step("nobody online, or manual: chats stay unassigned", async () => {
    assert.equal((await setAssignment({ mode: "round_robin", capacity: 0 })).status, 200);
    assert.equal(await assigneeOf(await newChat("Nobody home?"), false), null);
    const hub = await online(teammate);
    try {
      assert.equal((await setAssignment({ mode: "manual", capacity: 0 })).status, 200);
      assert.equal(await assigneeOf(await newChat("Manual please"), false), null);
    } finally {
      hub.close();
    }
  });
} finally {
  await owner.call(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { assignment: inboxSettings.assignment ?? { mode: "manual", capacity: 0 } } });
  await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: aiSettings });
}

summary();
