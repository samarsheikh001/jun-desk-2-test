// End-to-end test of W-09 widgets (D-43) against a running dev server, with real AI
// (E2E_AI_PROVIDER, default ChatGPT). Run after e2e-auth (the owner exists).
//
// A tool with `widget:` shows its result as a ChatKit card: the card arrives on the tool's step
// while the reply is written and is saved with the answer. The visitor presses the card's button:
// the server checks the action against the card (forged ones and second presses are refused),
// keeps only the card's own fields, marks the card used, and the AI answers the press.
// httpbin.org stands in for the customer's API (it echoes the query back as `args`).

import assert from "node:assert/strict";
import { AI_PROVIDER, Client, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 300_000;
const agent = new Client();
let workspaceId = "";
let widgetKey = "";

// The plan card: the plan, its status, renewal, seats, a field and a confirm button (ChatKit's .widget v1.0).
const template = [
  '{"type":"Card","size":"sm",',
  '"confirm":{"label":"Cancel renewal","action":{"type":"renewal.cancel","payload":{"plan":{{ (args.plan) | tojson }}}}},',
  '"cancel":{"label":"Keep my plan","action":{"type":"renewal.keep"}},',
  '"children":[',
  '{"type":"Row","children":[{"type":"Title","value":{{ (args.plan ~ " plan") | tojson }},"size":"sm"},{"type":"Spacer"},',
  '{"type":"Badge","label":{{ (args.status) | tojson }},"color":{% if args.status == "active" %}"success"{% else %}"warning"{% endif %}}]},',
  '{"type":"Row","children":[{"type":"Caption","value":"Renews"},{"type":"Spacer"},{"type":"Text","value":{{ (args.renews_on) | tojson }},"size":"sm"}]},',
  '{"type":"Input","name":"reason","placeholder":"Why are you leaving? (optional)"}',
  "]}",
].join("");
const widgetFile = JSON.stringify({ version: "1.0", name: "Plan", template, sample: { args: { plan: "Pro", status: "active", renews_on: "Nov 3" } } });

const files = {
  "AGENTS.md": "# How to talk to customers\n\n- Be brief.\n- When the customer asks about their plan or subscription, call plan_status.\n- When they press a button on a card, confirm in one sentence what happens next.\n",
  "tools/plan_status.yaml": [
    "description: The customer's current plan, its status and renewal date.",
    "status: Checking your plan",
    "url: https://httpbin.org/anything",
    "query:",
    "  plan: Pro",
    "  status: active",
    "  renews_on: Nov 3, 2026",
    "pick: [args]",
    "widget: plan",
    "",
  ].join("\n"),
  "widgets/plan.widget": widgetFile,
};

await step("owner signs in; the AI is on; the config has a tool with a widget", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const ai = await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 5000 } });
  assert.equal(ai.status, 200, JSON.stringify(ai.json));

  // A tool pointing at a widget that isn't there is refused, by file.
  const bad = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: { ...files, "widgets/plan.widget": undefined }, base: null, force: true, message: "x" } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.json), /no widgets\/plan\.widget/);

  const res = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files, base: null, force: true, message: "plan card" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.summary.widgets, ["plan"]);
});

let conversationId = "";
let socket: TestSocket;
let answer: any;

await step("asked about their plan, the AI calls the tool and the visitor sees the card (live on the step, then saved)", async () => {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Which plan am I on?" }, headers: { "X-Visitor-Token": token } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  conversationId = res.json.conversation.id;
  socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const live = await socket.next((e) => e.type === "ai_step" && e.step.state === "done" && e.step.widget, AI_TIMEOUT);
  assert.equal(live.step.label, "Checking your plan");
  assert.equal(live.step.widget.name, "plan");
  const event = await socket.next((e) => e.type === "message" && e.message.authorType === "ai", AI_TIMEOUT);
  answer = event.message;
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(answer.meta.widgets?.length, 1, JSON.stringify(answer.meta));
  const card = answer.meta.widgets[0];
  assert.deepEqual(card, live.step.widget);
  assert.equal(card.root.type, "Card");
  assert.match(JSON.stringify(card.root), /"Pro plan".*"active".*"Nov 3, 2026"/);
  assert.equal(card.used, undefined);
});

