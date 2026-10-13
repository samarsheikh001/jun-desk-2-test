import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileTemplate } from "./jinja.ts";
import { actionUrl, checkWidget, renderActionLine, toolButtonInputs, isClientAction, itemIds, markWidgetUsed, matchWidgetAction, matchWidgetChange, nodeText, parseWidgetFile, renderSummary, renderWidget, summaryFor, TOOL_ACTION, toolActionInput, widgetActionLine, widgetActionUsed, widgetData, WidgetError, widgetSummary } from "./widgets.ts";

// A widget exported from ChatKit Studio's Download (2026-10-10), with the Studio's own render of its
// default state as `outputJsonPreview`: our interpreter must produce the same tree.
const studio = readFileSync(new URL("./fixtures/studio-probe.widget", import.meta.url), "utf8");

test("a ChatKit Studio export renders like the Studio's own preview", () => {
  const spec = parseWidgetFile("probe", studio);
  assert.equal(spec.title, "Create Event");
  assert.ok(spec.sample, "default state decoded from encodedWidget");
  const tree = renderWidget(spec, spec.sample);
  const raw = JSON.parse(studio).outputJsonPreview;
  const preview = typeof raw === "string" ? JSON.parse(raw) : raw;
  // The Studio previews template strings (`${index + 1}`) as text; its compiled template gives the
  // number. Text values are drawn as text either way.
  const text = (n: unknown): unknown => (Array.isArray(n) ? n.map(text) : n && typeof n === "object" ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === "value" && typeof v === "number" ? String(v) : text(v)])) : n);
  assert.deepEqual(text(tree), text(checkWidget(preview)));
});

test("tool results as template data", () => {
  assert.deepEqual(widgetData({ a: 1 }), { a: 1 });
  assert.deepEqual(widgetData([1, 2]), { items: [1, 2] });
  assert.deepEqual(widgetData("x"), { value: "x" });
});

test("widget files: clear errors", () => {
  assert.throws(() => parseWidgetFile("x", "nope"), /JSON/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "2.0", template: "{}" })), /version/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "1.0" })), /template is required/);
  assert.throws(() => parseWidgetFile("x", JSON.stringify({ version: "1.0", template: "{{ f() }}" })), /template:/);
  const spec = parseWidgetFile("x", JSON.stringify({ version: "1.0", name: "X", template: '{"type":"Card","children":[{"type":"Text","value":{{ v }}}]}' }));
  assert.throws(() => renderWidget(spec, { v: "unquoted" }), /valid JSON/);
});

test("D-47: a widget file's own summary line", () => {
  const card = '{"type":"Card","children":[{"type":"Title","value":{{ json.lowTemperature | tojson }}}]}';
  const file = (summary: unknown) => JSON.stringify({ version: "1.0", name: "Weather", template: card, summary });
  const weather = parseWidgetFile("weather", file("{{ json.highTemperature }}  ·\n {{ json.location }}"));
  assert.ok(weather.summary);
  const data = { json: { highTemperature: "69°", lowTemperature: "47°", location: "Pune" } };
  assert.equal(renderSummary(weather, data), "69° · Pune");
  assert.deepEqual(summaryFor(weather, data), { summary: "69° · Pune" });
  // Long lines are cut; empty renders and files without one give nothing.
  const long = renderSummary(weather, { json: { highTemperature: "x".repeat(100), location: "Pune" } });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
  assert.deepEqual(summaryFor(weather, {}), {});
  assert.deepEqual(summaryFor(parseWidgetFile("w", file(undefined)), data), {});
  assert.equal(parseWidgetFile("w", file("  ")).summary, undefined);
  // Parsing: a string, at most 200 characters, a template that compiles.
  assert.throws(() => parseWidgetFile("w", file(42)), /summary is a Jinja template string/);
  assert.throws(() => parseWidgetFile("w", file("x".repeat(201))), /longer than 200/);
  assert.throws(() => parseWidgetFile("w", file("{{ f() }}")), /summary:/);
  // A summary that fails to render is dropped; the card still renders.
  const failing = { ...weather, summary: { render: () => { throw new Error("boom"); } } };
  assert.throws(() => renderSummary(failing, data), /summary: boom/);
  assert.deepEqual(summaryFor(failing, data), {});
  assert.equal(renderWidget(failing, data).type, "Card");
});

