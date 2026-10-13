// End-to-end test of AI-21 page actions (D-40) against a running dev server, with real AI
// (E2E_AI_PROVIDER, default ChatGPT). Run after e2e-auth and e2e-ai (the AI is on by then).
//
// The widget sends the page's WebMCP tools with each message; the model may propose one; the
// visitor confirms, the page runs it and reports back; the card closes; agents get an audit row.
// Model answers vary, so the checks are about behaviour: the right action with the right input,
// no action when none was asked for, a `human` action handing off.

import assert from "node:assert/strict";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

// Knowledge search embeds the question through the remote Workers AI binding, which can take a while in local dev.
const AI_TIMEOUT = 300_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

/** What a pricing page would register: a WebMCP tool plus Jun extras. */
const pageActions = [
  {
    id: "upgrade_plan",
    name: "upgrade_plan",
    description: "Upgrade this account to a bigger plan",
    inputSchema: { type: "object", properties: { plan: { type: "string", enum: ["starter", "growth"], description: "The plan to move to" } }, required: ["plan"] },
    annotations: { consequentialHint: true },
    context: { currentPlan: "free" },
  },
  {
    id: "export_csv",
    name: "export_csv",
    description: "Download this month's usage as a CSV file",
    inputSchema: { type: "object", properties: {} },
    risk: "auto",
  },
  {
    id: "delete_account",
    name: "delete_account",
    description: "Delete this account and all its data",
    risk: "human",
  },
];

await step("owner signs in; the AI is on (ChatGPT login, or E2E_AI_PROVIDER)", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const res = await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, instructions: "Be brief.", monthlyReplyCap: 5000 } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
});

/** Starts a widget conversation whose first message carries the page's actions. */
async function startChat(question: string, actions: unknown = pageActions) {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: question, actions }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const conversationId = res.json.conversation.id as string;
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  return { conversationId, socket, visitor, token };
}

async function nextMessage(socket: TestSocket, match: (m: any) => boolean, timeoutMs = AI_TIMEOUT): Promise<any> {
  const event = await socket.next((e) => (e.type === "message" && match(e.message)) || (e.type === "messages" && e.messages.some(match)), timeoutMs);
  return event.type === "message" ? event.message : event.messages.find(match);
}

const handling = async (conversationId: string) => (await agent.call(`/conversations/${conversationId}`)).json.conversation.handling as string;

await step("asked to upgrade, the AI proposes the page's upgrade action with the plan filled in", async () => {
  const { conversationId, socket } = await startChat("Please upgrade my account to the growth plan.");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  console.log(`    AI: ${reply.body.replace(/\s+/g, " ").slice(0, 120)} → ${JSON.stringify(reply.meta.action && { name: reply.meta.action.name, input: reply.meta.action.input, missing: reply.meta.action.missing })}`);
  assert.equal(reply.authorType, "ai", `expected an AI reply, got ${reply.authorType}: ${reply.body}`);
  const action = reply.meta.action;
  assert.ok(action, "the reply should propose a page action");
  assert.equal(action.name, "upgrade_plan");
  assert.equal(action.status, "pending");
  assert.equal(action.risk, "confirm");
  assert.ok(reply.meta.followUps === undefined, "no follow-ups under a card");
  if (action.missing.includes("plan")) {
    // The model left the plan out: the visitor's answer fills it (checked server-side).
    socket.send({ type: "action_input", runId: action.runId, input: { plan: "Growth" } });
    const updated = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.missing.length === 0, 10_000);
    assert.equal(updated.meta.action.input.plan, "growth");
  } else {
    assert.equal(action.input.plan, "growth");
  }

  // The visitor confirms, the page runs it and reports back: the card shows Done, with Undo.
  socket.send({ type: "action_result", runId: action.runId, status: "ok", result: "Upgraded to Growth", canUndo: true });
  const done = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.status === "ok", 10_000);
  assert.equal(done.meta.action.result, "Upgraded to Growth");
  assert.equal(done.meta.action.canUndo, true);
  assert.equal(done.seq, reply.seq, "the same message, updated in place");

  // A second result for the same run changes nothing.
  socket.send({ type: "action_result", runId: action.runId, status: "error", result: "again" });
  await socket.none((e) => e.type === "message" && e.message.meta.action?.status === "error", 500);

  // Agents see the run in the audit log (AI-11), never visitors.
  const actions = (await agent.call(`/conversations/${conversationId}/actions`)).json.actions as { tool: string; status: string; output: string }[];
  const run = actions.find((a) => a.tool === "page:upgrade_plan");
  assert.ok(run, JSON.stringify(actions));
  assert.equal(run.status, "ok");
  assert.match(run.output, /Upgraded to Growth/);

  // Undo closes the loop.
  socket.send({ type: "action_result", runId: action.runId, status: "undone" });
  const undone = await nextMessage(socket, (m) => m.meta.action?.runId === action.runId && m.meta.action.status === "undone", 10_000);
  assert.equal(undone.meta.action.canUndo, false);
  const after = (await agent.call(`/conversations/${conversationId}/actions`)).json.actions as { tool: string }[];
  assert.ok(after.some((a) => a.tool === "undo:upgrade_plan"), JSON.stringify(after.map((a) => a.tool)));
  assert.equal(await handling(conversationId), "ai");
  socket.close();
});