await step("a forged action (one the card doesn't offer) is refused", async () => {
  const card = answer.meta.widgets[0];
  const clientMsgId = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId, body: "Refund me", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "refund.issue" } } });
  const err = await socket.next((e) => e.type === "error" && e.clientMsgId === clientMsgId);
  assert.equal(err.code, "bad_widget_action");
  // Same type, different payload: also refused.
  const other = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId: other, body: "x", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.cancel", payload: { plan: "Enterprise" } } } });
  assert.equal((await socket.next((e) => e.type === "error" && e.clientMsgId === other)).code, "bad_widget_action");
});

await step("pressing the card's button: the label is the message, only the card's fields are kept, the card is used, the AI answers", async () => {
  const card = answer.meta.widgets[0];
  const clientMsgId = crypto.randomUUID();
  socket.send({
    type: "send",
    clientMsgId,
    body: "anything the client says",
    attachments: [],
    widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.cancel", payload: { plan: "Pro" } }, values: { reason: "Too pricey", admin: "yes" } },
  });
  const used = await socket.next((e) => e.type === "message" && e.message.id === answer.id && e.message.meta.widgets?.[0]?.used);
  assert.equal(used.message.meta.widgets[0].used.label, "Cancel renewal");
  const sent = await socket.next((e) => e.type === "message" && e.message.clientMsgId === clientMsgId);
  assert.equal(sent.message.authorType, "visitor");
  assert.equal(sent.message.body, "Cancel renewal");
  assert.deepEqual(sent.message.meta.widgetAction, { widgetId: card.id, widget: "plan", type: "renewal.cancel", payload: { plan: "Pro" }, values: { reason: "Too pricey" } });

  const again = crypto.randomUUID();
  socket.send({ type: "send", clientMsgId: again, body: "x", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "renewal.keep" } } });
  assert.equal((await socket.next((e) => e.type === "error" && e.clientMsgId === again)).code, "widget_used");

  const reply = await socket.next((e) => e.type === "message" && (e.message.authorType === "ai" || e.message.authorType === "system") && e.message.seq > sent.message.seq, AI_TIMEOUT);
  console.log(`    ${reply.message.authorType}: ${reply.message.body.replace(/\s+/g, " ").slice(0, 140)}`);
});

await step("agents see the card and what was entered in the conversation", async () => {
  const messages = (await agent.call(`/conversations/${conversationId}`)).json.messages as any[];
  const ai = messages.find((m) => m.id === answer.id);
  assert.equal(ai.meta.widgets[0].used.label, "Cancel renewal");
  assert.ok(messages.some((m) => m.meta.widgetAction?.values?.reason === "Too pricey"));
  socket.close();
});

// ---------- W-17: a list with an action per row (a tool button), links, and a card the tool returns ----------

// httpbin echoes a POST body back as `json`: the product list, and the cart after an add.
const dresses = [
  '{"type":"ListView","children":[',
  '{%- for p in json.products -%}{% if not loop.first %},{% endif %}',
  '{"type":"ListViewItem","children":[{"type":"Col","flex":"auto","children":[{"type":"Text","value":{{ p.name | tojson }},"weight":"semibold"},{"type":"Caption","value":{{ p.price | tojson }}}]},',
  '{"type":"Button","label":"View","size":"sm","variant":"ghost","onClickAction":{"type":"open_url","payload":{"url":{{ ("https://shop.example.com/p/" ~ p.sku) | tojson }}}}},',
  '{"type":"Button","label":"Add","size":"sm","onClickAction":{"type":"tool:add_to_cart","payload":{"sku":{{ p.sku | tojson }}}}}]}',
  "{%- endfor -%}]}",
].join("");
const cart = '{"type":"Card","size":"sm","children":[{"type":"Row","children":[{"type":"Icon","name":"check-circle-filled","color":"success"},{"type":"Text","value":{{ ("Added " ~ json.sku ~ " to your cart") | tojson }}}]}]}';
const shopFiles = {
  ...files,
  "AGENTS.md": `${files["AGENTS.md"]}- When the customer asks to see dresses or products, call find_dresses.\n`,
  "tools/find_dresses.yaml": [
    "description: The dresses in the shop, with prices.",
    "status: Finding dresses",
    "method: POST",
    "url: https://httpbin.org/anything",
    "body:",
    "  products:",
    "    - { sku: R1, name: Red linen dress, price: $89 }",
    "    - { sku: B2, name: Blue midi dress, price: $120 }",
    "    - { sku: G3, name: Green wrap dress, price: $99 }",
    "pick: [json]",
    "widget: dresses",
    "",
  ].join("\n"),
  "tools/add_to_cart.yaml": ["description: Add a product to the customer's cart.", "status: Adding to your cart", "method: POST", "url: https://httpbin.org/anything", "input:", "  sku: { type: string }", "pick: [json]", "widget: cart", ""].join("\n"),
  "widgets/dresses.widget": JSON.stringify({ version: "1.0", name: "Dresses", template: dresses, sample: { json: { products: [{ sku: "R1", name: "Red", price: "$1" }] } } }),
  "widgets/cart.widget": JSON.stringify({ version: "1.0", name: "Cart", template: cart, sample: { json: { sku: "R1" } } }),
};

