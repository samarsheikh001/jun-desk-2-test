import assert from "node:assert/strict";
import { test } from "node:test";
import { actionCallId, actionChip, actionInputSchema, actionTitle, actionSummary, actionToolResult, checkInput, describePageAction, matchesPage, MAX_PAGE_ACTIONS, MAX_PAGE_ACTIONS_INTAKE, rankActions, sanitizeActions, toolSlug, type MessageAction } from "./actions.ts";

const addToCart = {
  id: "add_to_cart#p1",
  name: "add_to_cart",
  description: "Add Blue Runner to the cart",
  inputSchema: {
    type: "object",
    properties: {
      size: { type: "string", enum: ["M", "L"] },
      quantity: { type: "integer", minimum: 1, maximum: 5, description: "How many" },
      gift: { type: "boolean" },
    },
    required: ["size", "nope"],
  },
  annotations: { consequentialHint: true },
  context: { price: 89, currency: "USD" },
};

test("sanitizeActions: keeps the WebMCP shape, normalises params, defaults the risk to confirm", () => {
  const [a] = sanitizeActions([addToCart]);
  assert.ok(a);
  assert.equal(a.id, "add_to_cart#p1");
  assert.equal(a.tool, "pa_add_to_cart");
  assert.equal(a.risk, "confirm");
  assert.deepEqual(Object.keys(a.params), ["size", "quantity", "gift"]);
  assert.deepEqual(a.params.size, { type: "string", enum: ["M", "L"] });
  assert.deepEqual(a.params.quantity, { type: "integer", description: "How many", minimum: 1, maximum: 5 });
  assert.deepEqual(a.required, ["size"], "required names that aren't params are dropped");
  assert.deepEqual(a.context, { price: 89, currency: "USD" });
});

test("sanitizeActions: risk from the annotations or an explicit risk", () => {
  const list = sanitizeActions([
    { name: "a", description: "d", annotations: { readOnlyHint: true } },
    { name: "b", description: "d", risk: "auto", annotations: { consequentialHint: true } },
    { name: "c", description: "d", risk: "human" },
    { name: "d", description: "d" },
  ]);
  assert.deepEqual(
    list.map((a) => a.risk),
    ["auto", "auto", "human", "confirm"],
  );
});

test("sanitizeActions: junk in, nothing out", () => {
  assert.deepEqual(sanitizeActions(undefined), []);
  assert.deepEqual(sanitizeActions("x"), []);
  assert.deepEqual(sanitizeActions([null, 1, {}, { name: "x" }, { description: "no name" }]), []);
});

test("sanitizeActions: one-line text, caps, control characters out", () => {
  const [a] = sanitizeActions([
    {
      name: "x",
      description: `Line one\nline two\u0000 ${"y".repeat(400)}`,
      inputSchema: { properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { type: "string" }])) },
      context: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "v".repeat(200)])),
    },
  ]);
  assert.ok(a);
  assert.equal(a.description.length, 200);
  assert.ok(a.description.startsWith("Line one line two "));
  assert.equal(Object.keys(a.params).length, 12);
  assert.equal(Object.keys(a.context).length, 8);
  assert.equal(a.context.k0, "v".repeat(80));
});

test("sanitizeActions: a later duplicate id replaces the earlier one; the list is capped", () => {
  const list = sanitizeActions([
    { id: "same", name: "first", description: "old" },
    { id: "same", name: "first", description: "new" },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.description, "new");
  const many = sanitizeActions(Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, name: "add", description: "d" })));
  assert.equal(many.length, MAX_PAGE_ACTIONS_INTAKE);
});

test("rankActions: what the question names first, then what's on screen, then registration order; capped", () => {
  const list = sanitizeActions([
    { id: "a", name: "export_csv", description: "Download this month's usage as a CSV file" },
    { id: "b", name: "upgrade_plan", description: "Change this account's plan", context: { currentPlan: "team" } },
    { id: "c", name: "add_to_cart", description: "Add Blue Runner to the cart", visible: true },
    { id: "d", name: "book_demo", description: "Book a demo with sales" },
  ]);
  assert.deepEqual(
    rankActions(list, "please upgrade my plan").map((a) => a.id),
    ["b", "c", "a", "d"],
    "the one the question names first, then what's on screen",
  );
  assert.deepEqual(
    rankActions(list, "hello").map((a) => a.id),
    ["c", "a", "b", "d"],
  );
  const many = sanitizeActions(Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, name: `act${i}`, description: i === 49 ? "Rename the unicorn" : `Action number ${i}` })));
  const ranked = rankActions(many, "rename my unicorn");
  assert.equal(ranked.length, MAX_PAGE_ACTIONS);
  assert.equal(ranked[0]!.id, "a49");
});

test("matchesPage: exact paths and * prefixes; no patterns means everywhere, no path means nowhere", () => {
  assert.equal(matchesPage(undefined, "/x"), true);
  assert.equal(matchesPage([], null), true);
  assert.equal(matchesPage(["/pricing"], "/pricing"), true);
  assert.equal(matchesPage(["/pricing"], "/pricing/pro"), false);
  assert.equal(matchesPage(["/plans/*"], "/plans/pro"), true);
  assert.equal(matchesPage(["/plans/*"], "/plans/"), true);
  assert.equal(matchesPage(["/plans/*"], "/plan"), false);
  assert.equal(matchesPage(["/pricing"], null), false);
});