test("trees: known components, a root container, limits; nulls dropped", () => {
  assert.throws(() => checkWidget({ type: "Text", value: "x" }), /root must be/);
  assert.throws(() => checkWidget({ type: "Card", children: [{ type: "script" }] }), /unknown component "script"/);
  assert.throws(() => checkWidget({ type: "Card", children: [{ value: "x" }] }), WidgetError);
  assert.throws(() => checkWidget({ type: "Card", children: Array.from({ length: 500 }, () => ({ type: "Divider" })) }), /more than/);
  assert.deepEqual(checkWidget({ type: "Card", border: null, children: [null, { type: "Text", value: "a", color: null }] }), { type: "Card", children: [{ type: "Text", value: "a" }] });
});

const card = checkWidget({
  type: "Card",
  confirm: { label: "Add to calendar", action: { type: "calendar.add", payload: { id: 1 } } },
  cancel: { label: "Discard", action: { type: "calendar.discard" } },
  children: [
    { type: "Title", value: "Lunch" },
    { type: "Form", onSubmitAction: { type: "note.save" }, children: [{ type: "Input", name: "note" }, { type: "Checkbox", name: "remind" }, { type: "Button", label: "Save", submit: true }] },
    { type: "Button", label: "Open", onClickAction: { type: "open", payload: { url: "x" } } },
  ],
});

test("a visitor's action must be one the widget offers; only its fields' values are kept", () => {
  assert.deepEqual(matchWidgetAction(card, { type: "calendar.add", payload: { id: 1 } }, {}), { label: "Add to calendar", action: { type: "calendar.add", payload: { id: 1 } }, values: {} });
  assert.equal(matchWidgetAction(card, { type: "calendar.add", payload: { id: 2 } }, {}), null, "payload must match");
  assert.equal(matchWidgetAction(card, { type: "refund.issue" }, {}), null);
  assert.deepEqual(matchWidgetAction(card, { type: "note.save" }, { note: "hi", remind: true, admin: "yes", n: 3 })?.values, { note: "hi", remind: true });
  assert.equal(matchWidgetAction(card, { type: "note.save" }, {})?.label, "Save");
  assert.equal(matchWidgetAction(card, { type: "open", payload: { url: "x" } }, {})?.label, "Open");
});

test("text of a card, and the history line for an action", () => {
  assert.equal(nodeText(card), "Lunch · Save · Open");
  assert.equal(
    widgetActionLine("Save", { widgetId: "w1", widget: "event", type: "note.save", values: { note: "hi" } }),
    '[On the event card the customer pressed "Save": action note.save, entered {"note":"hi"}]',
  );
});

// W-17: a product list: one "Add" per row (a tool action), a link per row, and a card-level checkout.
const shop = checkWidget({
  type: "ListView",
  children: [
    { type: "ListViewItem", children: [{ type: "Text", value: "Red dress" }, { type: "Button", label: "Add", onClickAction: { type: "tool:add_to_cart", payload: { sku: "R1" } } }, { type: "Button", label: "View", onClickAction: { type: "open_url", payload: { url: "https://shop.test/r1" } } }] },
    { type: "ListViewItem", children: [{ type: "Text", value: "Blue dress" }, { type: "Button", label: "Add", onClickAction: { type: "tool:add_to_cart", payload: { sku: "B2" } } }] },
    { type: "ListViewItem", onClickAction: { type: "pick" }, children: [{ type: "Text", value: "Same action" }] },
    { type: "ListViewItem", onClickAction: { type: "pick" }, children: [{ type: "Text", value: "Same action again" }] },
  ],
});

