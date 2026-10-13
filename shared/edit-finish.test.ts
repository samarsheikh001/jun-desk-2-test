import assert from "node:assert/strict";
import { test } from "node:test";
import { finishWidgetEdit, liveReply, readAgentFileEdit, withMissingNote } from "./edit-finish.ts";

const template = '{"type":"Card","children":[{"type":"Text","value":{{ (city) | tojson }}}]}';
const file = `${JSON.stringify({ version: "1.0", template, sample: { city: "SF" } }, null, 2)}\n`;

test("D-62: the reply shows as it streams, without half-written tags", () => {
  assert.equal(liveReply(""), "");
  assert.equal(liveReply("<rep"), "");
  assert.equal(liveReply("<reply>Made it gr"), "Made it gr");
  assert.equal(liveReply("<reply>Made it green.</rep"), "Made it green.");
  assert.equal(liveReply("<reply>Made it\n green.</reply>\n<template>{"), "Made it green.");
});

test("D-62: a streamed widget answer is applied and checked in the browser; a broken one goes back to the model", () => {
  const next = template.replace("Text", "Title");
  const ok = finishWidgetEdit({ name: "w", file }, `<reply>A title now.</reply>\n<template>\n${next}\n</template>`);
  assert.ok("result" in ok && ok.result.changed && JSON.parse(ok.result.file).template === next);
  const same = finishWidgetEdit({ name: "w", file }, `<reply>Nothing to change.</reply>\n<template>\n${template}\n</template>`);
  assert.deepEqual(same, { result: { reply: "Nothing to change.", file, changed: false } });
  assert.deepEqual(finishWidgetEdit({ name: "w", file }, "Sorry."), { failed: { template: "(none)", message: "The answer had no <template>…</template>." } });
  const broken = finishWidgetEdit({ name: "w", file }, '<reply>x</reply>\n<template>\n{"type":"Nope"}\n</template>');
  assert.ok("failed" in broken && broken.failed.template === '{"type":"Nope"}');
});

test("D-62: an action or procedure answer: unchanged is done, else checked like a save; missing actions are named", () => {
  assert.deepEqual(readAgentFileEdit("a: 1\n", "<reply>Fine as it is.</reply>\n<file>\na: 1\n</file>"), { result: { reply: "Fine as it is.", file: "a: 1\n", changed: false } });
  assert.deepEqual(readAgentFileEdit("a: 1\n", "<reply>Two now.</reply>\n<file>\na: 2\n</file>"), { check: { reply: "Two now.", file: "a: 2\n" } });
  assert.ok("failed" in readAgentFileEdit("a: 1\n", "no file"));
  const files = { "skills/refund/SKILL.md": "---\nname: refund\ndescription: Refunds.\n---\n1. Check the order with @lookup_order.\n" };
  assert.match(withMissingNote(files, "refund", "Done."), /@lookup_order isn't an action yet/);
});
