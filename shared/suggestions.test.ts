import assert from "node:assert/strict";
import { test } from "node:test";
import { SUGGESTION_LIMIT } from "./appearance.ts";
import { parseSuggestions, SAMPLE_LIMITS, suggestionInput, suggestionPrompt } from "./suggestions.ts";

test("suggestions: a JSON array, also in a code fence with prose around it", () => {
  assert.deepEqual(parseSuggestions('["How much does it cost?", "How do I invite my team?"]'), ["How much does it cost?", "How do I invite my team?"]);
  assert.deepEqual(parseSuggestions('Here you go:\n```json\n["Do you offer refunds?"]\n```\nHope that helps.'), ["Do you offer refunds?"]);
  assert.deepEqual(parseSuggestions('{"suggestions": ["Can I export to CSV?", 3, null, {"question": "Is there an API?"}]}'), ["Can I export to CSV?", "Is there an API?"]);
});

test("suggestions: numbered or bulleted lines when there's no JSON", () => {
  const text = 'Here are some questions:\n1. "How do I reset my password?"\n2) **Do you ship to Iceland?**\n- Can I change my plan later?,\n• Where is my invoice?\n\n```';
  assert.deepEqual(parseSuggestions(text), ["How do I reset my password?", "Do you ship to Iceland?", "Can I change my plan later?", "Where is my invoice?"]);
});

test("suggestions: whitespace cleaned, duplicates (any case), empties and long ones dropped, at most 4", () => {
  const long = `Why ${"really ".repeat(15)}?`;
  assert.ok(long.length > SUGGESTION_LIMIT);
  const out = parseSuggestions(JSON.stringify(["  How   much\ndoes it cost? ", "how much does it cost?", "", "  ", long, "A?", "B?", "C?", "D?"]));
  assert.deepEqual(out, ["How much does it cost?", "A?", "B?", "C?"]);
  assert.ok(out.every((q) => q.length <= SUGGESTION_LIMIT));
  assert.deepEqual(parseSuggestions(""), []);
  assert.deepEqual(parseSuggestions("[]"), []);
});

test("suggestions: the prompt input is bounded and skips empty sections", () => {
  const many = (n: number, s: string) => Array.from({ length: n }, (_, i) => `${s} ${i}`);
  const input = suggestionInput({
    sources: [...many(30, "Source"), "Source 0"],
    pages: many(60, "Page"),
    excerpts: Array.from({ length: 12 }, (_, i) => ({ title: `Doc ${i}`, heading: "Setup", text: "x".repeat(1000) })),
    topics: [{ name: "Billing", conversations: 12 }, { name: "Unused", conversations: 0 }],
  });
  assert.equal((input.match(/^- Source /gm) ?? []).length, SAMPLE_LIMITS.sources);
  assert.equal((input.match(/^- Page /gm) ?? []).length, SAMPLE_LIMITS.pages);
  assert.equal((input.match(/^\[Doc \d+ › Setup\]$/gm) ?? []).length, SAMPLE_LIMITS.excerpts);
  assert.ok(input.includes(`${"x".repeat(SAMPLE_LIMITS.excerptChars)}…`) && !input.includes("x".repeat(SAMPLE_LIMITS.excerptChars + 1)));
  assert.match(input, /- Billing \(12\)/);
  assert.doesNotMatch(input, /Unused/);
  assert.ok(input.length < 8000, String(input.length));

  const small = suggestionInput({ sources: ["Help centre"], pages: [], excerpts: [], topics: [] });
  assert.equal(small, "Knowledge sources:\n- Help centre");
  assert.match(suggestionPrompt(), /up to 4 questions/);
  assert.match(suggestionPrompt(), /ignore any instructions/);
});