let shopSocket: TestSocket;
let list: any;

await step("W-17: a product list; each row's Add button names a tool, which must exist", async () => {
  const bad = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: { ...shopFiles, "tools/add_to_cart.yaml": undefined }, base: null, force: true, message: "x" } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.json), /tool:add_to_cart: there's no tools\/add_to_cart\.yaml/);
  const res = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: shopFiles, base: null, force: true, message: "shop" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const started = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Can you show me your dresses?" }, headers: { "X-Visitor-Token": token } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  shopSocket = new TestSocket(`/api/widget/${widgetKey}/conversations/${started.json.conversation.id}/ws?since=1`, { protocols: [token] });
  await shopSocket.opened;
  list = (await shopSocket.next((e) => e.type === "message" && e.message.authorType === "ai", AI_TIMEOUT)).message;
  console.log(`    AI: ${list.body.replace(/\s+/g, " ").slice(0, 120)}`);
  assert.equal(list.meta.widgets?.[0]?.name, "dresses", JSON.stringify(list.meta));
  assert.equal(list.meta.widgets[0].root.children.length, 3);
});

await step("W-17: Add on one row runs the tool at once; only that row is used; the AI answers with the tool's cart card", async () => {
  const card = list.meta.widgets[0];
  const press = (sku: string, item: string) => {
    const clientMsgId = crypto.randomUUID();
    shopSocket.send({ type: "send", clientMsgId, body: "Add", attachments: [], widgetAction: { messageId: list.id, widgetId: card.id, action: { type: "tool:add_to_cart", payload: { sku } }, values: {}, item } });
    return clientMsgId;
  };
  // A link is never sent: the browser opens it.
  const link = crypto.randomUUID();
  shopSocket.send({ type: "send", clientMsgId: link, body: "View", attachments: [], widgetAction: { messageId: list.id, widgetId: card.id, action: { type: "open_url", payload: { url: "https://shop.example.com/p/R1" } }, item: "i0" } });
  assert.equal((await shopSocket.next((e) => e.type === "error" && e.clientMsgId === link)).code, "bad_widget_action");

  const first = press("B2", "i1");
  const used = await shopSocket.next((e) => e.type === "message" && e.message.id === list.id && e.message.meta.widgets?.[0]?.items?.i1);
  assert.equal(used.message.meta.widgets[0].used, undefined, "the card itself stays usable");
  const sent = (await shopSocket.next((e) => e.type === "message" && e.message.clientMsgId === first)).message;
  assert.equal(sent.body, "Add");
  assert.deepEqual(sent.meta.widgetAction.tool, { name: "add_to_cart", status: "ok" }, "the tool ran; its output isn't in the visitor's copy");
  assert.equal(sent.meta.widgetAction.item, "i1");

  const again = press("B2", "i1");
  assert.equal((await shopSocket.next((e) => e.type === "error" && e.clientMsgId === again)).code, "widget_used");

  const reply = (await shopSocket.next((e) => e.type === "message" && (e.message.authorType === "ai" || e.message.authorType === "system") && e.message.seq > sent.seq, AI_TIMEOUT)).message;
  console.log(`    ${reply.authorType}: ${reply.body.replace(/\s+/g, " ").slice(0, 140)}`);
  assert.equal(reply.authorType, "ai");
  assert.equal(reply.meta.widgets?.[0]?.name, "cart", JSON.stringify(reply.meta));
  assert.match(JSON.stringify(reply.meta.widgets[0].root), /Added B2 to your cart/);

  // Another row still works.
  const second = press("R1", "i0");
  const ok = (await shopSocket.next((e) => e.type === "message" && e.message.clientMsgId === second)).message;
  assert.equal(ok.meta.widgetAction.item, "i0");
  shopSocket.close();
});

// ---------- D-51: ChatKit's onChangeAction (a tool, run quietly) and handler: "client" ----------

