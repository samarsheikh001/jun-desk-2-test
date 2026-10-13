import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWidgetEdit, formatTemplate, parseWidgetEdit, widgetEditInput, widgetEditPrompt } from "./widget-ai.ts";
import { CHATKIT_AUTHORING_GUIDE } from "../worker/ai/chatkit-authoring.ts";
import { parseWidgetFile, renderWidget, starterWidget } from "./widgets.ts";

test("widget AI: formatting a template keeps the tree it renders", () => {
  const file = JSON.parse(starterWidget("Plan")) as { template: string; sample: Record<string, unknown> };
  const formatted = formatTemplate(file.template);
  assert.ok(formatted.split("\n").length > 10, "indented over several lines");
  assert.ok(formatted.includes('{"type": "Card"') || formatted.includes('"type": "Card"'));
  const before = renderWidget(parseWidgetFile("plan", JSON.stringify({ version: "1.0", template: file.template })), file.sample);
  const after = renderWidget(parseWidgetFile("plan", JSON.stringify({ version: "1.0", template: formatted })), file.sample);
  assert.deepEqual(after, before);
  // Without the optional link too (the {% if %} branch left out).
  assert.deepEqual(
    renderWidget(parseWidgetFile("plan", JSON.stringify({ version: "1.0", template: formatted })), { ...file.sample, invoice_url: "https://x.test/i" }),
    renderWidget(parseWidgetFile("plan", JSON.stringify({ version: "1.0", template: file.template })), { ...file.sample, invoice_url: "https://x.test/i" }),
  );
});

test("widget AI: strings and Jinja are left exactly as written", () => {
  const source = '{"type":"Text","value":"a, b: {c} [d]","x":{{ (v) | tojson }},"e":{}}';
  const formatted = formatTemplate(source);
  assert.ok(formatted.includes('"a, b: {c} [d]"'));
  assert.ok(formatted.includes("{{ (v) | tojson }}"));
  assert.ok(formatted.includes('"e": {}'));
  assert.equal(formatted.replace(/\s+/g, ""), source.replace(/\s+/g, ""));
});

test("widget AI: parses the answer's tags, with or without sample and summary", () => {
  const edit = parseWidgetEdit('<reply>Made the title bigger.</reply>\n<template>\n{"type":"Card","children":[]}\n</template>');
  assert.deepEqual(edit, { reply: "Made the title bigger.", template: '{"type":"Card","children":[]}' });
  const full = parseWidgetEdit('```\n<reply>Added a badge.</reply>\n<template>\n{"type":"Card"}\n</template>\n<sample>\n{"status": "paid"}\n</sample>\n<summary> {{ status }} </summary>\n```');
  assert.deepEqual(full, { reply: "Added a badge.", template: '{"type":"Card"}', sample: { status: "paid" }, summary: "{{ status }}" });
  assert.equal(parseWidgetEdit("Sorry, I can't."), null);
  assert.throws(() => parseWidgetEdit("<template>{}</template><sample>[1]</sample>"), /JSON object/);
});

test("widget AI: applying an edit keeps the file's other keys and order", () => {
  const file = JSON.stringify({ version: "1.0", name: "Plan", template: "old", jsonSchema: { type: "object" }, summary: "{{ a }}", sample: { a: 1 } });
  const next = JSON.parse(applyWidgetEdit(file, { template: "new", sample: { a: 2 } })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(next), ["version", "name", "template", "jsonSchema", "summary", "sample"]);
  assert.equal(next.template, "new");
  assert.deepEqual(next.sample, { a: 2 });
  assert.equal(next.summary, "{{ a }}");
  const cleared = JSON.parse(applyWidgetEdit(file, { template: "new", summary: "" })) as Record<string, unknown>;
  assert.equal("summary" in cleared, false);
});

test("widget AI: the request carries the widget, the recent chat and a failed attempt", () => {
  const input = widgetEditInput({
    name: "plan",
    template: '{"type":"Card"}',
    sample: { a: 1 },
    summary: null,
    history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }) as const),
    message: "Make it dark",
    error: { template: "{bad", message: "Unclosed {" },
  });
  assert.ok(input.includes('{"type":"Card"}'));
  assert.ok(input.includes('"a": 1'));
  assert.ok(input.includes("The admin asks: Make it dark"));
  assert.ok(!input.includes("turn 7"), "only the last turns");
  assert.ok(input.includes("turn 19"));
  assert.ok(input.includes("Error: Unclosed {"));
});

test("widget AI: the prompt is ChatKit's whole guide, then this desk's rules and the answer's shape", () => {
  assert.ok(CHATKIT_AUTHORING_GUIDE.startsWith("You are an expert widget designer"));
  for (const part of ["## Methodology", "### Common Mistakes to Avoid", "# Examples", "# Component Reference", "export type WidgetIcon"]) {
    assert.ok(CHATKIT_AUTHORING_GUIDE.includes(part), part);
  }
  const prompt = widgetEditPrompt(CHATKIT_AUTHORING_GUIDE);
  const guide = prompt.indexOf(CHATKIT_AUTHORING_GUIDE);
  assert.ok(guide > 0);
  assert.ok(prompt.indexOf("# How this desk stores a widget") > guide + CHATKIT_AUTHORING_GUIDE.length, "our rules come after the guide");
  assert.ok(prompt.trimEnd().endsWith("</schema>"), "the answer's shape is last");
});

test("W-30: the model may send the widget's schema; new example data that breaks the old one gets a new one, descriptions kept", () => {
  const edit = parseWidgetEdit('<reply>Added a gate.</reply>\n<template>\n{}\n</template>\n<schema>\n{"type":"object","properties":{"gate":{"type":"string"}}}\n</schema>');
  assert.deepEqual(edit?.schema, { type: "object", properties: { gate: { type: "string" } } });
  assert.throws(() => parseWidgetEdit("<template>\n{}\n</template>\n<schema>[1]</schema>"), /JSON Schema object/);

  const file = JSON.stringify({ version: "1.0", template: "{}", sample: { city: "SF" }, jsonSchema: { type: "object", properties: { city: { type: "string", description: "Where from" } }, required: ["city"] } });
  const fits = JSON.parse(applyWidgetEdit(file, { template: "{}", sample: { city: "LA" } }));
  assert.equal(fits.jsonSchema.properties.city.description, "Where from", "still fits: the schema is kept as it is");
  const grown = JSON.parse(applyWidgetEdit(file, { template: "{}", sample: { gate: "B2" } }));
  assert.deepEqual(grown.jsonSchema, { type: "object", properties: { gate: { type: "string" } }, required: ["gate"] });
  const both = JSON.parse(applyWidgetEdit(file, { template: "{}", sample: { city: "LA", gate: 2 } }));
  assert.deepEqual(both.jsonSchema.properties.city, { type: "string", description: "Where from" }, "a widened shape keeps the descriptions");
  const none = JSON.parse(applyWidgetEdit(JSON.stringify({ version: "1.0", template: "{}" }), { template: "{}", sample: { a: 1 } }));
  assert.equal(none.jsonSchema, undefined, "a widget without a schema keeps working it out from its example");
});
