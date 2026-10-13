import { test } from "node:test";
import assert from "node:assert/strict";
import { testCaseFrom, type TestTurn } from "./test-chat.ts";

const card = { id: "w1", name: "order_status", root: { type: "Card", children: [] } };

test("AI-29: a test chat becomes a test case: what the customer said, what the last reply did", () => {
  const turns: TestTurn[] = [
    { role: "customer", text: "where is my order?" },
    { role: "ai", reply: { text: "What's the order number?", widgets: [], calls: [] } },
    { role: "customer", text: "1042" },
    { role: "ai", reply: { text: "It's on its way.", widgets: [card], calls: [{ tool: "look_up_order", status: "ok", httpStatus: 200, output: "{}" }, { tool: "look_up_order", status: "ok", httpStatus: 200, output: "{}" }] } },
  ];
  assert.deepEqual(testCaseFrom("Order: where is my order?", turns, "/orders"), {
    name: "Order: where is my order?",
    messages: ["where is my order?", "1042"],
    page: "/orders",
    expect: { outcome: "answer", tools: ["look_up_order"], widget: "order_status" },
  });
});

test("AI-29: one message, a handoff or a website action", () => {
  const handoff: TestTurn[] = [{ role: "customer", text: "I want a refund" }, { role: "ai", reply: { text: "", handoff: "refund", widgets: [], calls: [] } }];
  assert.deepEqual(testCaseFrom("Refund", handoff, null), { name: "Refund", message: "I want a refund", expect: { outcome: "handoff" } });
  const action: TestTurn[] = [{ role: "customer", text: "dark mode please" }, { role: "ai", reply: { text: "", widgets: [], calls: [], pageAction: { name: "set_theme", input: { theme: "dark" } } } }];
  assert.deepEqual(testCaseFrom("Theme", action, null)?.expect, { outcome: "action", action: { name: "set_theme" } });
  assert.equal(testCaseFrom("Nothing", [{ role: "customer", text: "hi" }], null), null);
});
