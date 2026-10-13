import assert from "node:assert/strict";
import { test } from "node:test";
import { WIDGET_TEMPLATES } from "../web/agent/widget-templates.ts";
import { checkExamples, parseWidgetFile, previewWidget } from "./widgets.ts";

// W-23: every template on the Widgets page's Templates tab is a working widget file.

test("widget templates: each parses, renders its sample and passes the widget checks", () => {
  assert.ok(WIDGET_TEMPLATES.length >= 19);
  assert.equal(new Set(WIDGET_TEMPLATES.map((t) => t.id)).size, WIDGET_TEMPLATES.length, "unique ids");
  for (const t of WIDGET_TEMPLATES) {
    assert.match(t.id, /^[a-z][a-z0-9_]*$/, `${t.id}: usable as a widget name`);
    assert.ok(t.name && t.description, `${t.id}: name and description`);
    const spec = parseWidgetFile(t.id, t.file);
    assert.ok(spec.sample, `${t.id}: has example data`);
    assert.doesNotThrow(() => previewWidget(t.id, t.file), `${t.id}: renders`);
    // W-30: Studio's own schema comes with it, and its example fits it.
    assert.equal(spec.schema?.type, "object", `${t.id}: has Studio's schema`);
    assert.doesNotThrow(() => checkExamples(spec), `${t.id}: example fits the schema`);
    // Studio's demo image paths point at Studio, never at the desk.
    assert.ok(!/"\/(?!\/)[^"]+\.(?:png|jpe?g|gif|webp|svg)"/i.test(JSON.stringify(spec.sample)), `${t.id}: no root-relative images`);
  }
});
