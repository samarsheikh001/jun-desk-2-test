// A small, safe Markdown subset for AI answers (widget and inbox). Pure: text in, blocks of
// word tokens out, never HTML. Blocks: paragraphs, bulleted and numbered lists (nested by
// indent), headings (#–######, drawn as a bold line), > quotes, ``` code blocks and --- rules.
// Inline: **bold** / __bold__, *italic* / _italic_ (CommonMark-style flanking; never inside a
// word, so snake_case and 2*3*4 stay as they are), `code`, [n] citations, [text](https://…) and
// bare https URLs (http/https only; anything else stays text), \-escapes. A single newline is a
// line break. Tables stay text.
//
// Words are tokens so the widget can reveal them one by one; each carries its formatting. With
// `streaming`, an unfinished marker at the end (a trailing `**`, an open `[link`, a lone `-` that
// may become a list item) is held back, and an opened `**bold` is drawn bold right away, so the
// text never flashes literal markers and then jumps.

export type MdToken =
  | { kind: "word"; text: string; space: string; strong?: true; em?: true; href?: string }
  | { kind: "code"; text: string; space: string; strong?: true; em?: true; href?: string }
  | { kind: "cite"; n: number; space: string }
  | { kind: "br" };

export type MdBlock =
  | { kind: "p" | "h" | "quote"; tokens: MdToken[] }
  | { kind: "li"; ordered: boolean; n: number; depth: number; tokens: MdToken[] }
  /** A code block: one word token per line. */
  | { kind: "pre"; tokens: MdToken[] }
  /** A rule: one `br` token, so it takes a step in the reveal. */
  | { kind: "hr"; tokens: MdToken[] };

export interface MarkdownOptions {
  /** The text is still being written: hold back unfinished markers at its end. */
  streaming?: boolean;
}

/** http(s) URLs only; anything else (javascript:, data:, relative) is not a link. */
export function safeHref(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
/** While streaming: a last line that may still turn into a block marker. */
const PENDING_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)]?|#{1,6}|>|`{1,2}|~{1,2})$/;

type Open = { kind: "p" | "quote" | "li"; lines: string[]; ordered?: boolean; n?: number; depth?: number };

