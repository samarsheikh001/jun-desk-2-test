import assert from "node:assert/strict";
import { test } from "node:test";
import { actionToolResult, resultShape, sanitizeActions, type MessageAction } from "./actions.ts";
import { cardControls, cardFromShape, matchWidgetAction, pickOpenWidget, widgetWaiting, PAGE_ACTION_BUTTON, pageActionCard, pageActionWidget, parseWidgetFile, renderWidget, toolActionInput, WIDGET_SHOWN_NOTE, WidgetError } from "./widgets.ts";
import { widgetPageButtons } from "./agent-links.ts";

const cart = {
  total: 42.5,
  currency: "EUR",
  paid: false,
  customer: { name: "Ana", tier: "gold" },
  items: [
    { title: "Mug", qty: 2 },
    { title: "Tee", qty: 1 },
  ],
  tags: ["gift"],
  "ana@example.com": { note: "a key that's data" },
};

test("W-31: a result's shape keeps field names and types, never values or keys that look like data", () => {
  const shape = resultShape(cart);
  assert.ok(shape);
  const text = JSON.stringify(shape);
  for (const value of ["42.5", "EUR", "Ana", "gold", "Mug", "gift", "example.com"]) assert.ok(!text.includes(value), value);
  assert.deepEqual(shape.properties && Object.keys(shape.properties as object), ["total", "currency", "paid", "customer", "items", "tags"]);
  assert.equal(resultShape("plain text"), null);
  assert.equal(resultShape(null), null);
  assert.deepEqual(resultShape([{ a: 1 }]), { type: "array", items: { type: "object", properties: { a: { type: "number" } } } });
});

test("W-31: a first card made from the shape draws with its example data and with the real result", () => {
  const file = cardFromShape("Get cart", "get_cart", resultShape(cart)!);
  const spec = parseWidgetFile("get_cart", file);
  assert.deepEqual(spec.pageActions, ["get_cart"]);
  const real = JSON.stringify(renderWidget(spec, cart));
  for (const value of ["42.5", "EUR", "Ana", "Mug", "Tee", "gift"]) assert.ok(real.includes(value), value);
  renderWidget(spec, spec.sample);
  renderWidget(spec, {}); // fields missing: still draws
  // A list result is the card's `items`.
  const list = parseWidgetFile("orders", cardFromShape("Orders", "list_orders", resultShape([{ id: "A1", status: "shipped" }])!));
  assert.ok(JSON.stringify(renderWidget(list, [{ id: "A1", status: "shipped" }])).includes("shipped"));
});

test("W-31: the desk's choice of card wins over the page's; the result must be JSON that draws", () => {
  const shows = parseWidgetFile("cart", cardFromShape("Cart", "get_cart", resultShape(cart)!));
  const named = parseWidgetFile("named", cardFromShape("Named", "other", resultShape(cart)!));
  assert.equal(pageActionWidget([named, shows], "get_cart", "named"), shows);
  assert.equal(pageActionWidget([named], "get_cart", "named"), named);
  assert.equal(pageActionWidget([named], "get_cart", "missing"), null);
  assert.equal(pageActionWidget([named], "get_cart", undefined), null);

  const ok = pageActionCard(shows, JSON.stringify(cart), "wp1");
  assert.ok("card" in ok && ok.card.name === "cart" && ok.card.id === "wp1");
  assert.ok("error" in pageActionCard(shows, undefined, "wp1"));
  assert.ok("error" in pageActionCard(shows, "not json", "wp1"));
  assert.ok("error" in pageActionCard(shows, '"a string"', "wp1"));
  assert.ok("error" in pageActionCard(shows, `{"x":"${"a".repeat(40_000)}"}`, "wp1"));
});

test("W-31: pageActions on a widget file is a list of names", () => {
  const base = { version: "1.0", template: '{"type":"Card","children":[]}' };
  assert.deepEqual(parseWidgetFile("w", JSON.stringify({ ...base, pageActions: [" get_cart ", "get_cart"] })).pageActions, ["get_cart"]);
  assert.throws(() => parseWidgetFile("w", JSON.stringify({ ...base, pageActions: "get_cart" })), WidgetError);
  assert.throws(() => parseWidgetFile("w", JSON.stringify({ ...base, pageActions: [""] })), WidgetError);
});

