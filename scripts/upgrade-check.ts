// T-12: proves an older install upgrades cleanly. Run `seed` against a desk on an OLD version,
// upgrade that same database to the current code (migrations + new Worker), then `verify`.
//
//   BASE_URL=http://localhost:5175 node scripts/upgrade-check.ts seed   state.json   # old code
//   BASE_URL=http://localhost:5174 node scripts/upgrade-check.ts verify state.json   # new code, same DB
//
// Only uses API calls that existed by M2 for seeding, so it works on any install since then.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const [mode, file = "upgrade-state.json"] = process.argv.slice(2);
const agent = new Client();

interface Seeded {
  workspaceId: string;
  widgetKey: string;
  visitorToken: string;
  conversationId: string;
}

if (mode === "seed") {
  const seeded = {} as Seeded;
  await step("old desk: owner set up", async () => {
    const res = await agent.register("/setup", new SoftAuthenticator(), { token: SETUP_TOKEN, workspaceName: "Northwind", name: "Nina", email: "nina@northwind.test" });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    seeded.workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
    seeded.widgetKey = (await agent.call(`/workspaces/${seeded.workspaceId}/inbox`)).json.inbox.widgetKey;
  });
  await step("old desk: AI guidance, knowledge, a conversation with an agent reply", async () => {
    const ai = await agent.call(`/workspaces/${seeded.workspaceId}/ai`, {
      method: "PUT",
      body: { enabled: true, provider: "workers-ai", instructions: "Sign every answer with: Team Northwind.", monthlyReplyCap: 100 },
    });
    assert.equal(ai.status, 200, JSON.stringify(ai.json));
    const kb = await agent.call(`/workspaces/${seeded.workspaceId}/knowledge/snippets`, { body: { title: "Shipping", body: "Northwind orders ship within 2 business days from Oslo." } });
    assert.equal(kb.status, 200, JSON.stringify(kb.json));
    const visitor = new Client();
    seeded.visitorToken = (await visitor.call(`/widget/${seeded.widgetKey}/visitor`, { body: {} })).json.token;
    const conv = await visitor.call(`/widget/${seeded.widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Hello from before the upgrade" }, headers: { "X-Visitor-Token": seeded.visitorToken } });
    assert.equal(conv.status, 200, JSON.stringify(conv.json));
    seeded.conversationId = conv.json.conversation.id;
    const reply = await agent.call(`/conversations/${seeded.conversationId}/messages`, { body: { clientMsgId: crypto.randomUUID(), body: "Hi! Agent reply before the upgrade." } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
  });
  writeFileSync(file, JSON.stringify(seeded, null, 2));
  summary();
} else if (mode === "verify") {
  const seeded = JSON.parse(readFileSync(file, "utf8")) as Seeded;
  await step("upgraded desk: the owner gets back in and sees the same workspace", async () => {
    assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
    const me = (await agent.call("/me")).json;
    assert.equal(me.memberships[0].workspaceId, seeded.workspaceId);
    assert.equal(me.memberships[0].workspaceName, "Northwind");
  });
  await step("upgraded desk: old conversations, messages and widget key are intact", async () => {
    const res = await agent.call(`/conversations/${seeded.conversationId}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const bodies = (res.json.messages as { body: string }[]).map((m) => m.body);
    assert.ok(bodies.includes("Hello from before the upgrade") && bodies.includes("Hi! Agent reply before the upgrade."), JSON.stringify(bodies));
    assert.equal(res.json.conversation.contact.verified, false);
    assert.equal((await agent.call(`/workspaces/${seeded.workspaceId}/inbox`)).json.inbox.widgetKey, seeded.widgetKey);
  });
  await step("upgraded desk: the visitor's old browser token still works (moved to visitor_tokens)", async () => {
    const res = await new Client().call(`/widget/${seeded.widgetKey}/conversations`, { headers: { "X-Visitor-Token": seeded.visitorToken } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.conversations.some((c: { id: string }) => c.id === seeded.conversationId));
  });
  await step("upgraded desk: knowledge still searchable; the old AI guidance became AGENTS.md", async () => {
    const hits = (await agent.call(`/workspaces/${seeded.workspaceId}/knowledge/search`, { body: { query: "how fast do orders ship" } })).json.hits;
    assert.ok(hits.some((h: { text: string }) => /2 business days/.test(h.text)), JSON.stringify(hits));
    const config = (await agent.call(`/workspaces/${seeded.workspaceId}/agent`)).json;
    assert.equal(config.version, null, "never saved: built from the old settings");
    assert.match(config.files["AGENTS.md"], /Sign every answer with: Team Northwind\./);
    assert.deepEqual(config.issues, []);
  });
  await step("upgraded desk: new features work on old data (AI turn, onboarding, visitors)", async () => {
    const conv = await new Client().call(`/widget/${seeded.widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "How long does shipping take?" }, headers: { "X-Visitor-Token": seeded.visitorToken } });
    assert.equal(conv.status, 200, JSON.stringify(conv.json));
    const socket = new TestSocket(`/api/widget/${seeded.widgetKey}/conversations/${conv.json.conversation.id}/ws?since=1`, { protocols: [seeded.visitorToken] });
    await socket.opened;
    const event = await socket.next((e) => (e.type === "message" && e.message.authorType === "ai") || (e.type === "messages" && e.messages.some((m: { authorType: string }) => m.authorType === "ai")), 120_000);
    const answer = event.type === "message" ? event.message : event.messages.find((m: { authorType: string }) => m.authorType === "ai");
    socket.close();
    assert.match(answer.body, /2 business days|two business days/i, answer.body);
    const onboarding = (await agent.call(`/workspaces/${seeded.workspaceId}/onboarding`)).json;
    assert.equal(onboarding.steps.knowledge, true);
    assert.equal(onboarding.steps.ai, true);
    const live = new TestSocket(`/api/widget/${seeded.widgetKey}/live?s=upgrade12345678`, { headers: { Origin: "https://northwind.example" } });
    await live.opened;
    live.close();
  });
  summary();
} else {
  console.error("Usage: node scripts/upgrade-check.ts seed|verify [state.json]");
  process.exit(1);
}