test("tool names: a safe slug per registered name, suffixed when instances share a name", () => {
  assert.equal(toolSlug("Add to cart!"), "pa_add_to_cart");
  assert.equal(toolSlug("***"), "pa_action");
  const list = sanitizeActions([
    { id: "add#1", name: "add_to_cart", description: "A" },
    { id: "add#2", name: "add_to_cart", description: "B" },
    { id: "add#3", name: "add_to_cart", description: "C" },
  ]);
  assert.deepEqual(
    list.map((a) => a.tool),
    ["pa_add_to_cart", "pa_add_to_cart_2", "pa_add_to_cart_3"],
  );
});

test("actionInputSchema: every param optional for the model, required ones marked in the description", () => {
  const [a] = sanitizeActions([addToCart]);
  const schema = actionInputSchema(a!) as { properties: Record<string, { description?: string }>; required: string[] };
  assert.deepEqual(schema.required, []);
  assert.match(schema.properties.size!.description!, /required; leave out/);
  assert.equal(schema.properties.gift!.description, undefined);
});

test("checkInput: coerces, validates, finds what's missing", () => {
  const [a] = sanitizeActions([addToCart]);
  const ok = checkInput(a!, { size: "m", quantity: "2", gift: "false", extra: 1 });
  assert.deepEqual(ok.input, { size: "M", quantity: 2, gift: false });
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.errors, {});

  const bad = checkInput(a!, { size: "XL", quantity: 9 });
  assert.deepEqual(bad.input, {});
  assert.deepEqual(bad.missing, ["size"]);
  assert.equal(bad.errors.size, "must be one of M, L");
  assert.equal(bad.errors.quantity, "must be at most 5");

  assert.deepEqual(checkInput(a!, undefined).missing, ["size"]);
  assert.equal(checkInput(a!, { quantity: 2.5 }).errors.quantity, "must be a whole number");
});

test("describePageAction and actionSummary read as one line each", () => {
  const [a] = sanitizeActions([addToCart]);
  assert.equal(describePageAction(a!), "pa_add_to_cart: Add Blue Runner to the cart (price: 89, currency: USD) [inputs: size, quantity, gift]");
  assert.equal(actionSummary({ description: "Add Blue Runner to the cart", input: { size: "M", quantity: 2 } }), "Add Blue Runner to the cart · size: M · quantity: 2");
  assert.equal(actionSummary({ description: "Book a demo", input: {} }), "Book a demo");
  assert.equal(actionSummary({ description: "Set the pickup from a placeId", input: { placeId: "ChIJuU9qyPgb2jERidqJVhPuyUw", note: "front door" } }), "Set the pickup from a placeId · note: front door");
});

test("actionCallId: 9 alphanumeric characters, stable, distinct per run", () => {
  const a = actionCallId("run_TI5a-aft-bvHx_hp");
  assert.match(a, /^[a-z0-9]{9}$/);
  assert.equal(a, actionCallId("run_TI5a-aft-bvHx_hp"));
  assert.notEqual(a, actionCallId("run_TI5a-aft-bvHx_hq"));
  assert.match(actionCallId("x"), /^[a-z0-9]{9}$/);
});

test("actionToolResult: what the model gets as the tool result of a past card", () => {
  const base: MessageAction = {
    runId: "run_1",
    id: "add_to_cart#p1",
    name: "add_to_cart",
    description: "Add Blue Runner to the cart",
    risk: "confirm",
    params: {},
    required: [],
    input: { size: "M" },
    missing: [],
    status: "pending",
    result: null,
    canUndo: false,
  };
  assert.equal(actionToolResult(base), "Waiting for the customer to confirm it in the chat.");
  assert.equal(actionToolResult({ ...base, status: "ok", result: "Added 1 × M" }), "Added 1 × M");
  assert.equal(actionToolResult({ ...base, status: "ok" }), "Done.");
  assert.equal(actionToolResult({ ...base, status: "error", result: "Out of stock" }), "Failed: Out of stock");
  assert.equal(actionToolResult({ ...base, status: "gone" }), "No longer available (the customer left the page); it did not run.");
  assert.equal(actionToolResult({ ...base, status: "undone", result: "Added 1 × M" }), "Ran (Added 1 × M), then the customer undid it.");
});

test("actionTitle and actionChip: a short row title and the one thing worth showing beside it", () => {
  assert.equal(actionTitle("search_places"), "Search places");
  assert.equal(actionTitle("getBookingForm"), "Get booking form");
  assert.equal(actionTitle("add-to-cart"), "Add to cart");
  assert.equal(actionTitle("__"), "Page action");
  assert.equal(actionChip({ input: { query: "Anchorvale Street" }, status: "pending", result: null }), "Anchorvale Street");
  assert.equal(actionChip({ input: { placeId: "ChIJb9cqIPwX2jERNUBseVef4Y0" }, status: "pending", result: null }), null);
  assert.equal(actionChip({ input: { query: "Siloso" }, status: "ok", result: "Destination set to 10A Siloso Bch Walk." }), "Destination set to 10A Siloso Bch Walk.");
  assert.equal(actionChip({ input: { query: "Siloso" }, status: "ok", result: '[{"placeId":"x"}]' }), "Siloso");
  assert.equal(actionChip({ input: { size: "M", quantity: 2 }, status: "error", result: "Out of stock" }), "M · 2");
});