/** Parses `body` into blocks of tokens. */
export function parseMarkdown(body: string, options: MarkdownOptions = {}): MdBlock[] {
  const streaming = Boolean(options.streaming);
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (streaming && lines.length && PENDING_LINE.test(lines.at(-1)!)) lines.pop();
  const blocks: MdBlock[] = [];
  let open: Open | null = null;
  let blank = false;
  // Indents of the list items above, for nesting.
  let indents: number[] = [];
  const close = () => {
    if (!open) return;
    const tokens = parseInline(open.lines.join("\n"), streaming);
    if (tokens.length) {
      if (open.kind === "li") blocks.push({ kind: "li", ordered: open.ordered!, n: open.n!, depth: open.depth!, tokens });
      else blocks.push({ kind: open.kind, tokens });
    }
    open = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      indents = [];
      const marker = fence[1]!;
      const code: string[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && /^[ \t]*[`~]+[ \t]*$/.test(l)) break;
        code.push(l);
      }
      if (code.length) blocks.push({ kind: "pre", tokens: code.map((text) => ({ kind: "word", text, space: "" })) });
      blank = false;
      continue;
    }
    if (!line.trim()) {
      if (open?.kind !== "li") close();
      blank = true;
      continue;
    }
    if (RULE.test(line)) {
      close();
      indents = [];
      blocks.push({ kind: "hr", tokens: [{ kind: "br" }] });
      blank = false;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      indents = [];
      const tokens = parseInline(heading[2] ?? "", streaming);
      if (tokens.length) blocks.push({ kind: "h", tokens });
      blank = false;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      if (open?.kind !== "quote" || blank) close();
      indents = [];
      if (!open) open = { kind: "quote", lines: [] };
      open.lines.push(quote[1]!);
      blank = false;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      close();
      const indent = item[1]!.replace(/\t/g, "    ").length;
      while (indents.length && indent < indents.at(-1)!) indents.pop();
      if (!indents.length || indent > indents.at(-1)!) indents.push(indent);
      const marker = item[2]!;
      const ordered = /\d/.test(marker);
      open = { kind: "li", lines: [item[3]!], ordered, n: ordered ? Number.parseInt(marker, 10) : 0, depth: Math.min(indents.length - 1, 3) };
      blank = false;
      continue;
    }
    // Plain text: carries on the paragraph, quote or list item above, unless a blank line came
    // first (an indented line after a blank still belongs to the item).
    const current = open as Open | null;
    if (current && (!blank || (current.kind === "li" && /^[ \t]{2,}/.test(line)))) {
      current.lines.push(line.trim());
    } else {
      close();
      indents = [];
      open = { kind: "p", lines: [line.trim()] };
    }
    blank = false;
  }
  close();
  return blocks;
}

/** How many reveal steps the blocks take. */
export function tokenCount(blocks: MdBlock[]): number {
  let n = 0;
  for (const b of blocks) n += b.tokens.length;
  return n;
}

/** The answer as plain text (for copying): no markers or citations, list items kept as `- ` / `1. `. */
export function markdownToPlain(body: string): string {
  const out: string[] = [];
  let prev: MdBlock | undefined;
  for (const b of parseMarkdown(body)) {
    if (b.kind === "hr") continue;
    let text = "";
    if (b.kind === "pre") text = b.tokens.map((t) => (t.kind === "word" ? t.text : "")).join("\n");
    else {
      for (const t of b.tokens) {
        if (t.kind === "br") text = `${text.trimEnd()}\n`;
        else if (t.kind === "cite") text = text.trimEnd() + t.space;
        else text += t.text + t.space;
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
    }
    if (b.kind === "li") text = `${"  ".repeat(b.depth)}${b.ordered ? `${b.n}.` : "-"} ${text}`;
    if (b.kind === "quote") text = text.replace(/^/gm, "> ");
    // List items sit on consecutive lines; other blocks get a blank line between.
    if (prev) out.push(prev.kind === "li" && b.kind === "li" ? "\n" : "\n\n");
    out.push(text);
    prev = b;
  }
  return out.join("");
}

// ---- Inline ----

type Marks = { strong: number; em: number; href?: string };
type Item =
  | (Marks & { k: "text"; s: string })
  | (Marks & { k: "code"; s: string })
  | (Marks & { k: "cite"; n: number })
  | (Marks & { k: "delim"; ch: "*" | "_"; n: number; open: boolean; close: boolean });

const PUNCT = /[\p{P}\p{S}]/u;
const URL_AT = /^https?:\/\/[^\s<>()[\]{}"'`]+/i;
const CITE = /^\[(\d{1,2})\]/;
// [label](url) or [label](url "title"); the url may hold one level of parentheses.
const LINK = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:[ \t]+"[^"\n]*")?\)/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function text(s: string): Item {
  return { k: "text", s, strong: 0, em: 0 };
}

/** Inline Markdown → word tokens. */
export function parseInline(source: string, streaming = false): MdToken[] {
  return toTokens(parseItems(source.trim(), streaming));
}

function parseItems(src: string, streaming: boolean): Item[] {
  // Held back while streaming: a trailing marker run or backslash, which may yet close or open something.
  if (streaming) src = src.replace(/(?:[*_]+|\\)$/, "");
  const items: Item[] = [];
  let buf = "";
  const flush = () => {
    if (buf) items.push(text(buf));
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    const prev = i > 0 ? src[i - 1]! : "";
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      // A matching run that isn't part of a longer one.
      let close = end;
      while (close !== -1 && (src[close + run.length] === "`" || src[close - 1] === "`")) close = src.indexOf(run, close + 1);
      if (close !== -1) {
        flush();
        const code = src.slice(i + run.length, close).replace(/\n/g, " ");
        const trimmed = /^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code;
        items.push({ k: "code", s: trimmed, strong: 0, em: 0 });
        i = close + run.length;
        continue;
      }
      if (streaming && !src.includes("\n", i)) {
        // Still being written: code up to the end.
        flush();
        const code = src.slice(i + run.length);
        if (code) items.push({ k: "code", s: code, strong: 0, em: 0 });
        i = src.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (ch === "[") {
      const cite = CITE.exec(rest);
      if (cite) {
        flush();
        items.push({ k: "cite", n: Number(cite[1]), strong: 0, em: 0 });
        i += cite[0].length;
        continue;
      }
      const link = LINK.exec(rest);
      if (link) {
        const href = safeHref(link[2]!);
        if (href) {
          flush();
          for (const it of settle(parseItems(link[1]!, false))) items.push({ ...it, href });
          i += link[0].length;
          continue;
        }
        // Not http(s): the whole thing stays text.
        buf += link[0];
        i += link[0].length;
        continue;
      }
      if (streaming) {
        // An unfinished [n] or [label](url at the end: hide the markers, show the label's words.
        const partial = /^\[([^\]\n]*)(?:\](?:\([^)\s]*)?)?$/.exec(rest);
        if (partial) {
          flush();
          const label = partial[1]!;
          if (!/^\d{0,2}$/.test(label)) items.push(...settle(parseItems(label, true)));
          i = src.length;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest);
      const href = auto && safeHref(auto[1]!);
      if (auto && href) {
        flush();
        items.push({ k: "text", s: auto[1]!, strong: 0, em: 0, href });
        i += auto[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (!prev || /[\s(*_]/.test(prev))) {
      const m = URL_AT.exec(rest);
      if (m) {
        const url = m[0].replace(/[.,;:!?]+$/, "");
        const href = safeHref(url);
        if (href && url.length > 8) {
          flush();
          items.push({ k: "text", s: url, strong: 0, em: 0, href });
          i += url.length;
          continue;
        }
      }
    }
    if (ch === "*" || ch === "_") {
      const run = ch === "*" ? /^\*+/.exec(rest)![0] : /^_+/.exec(rest)![0];
      const next = src[i + run.length] ?? "";
      const prevSpace = !prev || /\s/.test(prev);
      const nextSpace = !next || /\s/.test(next);
      const prevPunct = Boolean(prev) && PUNCT.test(prev);
      const nextPunct = Boolean(next) && PUNCT.test(next);
      const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      // `_` and a single `*` follow CommonMark's rule for `_`: never inside a word (snake_case,
      // 2*3*4); `**` may touch a word (**bold**ly).
      const loose = ch === "*" && run.length >= 2;
      flush();
      items.push({ k: "delim", ch, n: run.length, open: left && (loose || !right || prevPunct), close: right && (loose || !left || nextPunct), strong: 0, em: 0 });
      i += run.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  emphasis(items, streaming);
  return items;
}

/** A link label's leftover markers are text: they mustn't pair with markers outside it. */
function settle(items: Item[]): Item[] {
  return items.map((it) => (it.k === "delim" ? { k: "text", s: it.ch.repeat(it.n), strong: it.strong, em: it.em } : it));
}

/** CommonMark's delimiter pass (simplified): pair openers and closers into bold and italic. */
function emphasis(items: Item[], streaming: boolean): void {
  const mark = (from: number, to: number, use: number) => {
    for (let j = from; j < to; j++) {
      const it = items[j]!;
      if (use >= 2) it.strong++;
      if (use % 2 === 1) it.em++;
    }
  };
  for (let c = 0; c < items.length; c++) {
    const closer = items[c]!;
    if (closer.k !== "delim" || !closer.close) continue;
    while (closer.n > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const it = items[o]!;
        if (it.k === "delim" && it.open && it.n > 0 && it.ch === closer.ch) break;
      }
      if (o < 0) break;
      const opener = items[o] as Extract<Item, { k: "delim" }>;
      const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      mark(o + 1, c, use);
      opener.n -= use;
      closer.n -= use;
      // Markers between the pair can no longer pair up.
      for (let j = o + 1; j < c; j++) {
        const it = items[j]!;
        if (it.k === "delim") it.open = it.close = false;
      }
    }
  }
  if (streaming) {
    // Still open at the end of a reply being written: draw it as if closed, so it doesn't jump.
    for (let o = items.length - 1; o >= 0; o--) {
      const it = items[o]!;
      if (it.k !== "delim" || !it.open || it.n === 0) continue;
      mark(o + 1, items.length, Math.min(it.n, 3));
      it.n = 0;
    }
  }
}

function toTokens(items: Item[]): MdToken[] {
  const tokens: MdToken[] = [];
  const marks = (it: Marks) => ({ ...(it.strong ? { strong: true as const } : {}), ...(it.em ? { em: true as const } : {}), ...(it.href ? { href: it.href } : {}) });
  /** Whitespace goes on the token before it; a newline is a `br`. */
  const space = (ws: string) => {
    const parts = ws.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        const last = tokens.at(-1);
        if (last && last.kind !== "br") last.space = "";
        if (last) tokens.push({ kind: "br" });
        continue;
      }
      const last = tokens.at(-1);
      if (last && last.kind !== "br" && parts[p]) last.space += " ";
    }
  };
  // Merge neighbouring text with the same marks (escapes and leftover markers split it).
  const runs: Item[] = [];
  for (const it of items) {
    const t: Item = it.k === "delim" ? { k: "text", s: it.ch.repeat(it.n), strong: it.strong, em: it.em, ...(it.href ? { href: it.href } : {}) } : it;
    if (t.k === "text" && !t.s) continue;
    const prev = runs.at(-1);
    if (t.k === "text" && prev?.k === "text" && prev.strong === t.strong && prev.em === t.em && prev.href === t.href) prev.s += t.s;
    else runs.push(t.k === "text" ? { ...t } : t);
  }
  for (const it of runs) {
    if (it.k === "cite") {
      tokens.push({ kind: "cite", n: it.n, space: "" });
      continue;
    }
    if (it.k === "code") {
      tokens.push({ kind: "code", text: it.s, space: "", ...marks(it) });
      continue;
    }
    if (it.k !== "text") continue;
    for (const m of it.s.matchAll(/(\s+)|(\S+)/g)) {
      if (m[1]) space(m[1]);
      else tokens.push({ kind: "word", text: m[2]!, space: "", ...marks(it) });
    }
  }
  // No space or break at the very end.
  while (tokens.at(-1)?.kind === "br") tokens.pop();
  const last = tokens.at(-1);
  if (last && last.kind !== "br") last.space = "";
  return tokens;
}