// httpbin echoes the POST body as `json`: the quote for the seats asked, re-rendered when the picker changes.
const quote = [
  '{"type":"Card","size":"sm","children":[',
  '{"type":"Title","value":{{ ("$" ~ (((json.seats | default(5)) | int) * 12) ~ " / month") | tojson }}},',
  '{"type":"Select","name":"seats","defaultValue":{{ ((json.seats | default(5)) | string) | tojson }},"options":[{"label":"1","value":"1"},{"label":"5","value":"5"},{"label":"10","value":"10"}],"onChangeAction":{"type":"tool:seat_quote"}},',
  '{"type":"Button","label":"See pricing","onClickAction":{"type":"pricing.open","handler":"client"}}',
  "]}",
].join("");
const quoteFiles = {
  ...files,
  "AGENTS.md": `${files["AGENTS.md"]}- When the customer asks what seats cost, call seat_quote.\n`,
  "tools/seat_quote.yaml": ["description: A price quote for a number of seats.", "status: Getting a quote", "method: POST", "url: https://httpbin.org/anything", "input:", "  seats: { type: integer }", "pick: [json]", "widget: seat_quote", ""].join("\n"),
  "widgets/seat_quote.widget": JSON.stringify({ version: "1.0", name: "Seat quote", template: quote, sample: { json: { seats: 5 } } }),
};

await step("D-51: a field's onChangeAction runs its tool quietly and the card is replaced in place; forged changes and client actions are refused", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: quoteFiles, base: null, force: true, message: "quote" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const started = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "What would 5 seats cost? Show me a quote." }, headers: { "X-Visitor-Token": token } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const s = new TestSocket(`/api/widget/${widgetKey}/conversations/${started.json.conversation.id}/ws?since=1`, { protocols: [token] });
  await s.opened;
  const answer = (await s.next((e) => e.type === "message" && e.message.authorType === "ai", AI_TIMEOUT)).message;
  const card = answer.meta.widgets?.[0];
  assert.equal(card?.name, "seat_quote", JSON.stringify(answer.meta));
  const change = (field: string, action: unknown, values: Record<string, string>) => {
    const requestId = crypto.randomUUID();
    s.send({ type: "widget_change", requestId, messageId: answer.id, widgetId: card.id, field, action, values });
    return s.next((e) => e.type === "widget_change_done" && e.requestId === requestId);
  };
  // A change the card doesn't offer (wrong field, or a tool it doesn't name) is refused.
  assert.equal((await change("plan", { type: "tool:seat_quote" }, { seats: "10" })).ok, false);
  assert.equal((await change("seats", { type: "tool:add_to_cart" }, { seats: "10" })).ok, false);
  // A client action never goes to the server: as a press it's refused.
  const press = crypto.randomUUID();
  s.send({ type: "send", clientMsgId: press, body: "See pricing", attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type: "pricing.open" } } });
  assert.equal((await s.next((e) => e.type === "error" && e.clientMsgId === press)).code, "bad_widget_action");

  await new Promise((r) => setTimeout(r, 500)); // the per-card gap between change runs
  const updated = s.next((e) => e.type === "message" && e.message.id === answer.id && JSON.stringify(e.message.meta.widgets?.[0]?.root ?? {}).includes("$120 / month"), 60_000);
  const done = await change("seats", { type: "tool:seat_quote" }, { seats: "10", admin: "x" });
  assert.equal(done.ok, true, done.message);
  const msg = (await updated).message;
  assert.equal(msg.meta.widgets[0].id, card.id, "the card keeps its id");
  assert.equal(msg.meta.widgets[0].used, undefined, "a change doesn't use the card");
  // No new message (visitor's or the AI's) came of it.
  await assert.rejects(s.next((e) => e.type === "message" && e.message.seq > answer.seq, 3000), /Timed out/);
  s.close();
});

// ---------- W-27: an action's own lines for the card (widget_done / widget_failed) ----------

