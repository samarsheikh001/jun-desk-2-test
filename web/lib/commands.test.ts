import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchShortcut, fuzzyScore, INITIAL_SHORTCUT_STATE, type KeyInput, matchesFilter, PREFIX_TIMEOUT_MS, rank, type ShortcutContext, type ShortcutState } from "./commands.ts";

test("fuzzy: subsequence matching, case and accent insensitive", () => {
  assert.notEqual(fuzzyScore("ann", "Ann Lee"), null);
  assert.notEqual(fuzzyScore("ANL", "Ann Lee"), null);
  assert.notEqual(fuzzyScore("jorg", "Jörg Müller"), null);
  assert.equal(fuzzyScore("xyz", "Ann Lee"), null);
  assert.equal(fuzzyScore("leea", "Ann Lee"), null, "order matters within a word");
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("fuzzy: words match in any order, all must match", () => {
  assert.notEqual(fuzzyScore("lee ann", "Ann Lee"), null);
  assert.equal(fuzzyScore("lee bob", "Ann Lee"), null);
});

test("fuzzy: substrings beat scattered matches; word starts and early matches score more", () => {
  const s = (q: string, t: string) => fuzzyScore(q, t)!;
  assert.ok(s("set", "Settings") > s("set", "Assign to teammate"));
  assert.ok(s("res", "Resolve") > s("res", "Mark pending (unresolved)"));
  assert.ok(s("inb", "Inbox") > s("inb", "Go to the main inbox"));
  assert.ok(s("gh", "Go home") > s("gh", "Bugshop"), "initials of words beat letters mid-word");
});

test("rank: best field wins, ties keep input order, non-matches drop out", () => {
  const people = [
    { name: "Bo Diddley", preview: "my invoice is wrong" },
    { name: "Ann Lee", preview: "hello" },
    { name: "Annabel", preview: "billing question" },
    { name: "Zed", preview: "nothing" },
  ];
  const by = (q: string) => rank(q, people, (p) => [p.name, p.preview]).map((p) => p.name);
  assert.deepEqual(by("ann"), ["Ann Lee", "Annabel"]);
  assert.deepEqual(by("invoice"), ["Bo Diddley"]);
  assert.deepEqual(by("bill"), ["Annabel"]);
  assert.deepEqual(by(""), ["Bo Diddley", "Ann Lee", "Annabel", "Zed"]);
  assert.deepEqual(by("qqq"), []);
});

test("matchesFilter: every word is a plain substring somewhere", () => {
  assert.ok(matchesFilter("ann", ["Ann Lee", "ann@example.com"]));
  assert.ok(matchesFilter("example lee", ["Ann Lee", "ann@example.com"]));
  assert.ok(!matchesFilter("anl", ["Ann Lee"]), "no fuzziness in the list filter");
  assert.ok(matchesFilter("  ", ["x"]));
  assert.ok(matchesFilter("refund", [null, "I want a refund"]));
});

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, typing: false, onControl: false, ...extra });
const inbox: ShortcutContext = { inbox: true, modal: "none" };
const elsewhere: ShortcutContext = { inbox: false, modal: "none" };
const run = (input: KeyInput, context = inbox, state: ShortcutState = INITIAL_SHORTCUT_STATE, now = 1000) => dispatchShortcut(input, state, context, now);

test("shortcuts: inbox single keys", () => {
  const expected: Record<string, string> = { j: "next", k: "previous", o: "open", Enter: "open", r: "reply", n: "note", e: "resolve", a: "assign-me", t: "tag", "/": "search" };
  for (const [k, command] of Object.entries(expected)) assert.equal(run(key(k)).command, command, k);
  assert.equal(run(key("J", { shiftKey: true })).command, null, "Shift+J is not j");
  assert.equal(run(key("x")).command, null);
});

test("shortcuts: inbox keys only on the inbox; ? and g-keys anywhere", () => {
  assert.equal(run(key("j"), elsewhere).command, null);
  assert.equal(run(key("e"), elsewhere).command, null);
  assert.equal(run(key("?", { shiftKey: true }), elsewhere).command, "help");
  const g = run(key("g"), elsewhere);
  assert.equal(g.command, null);
  assert.equal(run(key("v"), elsewhere, g.state, 1200).command, "go-visitors");
});

test("shortcuts: nothing fires while typing, with modifiers, or during IME composition", () => {
  assert.equal(run(key("j", { typing: true })).command, null);
  assert.equal(run(key("?", { typing: true, shiftKey: true })).command, null);
  assert.equal(run(key("e", { ctrlKey: true })).command, null);
  assert.equal(run(key("a", { metaKey: true })).command, null, "⌘A stays select-all");
  assert.equal(run(key("r", { altKey: true })).command, null);
  assert.equal(run(key("j", { isComposing: true })).command, null);
  assert.equal(run(key("k", { ctrlKey: true, isComposing: true })).command, null);
});

test("shortcuts: Enter on a focused button or link is left to the browser", () => {
  assert.equal(run(key("Enter", { onControl: true })).command, null);
  assert.equal(run(key("o", { onControl: true })).command, "open");
});

test("shortcuts: Ctrl+K / ⌘K opens the palette even while typing, and toggles it closed", () => {
  assert.equal(run(key("k", { ctrlKey: true, typing: true })).command, "palette");
  assert.equal(run(key("K", { metaKey: true })).command, "palette");
  assert.equal(run(key("k", { ctrlKey: true }), { inbox: true, modal: "palette" }).command, "palette");
  assert.equal(run(key("k", { ctrlKey: true, shiftKey: true })).command, null, "Ctrl+Shift+K is the browser's");
  assert.equal(run(key("k", { ctrlKey: true }), { inbox: true, modal: "other" }).command, null, "not over another dialog");
});

test("shortcuts: no single keys while a dialog is open", () => {
  assert.equal(run(key("j"), { inbox: true, modal: "palette" }).command, null);
  assert.equal(run(key("?", { shiftKey: true }), { inbox: true, modal: "other" }).command, null);
});

test("shortcuts: g then i/v/d/s; the prefix expires and takes precedence over r", () => {
  const g = run(key("g"));
  assert.deepEqual(g, { command: null, state: { prefix: "g", at: 1000 } });
  assert.equal(run(key("i"), inbox, g.state, 1100).command, "go-inbox");
  assert.equal(run(key("d"), inbox, g.state, 1100).command, "go-dashboard");
  assert.equal(run(key("r"), inbox, g.state, 1100).command, "go-dashboard", "g r (the old Reports shortcut) is Dashboard, not reply");
  assert.equal(run(key("s"), inbox, g.state, 1100).command, "go-settings");
  assert.equal(run(key("x"), inbox, g.state, 1100).command, null, "unknown second key: nothing");
  assert.deepEqual(run(key("x"), inbox, g.state, 1100).state, INITIAL_SHORTCUT_STATE);
  assert.equal(run(key("r"), inbox, g.state, 1000 + PREFIX_TIMEOUT_MS + 1).command, "reply", "expired prefix");
  assert.equal(run(key("i", { typing: true }), inbox, g.state, 1100).command, null);
});