test("W-17: list items have ids and their own actions; used one by one", () => {
  assert.deepEqual([...itemIds(shop).values()], ["i0", "i1", "i2", "i3"]);
  const blue = matchWidgetAction(shop, { type: "tool:add_to_cart", payload: { sku: "B2" } }, {}, "i1");
  assert.equal(blue?.item, "i1");
  // The same action in two rows: the row the visitor names.
  assert.equal(matchWidgetAction(shop, { type: "pick" }, {}, "i3")?.item, "i3");
  assert.equal(matchWidgetAction(shop, { type: "pick" }, {})?.item, "i2");
  const widget = { id: "w1", name: "shop", root: shop };
  const after = markWidgetUsed(widget, "Add", "i1", 1);
  assert.equal(widgetActionUsed(after, "i1"), true);
  assert.equal(widgetActionUsed(after, "i0"), false, "other rows still work");
  assert.equal(widgetActionUsed(markWidgetUsed(widget, "Checkout", undefined, 1), "i0"), true, "a used card turns every row off");
});

test("W-17: links open in the browser (https only) and are never sent", () => {
  assert.equal(actionUrl({ type: "open_url", payload: { url: "https://shop.test/r1" } }), "https://shop.test/r1");
  assert.equal(actionUrl({ type: "open_url", payload: { url: "javascript:alert(1)" } }), null);
  assert.equal(actionUrl({ type: "open_url", payload: { url: "http://shop.test" } }), null);
  assert.equal(matchWidgetAction(shop, { type: "open_url", payload: { url: "https://shop.test/r1" } }, {}, "i0"), null);
});

test("W-17: a tool action's input is its payload plus what was entered, only the tool's own inputs, typed", () => {
  const input = toolActionInput({ type: "tool:add_to_cart", payload: { sku: "R1", admin: true } }, { size: "M", qty: "2", gift: true }, { sku: { type: "string" }, size: { type: "string" }, qty: { type: "integer" }, gift: { type: "boolean" } });
  assert.deepEqual(input, { sku: "R1", size: "M", qty: 2, gift: true });
  assert.equal(TOOL_ACTION.exec("tool:add_to_cart")?.[1], "add_to_cart");
  assert.equal(
    widgetActionLine("Add", { widgetId: "w1", widget: "shop", type: "tool:add_to_cart", payload: { sku: "R1" }, item: "i0", tool: { name: "add_to_cart", status: "ok", output: '{"items":1}' } }),
    '[On the shop card the customer pressed "Add": action tool:add_to_cart, payload {"sku":"R1"}]\n[That ran add_to_cart: done. Result: {"items":1}]',
  );
});

test("a one-line summary of a card for the folded island", () => {
  const subscription = { type: "Card", status: { text: "Billing", icon: "suitcase" }, children: [{ type: "Row", children: [{ type: "Title", value: "Team plan" }, { type: "Spacer" }, { type: "Badge", label: "active", color: "success" }] }, { type: "Caption", value: "Renews on Nov 1" }] };
  assert.equal(widgetSummary(subscription), "Team plan · active");
  const usage = { type: "Card", children: [{ type: "Text", value: "Events this week", weight: "semibold" }, { type: "Badge", label: "84%" }, { type: "Chart", data: [] }] };
  assert.equal(widgetSummary(usage), "Events this week · 84%");
  // A bare number as the title says little on its own: the first caption says what it is.
  const weather = { type: "Card", background: "linear-gradient(#000, #111)", children: [{ type: "Title", value: "47°", size: "5xl" }, { type: "Caption", value: "San Francisco,\n  CA" }, { type: "Title", value: "69°" }] };
  assert.equal(widgetSummary(weather), "47° · San Francisco, CA");
  const invoices = { type: "ListView", status: { text: "Invoices" }, children: [1, 2, 3].map((n) => ({ type: "ListViewItem", children: [{ type: "Text", value: `#${n}` }] })) };
  assert.equal(widgetSummary(invoices), "Invoices · 3");
  assert.equal(widgetSummary({ ...invoices, status: undefined }), "3 items");
  // No title: the status leads, then a badge, or else the first text.
  assert.equal(widgetSummary({ type: "Card", status: { text: "Order" }, children: [{ type: "Text", value: "Shipped   today" }] }), "Order · Shipped today");
  assert.equal(widgetSummary({ type: "Card", status: { text: "Order" }, children: [{ type: "Text", value: "x" }, { type: "Badge", label: "late" }] }), "Order · late");
  // A one-line confirmation card (an icon and a sentence): the sentence.
  assert.equal(widgetSummary({ type: "Card", children: [{ type: "Row", children: [{ type: "Icon", name: "mail" }, { type: "Text", value: "Sent INV-1043" }] }] }), "Sent INV-1043");
  assert.equal(widgetSummary({ type: "Card", children: [{ type: "Title", value: " " }, { type: "Button", label: "OK" }] }), "");
  const long = widgetSummary({ type: "Card", children: [{ type: "Title", value: "A very long title that goes on and on well past the limit" }, { type: "Badge", label: "new" }] }, 30);
  assert.equal(long.length, 30);
  assert.ok(long.endsWith("…"));
});