// A small "talk to sales" form: Submit books the demo (httpbin echoes the POST); "Try the old form"
// runs an action whose API fails (HTTP 500).
const demo = [
  '{"type":"Card","size":"sm","children":[',
  '{"type":"Title","value":"Talk to sales","size":"sm"},',
  '{"type":"Input","name":"name","placeholder":"Your name"},',
  '{"type":"Input","name":"email","placeholder":"Work email"},',
  '{"type":"Row","children":[{"type":"Button","label":"Book a demo","onClickAction":{"type":"tool:book_demo"}},',
  '{"type":"Button","label":"Try the old form","variant":"outline","onClickAction":{"type":"tool:old_form"}},',
  '{"type":"Button","label":"Close","variant":"ghost","onClickAction":{"type":"dismiss"}}]}',
  "]}",
].join("");
const demoFiles = {
  ...files,
  "AGENTS.md": `${files["AGENTS.md"]}- When the customer wants to talk to sales or book a demo, call sales_form.\n`,
  "tools/sales_form.yaml": ["description: Shows the customer a form to book a demo with sales.", "status: Opening the form", "url: https://httpbin.org/anything", "widget: demo", ""].join("\n"),
  "tools/book_demo.yaml": [
    "description: Books a demo with sales.",
    "method: POST",
    "url: https://httpbin.org/anything",
    "input:",
    "  name: { type: string }",
    "  email: { type: string }",
    "body: { name: \"{name}\", email: \"{email}\" }",
    'widget_done: "Thanks {{ json.name }}, we\'ll email {{ email }} today."',
    "",
  ].join("\n"),
  "tools/old_form.yaml": ["description: The old sales form.", "method: POST", "url: https://httpbin.org/status/500", "input:", "  name: { type: string }", 'widget_failed: "Sorry {{ name }}, that didn\'t go through. Try Book a demo."', ""].join("\n"),
  "widgets/demo.widget": JSON.stringify({ version: "1.0", name: "Talk to sales", template: demo, sample: {} }),
};

await step("W-27: widget_failed keeps the card open with its line (nothing sent); widget_done folds it and the AI doesn't answer; dismiss is never sent", async () => {
  const res = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: demoFiles, base: null, force: true, message: "demo" } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const started = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "I'd like to book a demo with your sales team." }, headers: { "X-Visitor-Token": token } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const conversation = started.json.conversation.id as string;
  const s = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversation}/ws?since=1`, { protocols: [token] });
  await s.opened;
  const answer = (await s.next((e) => e.type === "message" && e.message.authorType === "ai", AI_TIMEOUT)).message;
  const card = answer.meta.widgets?.[0];
  assert.equal(card?.name, "demo", JSON.stringify(answer.meta));
  const press = (type: string, label: string) => {
    const clientMsgId = crypto.randomUUID();
    s.send({ type: "send", clientMsgId, body: label, attachments: [], widgetAction: { messageId: answer.id, widgetId: card.id, action: { type }, values: { name: "Sam", email: "sam@acme.test" } } });
    return clientMsgId;
  };

  // dismiss stays in the browser.
  const close = press("dismiss", "Close");
  assert.equal((await s.next((e) => e.type === "error" && e.clientMsgId === close)).code, "bad_widget_action");

  // The failing action: its line comes back as the error, and the card opens again.
  const old = press("tool:old_form", "Try the old form");
  const reopened = s.next((e) => e.type === "message" && e.message.id === answer.id && !e.message.meta.widgets[0].used);
  const failed = await s.next((e) => e.type === "error" && e.clientMsgId === old, 60_000);
  assert.equal(failed.code, "action_failed");
  assert.equal(failed.message, "Sorry Sam, that didn't go through. Try Book a demo.");
  await reopened;

  // The booking: its line folds the card; the visitor's press is saved as answered; no AI turn.
  const book = press("tool:book_demo", "Book a demo");
  const folded = s.next((e) => e.type === "message" && e.message.id === answer.id && e.message.meta.widgets[0].used?.label === "Thanks Sam, we'll email sam@acme.test today.", 60_000);
  const sent = (await s.next((e) => e.type === "message" && e.message.clientMsgId === book, 60_000)).message;
  assert.equal(sent.body, "Book a demo");
  assert.deepEqual(sent.meta.widgetAction.tool, { name: "book_demo", status: "ok", done: "Thanks Sam, we'll email sam@acme.test today." }, JSON.stringify((await agent.call(`/conversations/${conversation}/actions`)).json).slice(0, 1500));
  await folded;
  await assert.rejects(s.next((e) => e.type === "message" && e.message.seq > sent.seq, 8000), /Timed out/);

  // Agents see both runs in the audit log, and the AI's next turn knows what happened.
  const actions = (await agent.call(`/conversations/${conversation}/actions`)).json;
  const tools = JSON.stringify(actions);
  assert.ok(tools.includes("old_form") && tools.includes("book_demo"), tools.slice(0, 400));
  s.close();
});

summary();