test("W-31: the page names a card when it registers the action; the AI is told the customer sees it", () => {
  const [action] = sanitizeActions([{ name: "get_cart", description: "The cart.", widget: "cart" }, { name: "x", description: "X.", widget: "Not a name!" }]);
  assert.equal(action?.widget, "cart");
  assert.equal(sanitizeActions([{ name: "x", description: "X.", widget: "Not a name!" }])[0]?.widget, undefined);
  const run: MessageAction = { runId: "run_1", id: "get_cart", name: "get_cart", description: "", risk: "auto", params: {}, required: [], input: {}, missing: [], status: "ok", result: '{"total":1}', canUndo: false };
  assert.equal(actionToolResult(run), '{"total":1}');
  assert.equal(actionToolResult({ ...run, card: "cart" }), `{"total":1}\n\n${WIDGET_SHOWN_NOTE}`);
});

test("W-32: a card's page:<name> button names a website action and fills its inputs", () => {
  assert.equal(PAGE_ACTION_BUTTON.exec("page:remove_from_cart")?.[1], "remove_from_cart");
  assert.equal(PAGE_ACTION_BUTTON.exec("page:"), null);
  assert.equal(PAGE_ACTION_BUTTON.exec("page:two words"), null);
  const row = (id: string) => ({ type: "ListViewItem", children: [{ type: "Button", label: "Remove", onClickAction: { type: "page:remove_from_cart", payload: { id } } }] });
  const root = { type: "ListView", children: [row("mug"), row("cap")] };
  const hit = matchWidgetAction(root, { type: "page:remove_from_cart", payload: { id: "cap" } }, {}, "i1");
  assert.deepEqual(hit, { label: "Remove", action: { type: "page:remove_from_cart", payload: { id: "cap" } }, values: {}, item: "i1" });
  assert.equal(matchWidgetAction(root, { type: "page:remove_from_cart", payload: { id: "hat" } }, {}), null, "only a payload the card offers");
  const params = { id: { type: "string" }, qty: { type: "integer" } };
  assert.deepEqual(toolActionInput({ type: "page:remove_from_cart", payload: { id: "cap", admin: true } }, { qty: "2" }, params), { id: "cap", qty: 2 });
  const file = JSON.stringify({ version: "1.0", name: "cart", template: JSON.stringify(root).replace("page:remove_from_cart", "page:remove_from_cart") + " page:save_for_later homepage:x" });
  assert.deepEqual(widgetPageButtons(file), ["remove_from_cart", "save_for_later"]);
});

test("AI-28: a card's controls and what each one does", () => {
  const root = {
    type: "Card",
    children: [
      { type: "Button", label: "Apply", onClickAction: { type: "page:set_theme", payload: { theme: "dark" } } },
      { type: "Button", label: "Add seats", onClickAction: { type: "tool:add_seats" } },
      { type: "Button", label: "Preview", onClickAction: { type: "preview_theme", handler: "client" } },
      { type: "Button", label: "Docs", onClickAction: { type: "open_url", payload: { url: "https://x.io" } } },
      { type: "Button", label: "Close", onClickAction: { type: "dismiss" } },
      { type: "Select", name: "theme", label: "Theme", onChangeAction: { type: "pick_theme" } },
    ],
  };
  assert.deepEqual(cardControls(root as never), [
    { label: "Apply", does: { kind: "page", name: "set_theme" } },
    { label: "Add seats", does: { kind: "tool", name: "add_seats" } },
    { label: "Preview", does: { kind: "client", type: "preview_theme" } },
    { label: "Docs", does: { kind: "link" } },
    { label: "Close", does: { kind: "dismiss" } },
  ]);
});

test("D-76: the island opens one widget: picked, else the newest still waiting, else the newest", () => {
  const card = (id: string, action?: string, used = false) => ({
    widget: {
      id,
      name: id,
      root: { type: "Card", children: action ? [{ type: "Button", label: "Go", onClickAction: { type: action, payload: action === "open_url" ? { url: "https://x.io" } : {} } }] : [] },
      ...(used ? { used: { label: "Go", at: 1 } } : {}),
    } as never,
  });
  const plan = card("plan", "tool:add_seats");
  const quote = card("quote", "page:search_prices");
  const usage = card("usage", "open_url");
  const done = card("done", "tool:add_seats", true);
  assert.equal(pickOpenWidget([plan], null), null);
  // The newest waiting one wins over a newer one that only has a link.
  assert.equal(pickOpenWidget([plan, quote, usage], null), quote);
  // Nothing waiting (used, or link only): the newest.
  assert.equal(pickOpenWidget([done, usage], null), usage);
  // The visitor's pick wins.
  assert.equal(pickOpenWidget([plan, quote, usage], "plan"), plan);
  assert.equal(widgetWaiting(card("x").widget), false);
});
