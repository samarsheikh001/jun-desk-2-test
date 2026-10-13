import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLinks } from "./agent-links.ts";

const widget = (template: string) => JSON.stringify({ version: "1.0", template });

const files = {
  "AGENTS.md": "---\n---\nBe kind.\n",
  "tools/add_seats.yaml": "description: Add seats\nwidget: seats_added   # shown after\nurl: https://x.test\n",
  "tools/seat_quote.yaml": "description: Quote\nwidget: \"seat_quote\"\n",
  "tools/lookup_order.yaml": "description: Look up\n# widget: order\n",
  "widgets/seats_added.widget": widget('{"type":"Card","children":[]}'),
  "widgets/seat_quote.widget": widget('{"type":"Card","children":[{"type":"Button","onClickAction":{"type":"tool:add_seats"}},{"type":"Select","onChangeAction":{"type":"tool:seat_quote"}}]}'),
  "skills/cancellation/SKILL.md":
    "---\nname: cancellation\ndescription: Cancel. Mentions add_seats in the description only.\n---\n1. Offer 50% off (offer: discount_50_3m).\n2. Before applying it with apply_save_offer, wait for a yes.\n3. Use `lookup_order` to check their last order.\n",
  "skills/upgrade/SKILL.md": "---\nname: upgrade\ndescription: More seats.\n---\n1. Quote with seat_quote, then run the add_seats action.\n",
};

test("links: an action's widget, both ways (commented-out lines don't count)", () => {
  const l = agentLinks(files);
  assert.deepEqual(l.actionWidget, { add_seats: "seats_added", seat_quote: "seat_quote" });
  assert.deepEqual(l.widgetShownBy, { seats_added: ["add_seats"], seat_quote: ["seat_quote"] });
});

test("links: a widget's tool: buttons and fields run actions, both ways", () => {
  const l = agentLinks(files);
  assert.deepEqual(l.widgetRuns, { seat_quote: ["add_seats", "seat_quote"] });
  assert.deepEqual(l.actionRunFrom, { add_seats: ["seat_quote"], seat_quote: ["seat_quote"] });
});

test("links: procedures mention actions in their steps (not the description), both ways", () => {
  const l = agentLinks(files);
  assert.deepEqual(l.procedureUses, { cancellation: ["lookup_order"], upgrade: ["add_seats", "seat_quote"] });
  assert.deepEqual(l.actionUsedBy, { lookup_order: ["cancellation"], add_seats: ["upgrade"], seat_quote: ["upgrade"] });
});

test("links: names used as an action that aren't one are flagged; offer codes and real actions aren't", () => {
  const l = agentLinks(files);
  assert.deepEqual(l.procedureMissing, { cancellation: ["apply_save_offer"] });
  assert.deepEqual(agentLinks({ "skills/a/SKILL.md": "---\nname: a\n---\nCall the refund_order tool, then use `notify_team`.\n" }).procedureMissing, { a: ["refund_order", "notify_team"] });
});

test("links: a file that doesn't parse links nothing", () => {
  const l = agentLinks({ "widgets/broken.widget": "{ not json", "tools/x_y.yaml": "widget: [" });
  assert.deepEqual(l.widgetRuns, {});
  assert.deepEqual(l.actionWidget, {});
  assert.deepEqual(l.widgets, ["broken"]);
});

test("links: @mentions count as using an action, and a missing one is flagged (emails aren't)", () => {
  const l = agentLinks({
    "tools/lookup_order.yaml": "description: x\n",
    "skills/a/SKILL.md": "---\nname: a\n---\n1. Check it with @lookup_order.\n2. Then @refund (ask help@acme.com first).\n",
  });
  assert.deepEqual(l.procedureUses, { a: ["lookup_order"] });
  assert.deepEqual(l.procedureMissing, { a: ["refund"] });
});

test("links: @show_widget is the AI's own tool, never a missing action", () => {
  const l = agentLinks({ "skills/a/SKILL.md": "---\nname: a\n---\n1. Show it with @show_widget.\n" });
  assert.deepEqual(l.procedureMissing, {});
});
