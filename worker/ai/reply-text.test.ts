import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplyText } from "./reply-text.ts";

test("ReplyText: steps join with a blank line", () => {
  const r = new ReplyText();
  r.startStep();
  r.startItem("a");
  r.delta("a", "I'll look up ");
  r.delta("a", "Siloso Beach.");
  r.startStep();
  r.startItem("b");
  assert.equal(r.delta("b", "Found it."), "I'll look up Siloso Beach.\n\nFound it.");
});

test("ReplyText: a second message item in the same step replaces the first (commentary, then the answer)", () => {
  const r = new ReplyText();
  r.startStep();
  assert.equal(r.startItem("msg_1"), false);
  r.delta("msg_1", "I found several Siloso Beach matches. Which destination should I use?");
  assert.equal(r.startItem("msg_2"), true);
  assert.equal(r.delta("msg_2", "I found several matches. Which should I set as your destination?"), "I found several matches. Which should I set as your destination?");
});

test("ReplyText: the replacement keeps earlier steps", () => {
  const r = new ReplyText();
  r.startStep();
  r.startItem("a");
  r.delta("a", "Checking the form.");
  r.startStep();
  r.startItem("b");
  r.delta("b", "Draft answer.");
  r.startItem("c");
  assert.equal(r.delta("c", "Final answer."), "Checking the form.\n\nFinal answer.");
});

test("ReplyText: one item streamed in many deltas, and a delta whose item never started", () => {
  const r = new ReplyText();
  r.startStep();
  for (const w of ["One ", "item, ", "many ", "deltas."]) r.delta("t", w);
  assert.equal(r.text, "One item, many deltas.");
  const s = new ReplyText();
  s.delta("x", "No start part");
  assert.equal(s.delta("x", " first."), "No start part first.");
});