test("D-51: client actions never reach the server; field changes match only their own tool action", () => {
  const card = {
    type: "Card",
    confirm: { label: "Buy", action: { type: "cart.add", handler: "client" } },
    children: [
      { type: "Button", label: "Open tour", onClickAction: { type: "tour.start", handler: "client" } },
      { type: "Button", label: "Ask", onClickAction: { type: "ask", loadingBehavior: "self" } },
      { type: "Select", name: "seats", options: [], onChangeAction: { type: "tool:quote", payload: { plan: "team" } } },
      { type: "Checkbox", name: "annual", onChangeAction: { type: "recalc" } },
      { type: "Input", name: "note" },
      { type: "ListView", children: [{ type: "ListViewItem", children: [{ type: "RadioGroup", name: "size", options: [], onChangeAction: { type: "tool:pick_size" } }] }] },
    ],
  };
  assert.equal(isClientAction(card.confirm.action), true);
  assert.equal(isClientAction({ type: "ask" }), false);
  assert.equal(matchWidgetAction(card, { type: "tour.start" }, {}), null, "a client action isn't offered to the server");
  assert.equal(matchWidgetAction(card, { type: "cart.add" }, {}), null, "nor a client confirm");
  assert.equal(matchWidgetAction(card, { type: "ask" }, {})?.label, "Ask");
  // A change isn't a press: onChangeAction never matches as one.
  assert.equal(matchWidgetAction(card, { type: "tool:quote", payload: { plan: "team" } }, {}), null);
  const change = matchWidgetChange(card, "seats", { type: "tool:quote", payload: { plan: "team" } }, { seats: "5", note: "hi", admin: "x" });
  assert.deepEqual(change, { action: { type: "tool:quote", payload: { plan: "team" } }, field: "seats", values: { seats: "5", note: "hi" } });
  assert.equal(matchWidgetChange(card, "seats", { type: "tool:quote" }, {}), null, "payload must match");
  assert.equal(matchWidgetChange(card, "note", { type: "tool:quote", payload: { plan: "team" } }, {}), null, "another field");
  assert.equal(matchWidgetChange(card, "annual", { type: "recalc" }, {}), null, "only tool: actions run on a change");
  assert.equal(matchWidgetChange(card, "size", { type: "tool:pick_size" }, {})?.item, "i0");
});

