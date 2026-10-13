import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkData, keepDescriptions, schemaFromSample, schemaParams, withDescription, withRequired } from "./widget-schema.ts";
import { checkExamples, parseWidgetFile, widgetSchema } from "./widgets.ts";

// ChatKit Studio's Flight Tracker Schema tab (zod), as its download writes it (`jsonSchema`).
const flight = {
  type: "object",
  properties: {
    number: { type: "string" },
    progress: { type: "string", description: "How far along, like 30%" },
    airline: { type: "object", properties: { name: { type: "string" }, logo: { type: "string" } }, required: ["name", "logo"], additionalProperties: false },
    departure: { type: "object", properties: { city: { type: "string" }, time: { type: "string" } }, required: ["city", "time"] },
    stops: { type: "array", items: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
    gate: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { type: "string", enum: ["on time", "delayed"] },
  },
  required: ["number", "progress", "airline", "departure", "status"],
};

test("W-30: data is checked against a widget's schema, each problem by its path", () => {
  const ok = { number: "PA 845", progress: "30%", airline: { name: "Pan Am", logo: "/p.png" }, departure: { city: "SF", time: "4 PM" }, stops: [{ code: "JFK" }], gate: null, status: "on time", extra: 1 };
  assert.deepEqual(checkData(flight, ok), []);
  assert.deepEqual(checkData(flight, { ...ok, number: 845, airline: { name: "Pan Am" }, stops: [{}], gate: 3, status: "late" }), [
    "number should be string, not number",
    "airline.logo is missing",
    "stops[0].code is missing",
    "gate doesn't match any of its allowed shapes",
    'status must be one of "on time", "delayed"',
  ]);
  assert.deepEqual(checkData({ type: "object", properties: { n: { type: "integer" } } }, { n: 2.5 }), ["n should be integer, not number"]);
});

test("W-30: a schema worked out from example data: everything required, lists from their first item", () => {
  const schema = schemaFromSample({ name: "Froge", number: 22, rating: 4.5, stats: [{ value: "18", label: "PTS" }], tags: [], ok: true });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      name: { type: "string" },
      number: { type: "number" },
      rating: { type: "number" },
      stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] } },
      tags: { type: "array" },
      ok: { type: "boolean" },
    },
    required: ["name", "number", "rating", "stats", "tags", "ok"],
  });
});

test("W-30: the parameters list, nested ones by path; descriptions set and kept across a new shape", () => {
  assert.deepEqual(schemaParams(flight), [
    { path: "number", type: "string", required: true },
    { path: "progress", type: "string", required: true, description: "How far along, like 30%" },
    { path: "airline", type: "group", required: true },
    { path: "airline.name", type: "string", required: true },
    { path: "airline.logo", type: "string", required: true },
    { path: "departure", type: "group", required: true },
    { path: "departure.city", type: "string", required: true },
    { path: "departure.time", type: "string", required: true },
    { path: "stops", type: "list of items", required: false },
    { path: "stops[].code", type: "string", required: true },
    { path: "gate", type: "string or null", required: false },
    { path: "status", type: 'one of "on time", "delayed"', required: true },
  ]);
  const described = withDescription(flight, "stops[].code", "Airport code");
  assert.equal(schemaParams(described).find((p) => p.path === "stops[].code")?.description, "Airport code");
  assert.equal(schemaParams(flight).find((p) => p.path === "stops[].code")?.description, undefined, "the original is untouched");
  assert.equal(schemaParams(withDescription(described, "progress", "")).find((p) => p.path === "progress")?.description, undefined);
  // The data changed shape: descriptions stay where the same parameter is still there.
  const next = keepDescriptions(schemaFromSample({ progress: "50%", stops: [{ code: "LHR", gate: "B" }] }), described);
  assert.deepEqual(schemaParams(next).map((p) => [p.path, p.description ?? ""]), [["progress", "How far along, like 30%"], ["stops", ""], ["stops[].code", "Airport code"], ["stops[].gate", ""]]);
});

test("W-30: a ChatKit Studio download carries its schema; a widget without one gets one from its example data", () => {
  const studio = parseWidgetFile("probe", readFileSync(new URL("./fixtures/studio-probe.widget", import.meta.url), "utf8"));
  assert.equal(studio.schema?.type, "object");
  assert.ok(schemaParams(studio.schema!).some((p) => p.path === "items[].tags"));
  const ours = parseWidgetFile("p", JSON.stringify({ version: "1.0", template: "{}", sample: { a: "x" }, jsonSchema: {} }));
  assert.equal(ours.schema, undefined, "an empty schema says nothing");
  assert.deepEqual(widgetSchema(ours), { type: "object", properties: { a: { type: "string" } }, required: ["a"] });
});

test("W-30: named states: ours, else ChatKit Studio's; each must fit the schema and draw", () => {
  const template = '{"type":"Card","children":[{"type":"Text","value":{{ (city) | tojson }}}]}';
  const ours = parseWidgetFile("w", JSON.stringify({ version: "1.0", template, sample: { city: "SF" }, states: [{ name: "Delayed", data: { city: "LA" } }, { name: "bad" }] }));
  assert.deepEqual(ours.states, [{ name: "Delayed", data: { city: "LA" } }]);
  const studio = { defaultState: { city: "SF" }, states: JSON.stringify([{ id: "state_1", name: "Landed", value: { city: "/img.png" } }]) };
  const encoded = Buffer.from(JSON.stringify(studio)).toString("base64url");
  const fromStudio = parseWidgetFile("w", JSON.stringify({ version: "1.0", template, encodedWidget: encoded }));
  assert.deepEqual(fromStudio.states, [{ name: "Landed", data: { city: "https://widgets.chatkit.studio/img.png" } }], "Studio's images point at Studio, as for its default");
  const removed = parseWidgetFile("w", JSON.stringify({ version: "1.0", template, encodedWidget: encoded, states: [] }));
  assert.equal(removed.states, undefined, "an own list, even empty, replaces Studio's");
  assert.deepEqual(removed.sample, { city: "SF" }, "Studio's default still fills in");

  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
  assert.doesNotThrow(() => checkExamples(parseWidgetFile("w", JSON.stringify({ version: "1.0", template, sample: { city: "SF" }, jsonSchema: schema, states: [{ name: "Delayed", data: { city: "LA" } }] }))));
  assert.throws(() => checkExamples(parseWidgetFile("w", JSON.stringify({ version: "1.0", template, sample: { city: "SF" }, jsonSchema: schema, states: [{ name: "Empty", data: {} }] }))), /State "Empty" doesn't fit the schema: city is missing/);
  assert.throws(() => checkExamples(parseWidgetFile("w", JSON.stringify({ version: "1.0", template, sample: { city: 3 }, jsonSchema: schema }))), /Example data doesn't fit the schema: city should be string, not number/);
});

test("W-30: a parameter made optional or required again, nested ones too", () => {
  const optional = withRequired(flight, "departure.time", false);
  assert.equal(schemaParams(optional).find((p) => p.path === "departure.time")?.required, false);
  assert.deepEqual(checkData(optional, { number: "1", progress: "1", airline: { name: "a", logo: "b" }, departure: { city: "SF" }, status: "on time" }), []);
  assert.deepEqual((withRequired(optional, "departure.time", true).properties as any).departure.required, ["city", "time"]);
  assert.equal(schemaParams(withRequired(flight, "stops[].code", false)).find((p) => p.path === "stops[].code")?.required, false);
  assert.deepEqual((withRequired(flight, "gate", true).required as string[]).at(-2), "gate", "kept in the properties' order");
});