await step("the next turn knows what the action did", async () => {
  const { socket, visitor, token, conversationId } = await startChat("Export my usage as a CSV please.");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(reply.authorType, "ai", reply.body);
  assert.equal(reply.meta.action?.name, "export_csv", JSON.stringify(reply.meta));
  assert.equal(reply.meta.action.risk, "auto");
  socket.send({ type: "action_result", runId: reply.meta.action.runId, status: "ok", result: "usage-2026-10.csv (18 rows)" });
  await nextMessage(socket, (m) => m.meta.action?.runId === reply.meta.action.runId && m.meta.action.status === "ok", 10_000);
  // The AI gets a follow-up turn with the result: here nothing more is needed, so a short confirmation.
  const followUp = await nextMessage(socket, (m) => m.authorType === "ai" && m.seq > reply.seq);
  console.log(`    AI (follow-up): ${followUp.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(followUp.clientMsgId, `ai:${reply.seq - 1}.1`, "the follow-up is keyed to the visitor message it continues");
  assert.equal(followUp.meta.action, undefined, "nothing more to do: no new action");
  const res = await visitor.call(`/widget/${widgetKey}/conversations/${conversationId}/messages`, {
    body: { clientMsgId: crypto.randomUUID(), body: "How many rows did that export have?", actions: pageActions },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const answer = await nextMessage(socket, (m) => m.authorType === "ai" && m.seq > followUp.seq);
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.match(answer.body, /18/);
  socket.close();
});

await step("a request that takes two actions: a lookup, then the step that uses its result", async () => {
  const booking = [
    { id: "search_places", name: "search_places", description: "Finds places matching a query; returns placeIds for set_pickup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
    { id: "set_pickup", name: "set_pickup", description: "Sets the pickup location from a placeId returned by search_places", inputSchema: { type: "object", properties: { placeId: { type: "string" } }, required: ["placeId"] } },
  ];
  const { socket, conversationId } = await startChat("Set my pickup to Changi Airport.", booking);
  const first = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  console.log(`    AI: ${first.body.replace(/\s+/g, " ").slice(0, 100)} → ${first.meta.action?.name} ${JSON.stringify(first.meta.action?.input)}`);
  assert.equal(first.meta.action?.name, "search_places", JSON.stringify(first.meta));
  assert.equal(first.meta.action.risk, "auto");
  // The page runs the lookup and returns JSON (for the AI, never shown as the Done line).
  socket.send({ type: "action_result", runId: first.meta.action.runId, status: "ok", result: JSON.stringify([{ placeId: "ChIJ_changi_t3", label: "Changi Airport Terminal 3" }]) });
  const second = await nextMessage(socket, (m) => m.authorType === "ai" && m.seq > first.seq);
  console.log(`    AI (follow-up): ${second.body.replace(/\s+/g, " ").slice(0, 100)} → ${second.meta.action?.name} ${JSON.stringify(second.meta.action?.input)}`);
  assert.equal(second.meta.action?.name, "set_pickup", "the follow-up turn proposes the next step");
  assert.equal(second.meta.action.input.placeId, "ChIJ_changi_t3", "with the id from the lookup");
  assert.equal(second.meta.action.risk, "confirm");
  socket.send({ type: "action_result", runId: second.meta.action.runId, status: "ok", result: "Pickup set to Changi Airport Terminal 3." });
  const third = await nextMessage(socket, (m) => m.authorType === "ai" && m.seq > second.seq);
  console.log(`    AI (done): ${third.body.replace(/\s+/g, " ").slice(0, 100)}`);
  assert.equal(third.meta.action, undefined, "done: no further action");
  const { messages } = (await agent.call(`/conversations/${conversationId}`)).json;
  const direct = messages.filter((m: { authorType: string; clientMsgId: string }) => m.authorType === "ai" && !/\.\d+$/.test(m.clientMsgId)).length;
  assert.equal(direct, 1, "the chain counts as one answer toward the reply cap");
  socket.close();
});

await step("a plain question about plans gets an answer, not an action", async () => {
  const { socket } = await startChat("Hi! What's the difference between the starter and growth plans?");
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  console.log(`    AI: ${reply.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(reply.meta.action, undefined, `no action should be proposed: ${JSON.stringify(reply.meta.action)}`);
  socket.close();
});

await step("an action marked human hands off to the team instead of running", async () => {
  const { conversationId, socket } = await startChat("Please delete my account and all my data right now.");
  const reply = await nextMessage(socket, (m) => m.authorType === "system" || (m.authorType === "ai" && m.meta.action));
  assert.equal(reply.authorType, "system", `expected a handoff, got: ${reply.body}`);
  assert.equal(await handling(conversationId), "human");
  socket.close();
});

await step("junk in the actions list is ignored, and a list that isn't one is too", async () => {
  const { socket } = await startChat("Please upgrade my account to the growth plan.", [{ nope: 1 }, "x", null, { name: "upgrade_plan" }]);
  const reply = await nextMessage(socket, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(reply.meta.action, undefined, "nothing to propose");
  socket.close();
  const { socket: s2 } = await startChat("Hello there", "not a list");
  const r2 = await nextMessage(s2, (m) => m.authorType === "ai" || m.authorType === "system");
  assert.equal(r2.meta.action, undefined);
  s2.close();
});

await step("W-31: a website action's result shows as a card: the page names one, or the desk picks one made from its shape", async () => {
  const cart = { total: 42.5, currency: "EUR", items: [{ title: "Mug", qty: 2 }, { title: "Tee", qty: 1 }] };
  const shop = [{ id: "get_cart", name: "get_cart", description: "The items in the customer's shopping cart and its total", inputSchema: { type: "object", properties: {} }, risk: "auto", widget: "cart_from_code" }];
  const ask = async () => {
    const chat = await startChat("What's in my shopping cart right now?", shop);
    const reply = await nextMessage(chat.socket, (m) => m.authorType === "ai" || m.authorType === "system");
    assert.equal(reply.meta.action?.name, "get_cart", JSON.stringify(reply.meta));
    assert.equal(reply.meta.action.widget, "cart_from_code", "the card the page named rides on the action");
    chat.socket.send({ type: "action_result", runId: reply.meta.action.runId, status: "ok", result: JSON.stringify(cart), data: JSON.stringify(cart) });
    const done = await nextMessage(chat.socket, (m) => m.meta.action?.runId === reply.meta.action.runId && m.meta.action.status === "ok", 10_000);
    return { ...chat, reply, done };
  };

  // No such widget yet: shown as before (no card), but the desk learns the action and its result's shape.
  const first = await ask();
  assert.equal(first.done.meta.widgets, undefined);
  first.socket.close();
  const seen = (await agent.call(`/workspaces/${workspaceId}/agent/page-actions`)).json.actions as { name: string; widget?: string; shape?: { properties: Record<string, unknown> } }[];
  const getCart = seen.find((a) => a.name === "get_cart");
  assert.ok(getCart?.shape, JSON.stringify(seen));
  assert.equal(getCart.widget, "cart_from_code");
  assert.deepEqual(Object.keys(getCart.shape.properties), ["total", "currency", "items"]);
  assert.ok(!/Mug|EUR|42\.5/.test(JSON.stringify(getCart.shape)), "the shape carries no values");
  const audit = (await agent.call(`/conversations/${first.conversationId}/actions`)).json.actions as { tool: string; output: string }[];
  assert.ok(audit.some((a) => a.tool === "page:get_cart"), JSON.stringify(audit));

  // The admin makes a card from that shape (the Agent page's "Make a card"): the desk's choice is drawn.
  const before = (await agent.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>;
  const { cardFromShape } = await import("../shared/widgets.ts");
  const files = { ...before, "widgets/cart.widget": cardFromShape("Cart", "get_cart", getCart.shape) };
  const saved = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: null, force: true, message: "cart card" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  try {
    const second = await ask();
    assert.equal(second.done.seq, second.reply.seq, "the same message, updated in place");
    assert.equal(second.done.meta.action.card, "cart");
    const card = second.done.meta.widgets?.[0];
    assert.equal(card?.name, "cart", JSON.stringify(second.done.meta));
    for (const value of ["Mug", "Tee", "EUR"]) assert.ok(JSON.stringify(card.root).includes(value), value);
    // The AI's follow-up turn is told the customer already sees it.
    const followUp = await nextMessage(second.socket, (m) => m.authorType === "ai" && m.seq > second.reply.seq);
    console.log(`    AI (follow-up): ${followUp.body.replace(/\s+/g, " ").slice(0, 120)}`);
    second.socket.close();
  } finally {
    await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: before, base: null, force: true, message: "x" } });
  }
});

await step("W-32: a card's page:<name> button offers that website action with the row's data; one the page doesn't offer is refused", async () => {
  const cart = { items: [{ id: "mug", title: "Mug" }, { id: "cap", title: "Cap" }] };
  const shop = [
    { id: "get_cart", name: "get_cart", description: "The items in the customer's shopping cart", inputSchema: { type: "object", properties: {} }, risk: "auto" },
    { id: "remove_from_cart", name: "remove_from_cart", description: "Remove an item from the cart", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ];
  const row = '{"type":"ListViewItem","children":[{"type":"Text","value":{{ item.title | tojson }}},{"type":"Button","label":"Remove","onClickAction":{"type":"page:remove_from_cart","payload":{"id":{{ item.id | tojson }}}}},{"type":"Button","label":"Save","onClickAction":{"type":"page:save_for_later","payload":{"id":{{ item.id | tojson }}}}}]}';
  const widget = { version: "1.0", name: "cart_rows", template: `{"type":"ListView","children":[{% for item in items %}{% if not loop.first %},{% endif %}${row}{% endfor %}]}`, sample: cart, pageActions: ["get_cart"] };
  const before = (await agent.call(`/workspaces/${workspaceId}/agent`)).json.files as Record<string, string>;
  const saved = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: { ...before, "widgets/cart_rows.widget": JSON.stringify(widget) }, base: null, force: true, message: "cart rows" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  try {
    const chat = await startChat("What's in my shopping cart right now?", shop);
    const reply = await nextMessage(chat.socket, (m) => m.authorType === "ai" || m.authorType === "system");
    assert.equal(reply.meta.action?.name, "get_cart", JSON.stringify(reply.meta));
    chat.socket.send({ type: "action_result", runId: reply.meta.action.runId, status: "ok", result: JSON.stringify(cart), data: JSON.stringify(cart) });
    const done = await nextMessage(chat.socket, (m) => m.meta.action?.runId === reply.meta.action.runId && m.meta.action.status === "ok", 10_000);
    const card = done.meta.widgets?.[0];
    assert.equal(card?.name, "cart_rows", JSON.stringify(done.meta));
    // Let the AI's follow-up to get_cart land first, so it isn't mistaken for the press's answer.
    await nextMessage(chat.socket, (m) => m.authorType === "ai" && m.seq > reply.seq).catch(() => null);

    // "Remove" on the second row: the press, then the action's card as the reply (confirm: it's consequential).
    const press = crypto.randomUUID();
    chat.socket.send({ type: "send", clientMsgId: press, body: "x", attachments: [], widgetAction: { messageId: done.id, widgetId: card.id, action: { type: "page:remove_from_cart", payload: { id: "cap" } }, item: "i1" }, actions: shop });
    const pressed = await nextMessage(chat.socket, (m) => m.clientMsgId === press, 10_000);
    assert.equal(pressed.body, "Remove");
    const offered = await nextMessage(chat.socket, (m) => m.authorType === "ai" && m.clientMsgId === `ai:${pressed.seq}`, 10_000);
    assert.deepEqual(
      { name: offered.meta.action.name, input: offered.meta.action.input, missing: offered.meta.action.missing, risk: offered.meta.action.risk, status: offered.meta.action.status, pressed: offered.meta.action.pressed },
      // D-73: the press is the yes: it runs at once (auto), no second Confirm.
      { name: "remove_from_cart", input: { id: "cap" }, missing: [], risk: "auto", status: "pending", pressed: true },
    );
    chat.socket.send({ type: "action_result", runId: offered.meta.action.runId, status: "ok", result: "Removed Cap" });
    await nextMessage(chat.socket, (m) => m.meta.action?.runId === offered.meta.action.runId && m.meta.action.status === "ok", 10_000);
    // No AI turn after it: the step row says what happened.
    const extra = await nextMessage(chat.socket, (m) => m.authorType === "ai" && m.seq > offered.seq, 8_000).catch(() => null);
    assert.equal(extra, null, `no AI turn after a button's action: ${extra?.body}`);
    const audit = (await agent.call(`/conversations/${chat.conversationId}/actions`)).json.actions as { tool: string; output: string }[];
    assert.ok(audit.some((a) => a.tool === "page:remove_from_cart" && a.output === "Removed Cap"), JSON.stringify(audit));

    // "Save" names an action this page doesn't offer: refused, and the row works again.
    const other = crypto.randomUUID();
    chat.socket.send({ type: "send", clientMsgId: other, body: "x", attachments: [], widgetAction: { messageId: done.id, widgetId: card.id, action: { type: "page:save_for_later", payload: { id: "mug" } }, item: "i0" }, actions: shop });
    const refused = await chat.socket.next((e) => e.type === "error" && e.clientMsgId === other, 10_000);
    assert.equal(refused.code, "action_failed");
    const latest = (await chat.visitor.call(`/widget/${widgetKey}/conversations/${chat.conversationId}`, { headers: { "X-Visitor-Token": chat.token } })).json.messages as any[];
    const items = latest.find((m) => m.id === done.id)?.meta.widgets?.[0]?.items ?? {};
    assert.deepEqual(Object.keys(items), ["i1"], "only the removed row is used");
    chat.socket.close();
  } finally {
    await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: before, base: null, force: true, message: "x" } });
  }
});

summary();
