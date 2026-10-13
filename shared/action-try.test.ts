import { test } from "node:test";
import assert from "node:assert/strict";
import { cardFromResult, customerRefs, exampleData, exampleInputs, actionName, taskName, typedInput } from "./action-try.ts";
import { parseWidgetFile, renderWidget, widgetSchema } from "./widgets.ts";
import { checkData } from "./widget-schema.ts";

test("exampleData cuts lists and long text, and wraps a list as items", () => {
  const long = "x".repeat(400);
  const data = exampleData({ note: long, rows: [1, 2, 3, 4, 5, 6, 7] });
  assert.equal((data.note as string).length, 301);
  assert.deepEqual(data.rows, [1, 2, 3, 4, 5]);
  assert.deepEqual(exampleData([{ id: "A1" }]), { items: [{ id: "A1" }] });
});

test("cardFromResult draws the result with it as example data, with no pageActions", () => {
  const order = { id: "1234", status: "shipped", total: 42.5, lines: [{ name: "Mug", qty: 2 }] };
  const text = cardFromResult("Look up order", order)!;
  const file = JSON.parse(text) as Record<string, unknown>;
  assert.equal(file.pageActions, undefined);
  assert.deepEqual(file.sample, order);
  const spec = parseWidgetFile("look_up_order", text);
  assert.match(JSON.stringify(renderWidget(spec, order)), /shipped/);
  assert.deepEqual(checkData(widgetSchema(spec)!, order), []);
  // A list answer draws as its items.
  const list = cardFromResult("Orders", [{ id: "A1", status: "open" }])!;
  assert.match(JSON.stringify(renderWidget(parseWidgetFile("orders", list), { items: [{ id: "A1", status: "open" }] })), /A1/);
  assert.equal(cardFromResult("Plain", "text"), null);
});

test("typedInput keeps the action's types and leaves out empty fields", () => {
  assert.deepEqual(typedInput({ id: " 12 ", qty: "3", gift: "true", note: "" }, { id: "string", qty: "integer", gift: "boolean" }), { id: "12", qty: 3, gift: true });
});

test("customerRefs lists the {user.*} fields an action uses", () => {
  assert.deepEqual(customerRefs(["url: https://a.com/{user.id}?plan={user.plan}", "Authorization: Bearer {user.secrets.TOKEN} {user.id}"]), ["id", "plan", "secrets.TOKEN"]);
});

test("AI-26: Try it's details come back from the example the action was made from", () => {
  const action = { url: "https://api.acme.com/orders/{order_id}/lines/{line}", query: { expand: "{what}", fixed: "1" }, body: { reason: "{reason}", note: "x" } };
  const example = { url: "https://api.acme.com/orders/A%2D1042/lines/3", query: { expand: "items" }, body: { reason: "late", note: "x" } };
  assert.deepEqual(exampleInputs(action, example), { order_id: "A-1042", line: "3", what: "items", reason: "late" });
  assert.deepEqual(exampleInputs({ url: "https://a.io/x/{user.id}", query: {} }, { url: "https://a.io/x/9", query: {} }), {});
});

test("AI-26: a new action's name from what it should do", () => {
  assert.equal(actionName("Look up an order by its number"), "look_up_order");
  assert.equal(actionName("Refund the customer's last payment"), "refund_last_payment");
  assert.equal(actionName("!!!"), "new_action");
});

test("AI-27: a task's name from when it applies", () => {
  assert.equal(taskName("The customer asks where their order is"), "order");
  assert.equal(taskName("They want to change their plan"), "change-plan");
  assert.equal(taskName("Someone asks for a refund on a late order"), "refund-late-order");
  assert.equal(taskName("?"), "new-task");
});