test("widgets: Studio's example images (\"/kpop.png\") point at ChatKit Studio; other data is left as is", () => {
  const studio = { defaultState: { banner: "/kpop.png", tracks: [{ cover: "/album01.png", link: "/playlists/kpop" }], other: "//cdn.test/x.png", full: "https://cdn.test/y.png" } };
  const encodedWidget = Buffer.from(JSON.stringify(studio)).toString("base64url");
  const spec = parseWidgetFile("playlist", JSON.stringify({ version: "1.0", template: '{"type":"Card","children":[]}', encodedWidget }));
  assert.deepEqual(spec.sample, {
    banner: "https://widgets.chatkit.studio/kpop.png",
    tracks: [{ cover: "https://widgets.chatkit.studio/album01.png", link: "/playlists/kpop" }],
    other: "//cdn.test/x.png",
    full: "https://cdn.test/y.png",
  });
  // An admin's own sample is used as written.
  const own = parseWidgetFile("playlist", JSON.stringify({ version: "1.0", template: '{"type":"Card","children":[]}', sample: { banner: "/kpop.png" }, encodedWidget }));
  assert.deepEqual(own.sample, { banner: "/kpop.png" });
});

test("W-27: each button that runs an action, the inputs a press fills, and a required one nothing fills", () => {
  const root = checkWidget({
    type: "Card",
    children: [
      { type: "Input", name: "name" },
      { type: "Input", name: "e_mail" },
      { type: "Select", name: "size", options: [], onChangeAction: { type: "tool:quote" } },
      { type: "Button", label: "Submit", submit: true, onClickAction: { type: "tool:book_demo", payload: { source: "card" } } },
      { type: "Button", label: "Close", onClickAction: { type: "dismiss" } },
      { type: "Button", label: "Gone", onClickAction: { type: "tool:nope" } },
    ],
  });
  const inputs: Record<string, Record<string, { required: boolean }>> = {
    book_demo: { name: { required: true }, email: { required: true }, phone: { required: false }, source: { required: true } },
    quote: { size: { required: true } },
  };
  assert.deepEqual(toolButtonInputs(root, (t) => inputs[t] ?? null), [
    { label: "Submit", tool: "book_demo", sends: ["name", "source"], missing: [{ name: "email", like: "e_mail" }] },
    { label: "size", tool: "quote", sends: ["size"], missing: [], field: true },
  ]);
});

test("W-27: a list's rows repeat one button: reported once", () => {
  const row = (id: string) => ({ type: "ListViewItem", children: [{ type: "Button", label: "Add", onClickAction: { type: "tool:add", payload: { id } } }] });
  const root = checkWidget({ type: "ListView", children: [row("a"), row("b")] });
  assert.deepEqual(toolButtonInputs(root, () => ({ id: { required: true } })), [{ label: "Add", tool: "add", sends: ["id"], missing: [] }]);
});

test("W-27: an action's card line: what was entered and the result, one plain line, empty when it fails", () => {
  const t = compileTemplate("Thanks {{ name }},\n  we'll call {{ phone | default('you') }} about {{ ticket }}.");
  assert.equal(renderActionLine(t, { name: "Sam" }, { ticket: "T-9" }), "Thanks Sam, we'll call you about T-9.");
  // The result's fields win over what was typed.
  assert.equal(renderActionLine(compileTemplate("{{ name }}"), { name: "typed" }, { name: "Saved" }), "Saved");
  assert.equal(renderActionLine(compileTemplate("Sorry {{ name }}, that failed ."), {}, null), "Sorry, that failed.");
  assert.equal(renderActionLine(compileTemplate("{{ x.y.z }}"), {}, null), "");
  assert.equal(renderActionLine(compileTemplate(" · "), {}, null), "");
  assert.equal(renderActionLine(compileTemplate("a{{ long }}"), { long: "b".repeat(300) }, undefined).length, 140);
});

test("W-27: dismiss folds the card on the visitor's side and is never accepted by the server", () => {
  const root = checkWidget({ type: "Card", children: [{ type: "Button", label: "Done", onClickAction: { type: "dismiss" } }] });
  assert.equal(matchWidgetAction(root, { type: "dismiss" }, {}), null);
});

test("W-29: aiFill is a switch in the file (true only)", () => {
  assert.equal(parseWidgetFile("p", JSON.stringify({ version: "1.0", template: "{}", aiFill: true })).aiFill, true);
  assert.equal(parseWidgetFile("p", JSON.stringify({ version: "1.0", template: "{}", aiFill: "yes" })).aiFill, undefined);
});
