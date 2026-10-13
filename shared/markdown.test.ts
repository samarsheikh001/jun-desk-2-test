import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPlain, parseInline, parseMarkdown, safeHref, tokenCount, type MdBlock, type MdToken } from "./markdown.ts";

/** Tokens back to a compact string: B(bold) I(italic) L(text|href) C(code) [n] and ⏎ for a break. */
function show(tokens: MdToken[]): string {
  return tokens
    .map((t) => {
      if (t.kind === "br") return "⏎";
      if (t.kind === "cite") return `[${t.n}]${t.space}`;
      let s = t.kind === "code" ? `C(${t.text})` : t.text;
      if (t.em) s = `I(${s})`;
      if (t.strong) s = `B(${s})`;
      if (t.href) s = `L(${s}|${t.href})`;
      return s + t.space;
    })
    .join("");
}

const blocks = (body: string, streaming = false) =>
  parseMarkdown(body, { streaming }).map((b: MdBlock) => (b.kind === "li" ? `${b.ordered ? `${b.n}.` : "-"}${b.depth}:${show(b.tokens)}` : `${b.kind}:${show(b.tokens)}`));

test("bold and italic", () => {
  assert.equal(show(parseInline("a **bold** and __also__ word")), "a B(bold) and B(also) word");
  assert.equal(show(parseInline("an *italic* and _this_ one")), "an I(italic) and I(this) one");
  assert.equal(show(parseInline("***both***")), "B(I(both))");
  assert.equal(show(parseInline("GPT-5.6 Sol: **$4 / $20**")), "GPT-5.6 Sol: B($4) B(/) B($20)");
  assert.equal(show(parseInline("(**bold**)")), "(B(bold))");
  assert.equal(show(parseInline("**bold**ly")), "B(bold)ly");
});

test("snake_case, arithmetic and lone markers stay text", () => {
  assert.equal(show(parseInline("set max_retry_count to 3")), "set max_retry_count to 3");
  assert.equal(show(parseInline("2*3*4 = 24")), "2*3*4 = 24");
  assert.equal(show(parseInline("a * b * c")), "a * b * c");
  assert.equal(show(parseInline("**not closed")), "**not closed");
  assert.equal(show(parseInline(String.raw`\*literal\*`)), "*literal*");
});

test("inline code keeps its markers' contents", () => {
  assert.equal(show(parseInline("call `get_user_by_id` with **care**")), "call C(get_user_by_id) with B(care)");
  assert.equal(show(parseInline("``a ` b``")), "C(a ` b)");
});

test("links: http(s) only", () => {
  assert.equal(show(parseInline("see [the docs](https://example.com/a_b) now")), "see L(the|https://example.com/a_b) L(docs|https://example.com/a_b) now");
  assert.equal(show(parseInline("[x](javascript:alert(1))")), "[x](javascript:alert(1))");
  assert.equal(show(parseInline("[x](data:text/html,hi)")), "[x](data:text/html,hi)");
  assert.equal(show(parseInline("go to https://example.com/x_y_z.")), "go to L(https://example.com/x_y_z|https://example.com/x_y_z).");
  assert.equal(show(parseInline("[**bold** link](https://a.dev)")), "L(B(bold)|https://a.dev/) L(link|https://a.dev/)");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("HTTPS://a.dev"), "https://a.dev/");
});

test("citations", () => {
  assert.equal(show(parseInline("Prices [1] and more [2].")), "Prices [1] and more [2].");
});

test("paragraphs, line breaks, headings, quotes", () => {
  assert.deepEqual(blocks("one\ntwo\n\nthree"), ["p:one⏎two", "p:three"]);
  assert.deepEqual(blocks("## Pricing\nText"), ["h:Pricing", "p:Text"]);
  assert.deepEqual(blocks("#hashtag"), ["p:#hashtag"]);
  assert.deepEqual(blocks("> quoted **bit**\n> more"), ["quote:quoted B(bit)⏎more"]);
  assert.deepEqual(blocks("a\n\n---\n\nb"), ["p:a", "hr:⏎", "p:b"]);
  assert.deepEqual(blocks("```\nconst a = 1;\n```"), ["pre:const a = 1;"]);
});

test("bulleted and numbered lists, nested, with citations", () => {
  const body = "Here are some API model prices (input/output): [1]\n\n- GPT-5.6 Sol: **$4 / $20**\n- Claude Haiku 4.5: **$1 / $5** [2]\n  * nested *item*\n\n1. First\n2. Second\n3) Third";
  assert.deepEqual(blocks(body), [
    "p:Here are some API model prices (input/output): [1]",
    "-0:GPT-5.6 Sol: B($4) B(/) B($20)",
    "-0:Claude Haiku 4.5: B($1) B(/) B($5) [2]",
    "-1:nested I(item)",
    "1.0:First",
    "2.0:Second",
    "3.0:Third",
  ]);
  assert.deepEqual(blocks("- item\n  continued\n- next"), ["-0:item⏎continued", "-0:next"]);
});

test("streaming: unfinished markers are held back, open bold drawn bold", () => {
  assert.equal(show(parseInline("price **$4", true)), "price B($4)");
  assert.equal(show(parseInline("price **$4 / $20*", true)), "price B($4) B(/) B($20)");
  assert.equal(show(parseInline("price **$4 / $20**", true)), "price B($4) B(/) B($20)");
  assert.equal(show(parseInline("see [the do", true)), "see the do");
  assert.equal(show(parseInline("see [the docs](https://exa", true)), "see the docs");
  assert.equal(show(parseInline("as noted [1", true)), "as noted");
  assert.equal(show(parseInline("run `npm i", true)), "run C(npm i)");
  assert.equal(show(parseInline("snake_", true)), "snake");
  assert.deepEqual(blocks("Prices:\n\n- a\n-", true), ["p:Prices:", "-0:a"]);
  assert.deepEqual(blocks("Prices:\n\n1", true), ["p:Prices:"]);
  // Not streaming: the same text as written.
  assert.equal(show(parseInline("price **$4")), "price **$4");
});

test("streaming keeps earlier tokens stable as text grows", () => {
  const full = "Prices:\n\n- GPT: **$4 / $20** [1]\n- Haiku: *$1*";
  let prev: string[] = [];
  for (let n = 1; n <= full.length; n++) {
    const flat = parseMarkdown(full.slice(0, n), { streaming: true }).flatMap((b) => b.tokens.map((t) => (t.kind === "word" || t.kind === "code" ? t.text : t.kind)));
    // Each token but the last (a word still being written) stays the same.
    for (let i = 0; i < prev.length - 1; i++) assert.equal(flat[i], prev[i], `at ${n}: ${JSON.stringify(full.slice(0, n))}`);
    prev = flat;
  }
});

test("token count and plain text for copying", () => {
  const body = "Prices [1]:\n\n- GPT: **$4 / $20**\n- [Docs](https://a.dev) `x_y`\n\n> note";
  assert.equal(tokenCount(parseMarkdown(body)), 1 + 1 + 2 + 3 + 2 + 1);
  assert.equal(markdownToPlain(body), "Prices:\n\n- GPT: $4 / $20\n- Docs x_y\n\n> note");
});
