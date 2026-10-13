// A small Jinja interpreter for ChatKit widget templates (W-09, D-43). A `.widget` file from
// ChatKit Studio carries its view as a Jinja template that renders to the widget's JSON; the
// Studio compiles the JSX-like view into a narrow subset (`{{ (x) | tojson }}`, `if`/`else`,
// `for` with `loop`, block `set`, slices, `~`, `and`/`or`/`not`, `is defined`, inline if-else).
// Nunjucks can't run on Workers (it compiles templates with `new Function`), so this walks a
// parsed tree instead. It covers that subset plus common filters and tests, with step and size
// limits, since templates come from admins and data from the customer's API.
//
// Deliberately lenient where Jinja's StrictUndefined would throw: a missing field is undefined,
// `undefined | tojson` is `null`, and attribute access on undefined stays undefined, because
// real API responses leave fields out. Values follow JavaScript where the Studio's own preview
// does (numbers print as JS prints them); truthiness follows Jinja (empty lists are false).

export class TemplateError extends Error {}

/** The filters and tests templates may use (the widget editor's prompt lists them). */
export const jinjaNames = () => ({ filters: [...FILTERS].sort(), tests: [...TESTS].sort() });

/** Loop iterations, nodes visited and characters written per render, at most. */
export const MAX_TEMPLATE_STEPS = 50_000;
export const MAX_TEMPLATE_OUTPUT = 256 * 1024;

type Expr =
  | { k: "lit"; v: unknown }
  | { k: "name"; name: string }
  | { k: "attr"; obj: Expr; name: string }
  | { k: "item"; obj: Expr; key: Expr }
  | { k: "slice"; obj: Expr; start: Expr | null; stop: Expr | null; step: Expr | null }
  | { k: "list"; items: Expr[] }
  | { k: "dict"; entries: [Expr, Expr][] }
  | { k: "unary"; op: "not" | "-" | "+"; arg: Expr }
  | { k: "bin"; op: string; left: Expr; right: Expr }
  | { k: "cond"; test: Expr; then: Expr; else: Expr | null }
  | { k: "filter"; arg: Expr; name: string; args: Expr[] }
  | { k: "test"; arg: Expr; name: string; args: Expr[]; negate: boolean };

type Node =
  | { k: "text"; text: string }
  | { k: "out"; expr: Expr }
  | { k: "if"; branches: { test: Expr; body: Node[] }[]; else: Node[] }
  | { k: "for"; names: string[]; iter: Expr; body: Node[]; else: Node[] }
  | { k: "set"; names: string[]; expr: Expr }
  | { k: "setblock"; name: string; body: Node[] };

// ---------- template lexer: text, {{ … }}, {% … %}, {# … #} with - whitespace control ----------

type Chunk = { k: "text"; text: string } | { k: "var" | "block"; src: string; at: number };

function chunks(source: string): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  let trimNext = false;
  const open = /\{([{%#])(-?)/g;
  while (i <= source.length) {
    open.lastIndex = i;
    const m = open.exec(source);
    let text = source.slice(i, m ? m.index : source.length);
    if (trimNext) text = text.replace(/^\s+/, "");
    if (m?.[2] === "-") text = text.replace(/\s+$/, "");
    if (text) out.push({ k: "text", text });
    if (!m) break;
    const kind = m[1]!;
    const close = kind === "{" ? "}}" : kind === "%" ? "%}" : "#}";
    const start = m.index + m[0].length;
    const end = kind === "#" ? source.indexOf(close, start) : findClose(source, start, close);
    if (end < 0) throw new TemplateError(`Unclosed {${kind} at ${m.index}.`);
    let inner = source.slice(start, end);
    trimNext = inner.endsWith("-");
    if (trimNext) inner = inner.slice(0, -1);
    if (kind !== "#") out.push({ k: kind === "{" ? "var" : "block", src: inner, at: m.index });
    i = end + close.length;
  }
  return out;
}

/** The closing `}}` / `%}`, skipping string literals (a `"}}"` inside quotes doesn't close the tag). */
function findClose(source: string, from: number, close: string): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (source.startsWith(close, i)) return i;
  }
  return -1;
}

// ---------- expression tokens ----------

type Tok = { t: "num" | "str" | "name" | "op"; v: string };

const OPS = ["//", "**", "==", "!=", "<=", ">=", "(", ")", "[", "]", "{", "}", ",", ":", ".", "|", "~", "+", "-", "*", "/", "%", "<", ">", "="];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[++j]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "u" ? String.fromCharCode(parseInt(src.slice(j + 1, (j += 4) + 1), 16)) : e;
        } else s += src[j];
      }
      if (j >= src.length) throw new TemplateError("Unclosed string.");
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const num = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      toks.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      toks.push({ t: "name", v: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TemplateError(`Unexpected "${c}".`);
    toks.push({ t: "op", v: op });
    i += op.length;
  }
  return toks;
}

// ---------- expression parser (Jinja precedence) ----------

const FILTERS = new Set(["selectattr", "rejectattr", "tojson", "length", "count", "default", "d", "upper", "lower", "capitalize", "title", "trim", "string", "int", "float", "round", "abs", "join", "first", "last", "list", "reverse", "replace", "truncate", "safe", "e", "escape", "min", "max", "sum", "unique", "sort", "map", "select", "reject", "attr", "items", "dictsort", "batch", "wordcount", "center", "indent"]);
/** Jinja's operator spellings of tests, as `selectattr` takes them. */
const TEST_ALIASES: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", ">": "gt", "<=": "le", ">=": "ge" };
const TESTS = new Set(["defined", "undefined", "none", "number", "string", "mapping", "iterable", "sequence", "boolean", "true", "false", "even", "odd", "divisibleby", "eq", "equalto", "ne", "lt", "gt", "le", "ge", "in", "sameas", "integer", "float", "lower", "upper"]);

class Parser {
  i = 0;
  depth = 0;
  toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(offset = 0): Tok | undefined {
    return this.toks[this.i + offset];
  }
  is(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return Boolean(t && (t.t === "op" || t.t === "name") && t.v === v);
  }
  eat(v: string): boolean {
    if (!this.is(v)) return false;
    this.i++;
    return true;
  }
  expect(v: string): void {
    if (!this.eat(v)) throw new TemplateError(`Expected "${v}"${this.peek() ? ` before "${this.peek()!.v}"` : " at the end"}.`);
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  name(): string {
    const t = this.peek();
    if (!t || t.t !== "name") throw new TemplateError(`Expected a name${t ? `, got "${t.v}"` : ""}.`);
    this.i++;
    return t.v;
  }

  expr(): Expr {
    if (++this.depth > 100) throw new TemplateError("Expression too deeply nested.");
    try {
      const then = this.or();
      if (!this.eat("if")) return then;
      const test = this.or();
      return { k: "cond", test, then, else: this.eat("else") ? this.expr() : null };
    } finally {
      this.depth--;
    }
  }
  /** An expression without the inline `if` (for `for … in <expr> if …` and filter args alike). */
  or(): Expr {
    let left = this.and();
    while (this.eat("or")) left = { k: "bin", op: "or", left, right: this.and() };
    return left;
  }
  and(): Expr {
    let left = this.not();
    while (this.eat("and")) left = { k: "bin", op: "and", left, right: this.not() };
    return left;
  }
  not(): Expr {
    if (this.is("not") && !this.is("in", 1)) {
      this.i++;
      return { k: "unary", op: "not", arg: this.not() };
    }
    return this.compare();
  }
  compare(): Expr {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.v)) {
        this.i++;
        left = { k: "bin", op: t.v, left, right: this.concat() };
      } else if (this.is("in")) {
        this.i++;
        left = { k: "bin", op: "in", left, right: this.concat() };
      } else if (this.is("not") && this.is("in", 1)) {
        this.i += 2;
        left = { k: "unary", op: "not", arg: { k: "bin", op: "in", left, right: this.concat() } };
      } else if (this.is("is")) {
        this.i++;
        const negate = this.eat("not");
        const name = this.peek()?.t === "name" ? this.name() : "";
        if (!TESTS.has(name)) throw new TemplateError(`Unknown test "${name}".`);
        const args: Expr[] = [];
        if (this.eat("(")) args.push(...this.args());
        else if (["divisibleby", "eq", "equalto", "ne", "lt", "gt", "le", "ge", "in", "sameas"].includes(name)) args.push(this.concat());
        left = { k: "test", arg: left, name, args, negate };
      } else return left;
    }
  }
  concat(): Expr {
    let left = this.add();
    while (this.eat("~")) left = { k: "bin", op: "~", left, right: this.add() };
    return left;
  }
  add(): Expr {
    let left = this.mul();
    while (this.is("+") || this.is("-")) left = { k: "bin", op: this.toks[this.i++]!.v, left, right: this.mul() };
    return left;
  }
  mul(): Expr {
    let left = this.pow();
    while (this.is("*") || this.is("/") || this.is("//") || this.is("%")) left = { k: "bin", op: this.toks[this.i++]!.v, left, right: this.pow() };
    return left;
  }
  pow(): Expr {
    const left = this.unary();
    return this.eat("**") ? { k: "bin", op: "**", left, right: this.pow() } : left;
  }
  unary(): Expr {
    if (this.is("-") || this.is("+")) {
      const op = this.toks[this.i++]!.v as "-" | "+";
      return { k: "unary", op, arg: this.unary() };
    }
    let e = this.postfix(this.primary());
    while (this.eat("|")) {
      const name = this.name();
      if (!FILTERS.has(name)) throw new TemplateError(`Unknown filter "${name}".`);
      e = { k: "filter", arg: e, name, args: this.eat("(") ? this.args() : [] };
    }
    return e;
  }
  args(): Expr[] {
    const out: Expr[] = [];
    while (!this.eat(")")) {
      // keyword arguments (`round(2, method="floor")`) keep their position; names are ignored
      if (this.peek()?.t === "name" && this.is("=", 1)) this.i += 2;
      out.push(this.expr());
      if (!this.is(")")) this.expect(",");
    }
    return out;
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat(".")) {
        const t = this.peek();
        if (t?.t === "num") {
          this.i++;
          e = { k: "item", obj: e, key: { k: "lit", v: Number(t.v) } };
        } else e = { k: "attr", obj: e, name: this.name() };
      } else if (this.eat("[")) {
        let start: Expr | null = null;
        if (!this.is(":")) start = this.expr();
        if (this.eat(":")) {
          const stop = this.is("]") || this.is(":") ? null : this.expr();
          const step = this.eat(":") && !this.is("]") ? this.expr() : null;
          e = { k: "slice", obj: e, start, stop, step };
        } else e = { k: "item", obj: e, key: start! };
        this.expect("]");
      } else if (this.is("(")) {
        throw new TemplateError("Function calls aren't supported in widget templates.");
      } else return e;
    }
  }
  primary(): Expr {
    const t = this.peek();
    if (!t) throw new TemplateError("Expression ended early.");
    this.i++;
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") {
      let s = t.v;
      while (this.peek()?.t === "str") s += this.toks[this.i++]!.v; // "a" "b" concatenates
      return { k: "lit", v: s };
    }
    if (t.t === "name") {
      if (t.v === "true" || t.v === "True") return { k: "lit", v: true };
      if (t.v === "false" || t.v === "False") return { k: "lit", v: false };
      if (t.v === "none" || t.v === "None" || t.v === "null") return { k: "lit", v: null };
      return { k: "name", name: t.v };
    }
    if (t.v === "(") {
      const e = this.expr();
      if (this.is(",")) {
        const items = [e];
        while (this.eat(",") && !this.is(")")) items.push(this.expr());
        this.expect(")");
        return { k: "list", items };
      }
      this.expect(")");
      return e;
    }
    if (t.v === "[") {
      const items: Expr[] = [];
      while (!this.eat("]")) {
        items.push(this.expr());
        if (!this.is("]")) this.expect(",");
      }
      return { k: "list", items };
    }
    if (t.v === "{") {
      const entries: [Expr, Expr][] = [];
      while (!this.eat("}")) {
        const key = this.expr();
        this.expect(":");
        entries.push([key, this.expr()]);
        if (!this.is("}")) this.expect(",");
      }
      return { k: "dict", entries };
    }
    throw new TemplateError(`Unexpected "${t.v}".`);
  }
}

function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.expr();
  if (!p.done()) throw new TemplateError(`Unexpected "${p.peek()!.v}" in "${src.trim()}".`);
  return e;
}

// ---------- statements ----------

function parseNodes(list: Chunk[]): Node[] {
  let i = 0;
  const err = (c: Chunk, message: string) => new TemplateError(`${message} (at ${"at" in c ? c.at : "?"})`);

  function block(stop: string[]): { nodes: Node[]; end: string; src: string } {
    const nodes: Node[] = [];
    while (i < list.length) {
      const c = list[i++]!;
      if (c.k === "text") nodes.push({ k: "text", text: c.text });
      else if (c.k === "var") nodes.push({ k: "out", expr: parseExpr(c.src) });
      else {
        const src = c.src.trim();
        const word = /^[a-z]+/.exec(src)?.[0] ?? "";
        const rest = src.slice(word.length);
        if (stop.includes(word)) return { nodes, end: word, src: rest };
        if (word === "if") {
          const branches = [{ test: parseExpr(rest), body: [] as Node[] }];
          let elseBody: Node[] = [];
          for (;;) {
            const r = block(["elif", "else", "endif"]);
            if (r.end === "else") {
              branches.at(-1)!.body = r.nodes;
              const tail = block(["endif"]);
              elseBody = tail.nodes;
              break;
            }
            branches.at(-1)!.body = r.nodes;
            if (r.end === "endif") break;
            if (!r.end) throw err(c, "Missing {% endif %}.");
            branches.push({ test: parseExpr(r.src), body: [] });
          }
          nodes.push({ k: "if", branches, else: elseBody });
        } else if (word === "for") {
          const m = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+([\s\S]+)$/.exec(rest);
          if (!m) throw err(c, "Expected {% for x in items %}.");
          const names = m[1]!.split(",").map((n) => n.trim());
          // `for x in xs if cond` filters the items.
          const p = new Parser(tokenize(m[2]!));
          let iter = p.or();
          if (p.eat("if")) {
            const test = p.expr();
            iter = { k: "filter", arg: iter, name: "__where", args: [{ k: "lit", v: { names, test } }] };
          }
          if (!p.done()) throw err(c, `Unexpected "${p.peek()!.v}" in for.`);
          const r = block(["else", "endfor"]);
          let elseBody: Node[] = [];
          if (r.end === "else") elseBody = block(["endfor"]).nodes;
          else if (!r.end) throw err(c, "Missing {% endfor %}.");
          nodes.push({ k: "for", names, iter, body: r.nodes, else: elseBody });
        } else if (word === "set") {
          const m = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:=\s*([\s\S]+))?$/.exec(rest);
          if (!m) throw err(c, "Expected {% set name = value %}.");
          const names = m[1]!.split(",").map((n) => n.trim());
          if (m[2] !== undefined) nodes.push({ k: "set", names, expr: parseExpr(m[2]) });
          else {
            if (names.length !== 1) throw err(c, "A block set takes one name.");
            const r = block(["endset"]);
            if (!r.end) throw err(c, "Missing {% endset %}.");
            nodes.push({ k: "setblock", name: names[0]!, body: r.nodes });
          }
        } else if (word === "raw") {
          throw err(c, "{% raw %} isn't supported.");
        } else {
          throw err(c, word ? `Unsupported tag {% ${word} %}.` : "Empty tag.");
        }
      }
    }
    return { nodes, end: "", src: "" };
  }

  const r = block([]);
  return r.nodes;
}

// ---------- evaluation ----------

type Scope = Map<string, unknown>;

interface Ctx {
  scopes: Scope[];
  steps: number;
  /** Characters written so far, block sets included. */
  written: number;
}

function lookup(ctx: Ctx, name: string): unknown {
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    const s = ctx.scopes[i]!;
    if (s.has(name)) return s.get(name);
  }
  return undefined;
}

function tick(ctx: Ctx): void {
  if (++ctx.steps > MAX_TEMPLATE_STEPS) throw new TemplateError("Template took too many steps.");
}

/** Jinja truthiness: empty strings, lists and maps are false. */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** A value as text in output and `~`: missing and null print nothing, the rest as JavaScript prints them. */
export function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return (a ?? null) === (b ?? null);
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function getField(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj) || typeof obj === "string") {
    if (key === "length") return obj.length;
    if (typeof key === "number" && Number.isInteger(key)) return obj[key < 0 ? obj.length + key : key];
    return undefined;
  }
  if (typeof obj === "object") {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string, unknown>)[k] : undefined;
  }
  return undefined;
}

function sliceOf(v: unknown, start: unknown, stop: unknown, step: unknown): unknown {
  if (typeof v !== "string" && !Array.isArray(v)) return v;
  const n = v.length;
  const s = step === undefined || step === null ? 1 : Math.trunc(num(step));
  if (s === 0) throw new TemplateError("Slice step can't be zero.");
  const norm = (x: unknown, dflt: number) => {
    if (x === undefined || x === null) return dflt;
    let i = Math.trunc(num(x));
    if (i < 0) i += n;
    return s > 0 ? Math.min(Math.max(i, 0), n) : Math.min(Math.max(i, -1), n - 1);
  };
  const a = norm(start, s > 0 ? 0 : n - 1);
  const b = norm(stop, s > 0 ? n : -1);
  const items = Array.isArray(v) ? v : [...v];
  const out: unknown[] = [];
  for (let i = a; s > 0 ? i < b : i > b; i += s) out.push(items[i]);
  return typeof v === "string" ? out.join("") : out;
}

function iterable(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}

function evaluate(e: Expr, ctx: Ctx): unknown {
  tick(ctx);
  switch (e.k) {
    case "lit":
      return e.v;
    case "name":
      return e.name === "undefined" && lookup(ctx, "undefined") === undefined ? undefined : lookup(ctx, e.name);
    case "attr":
      return getField(evaluate(e.obj, ctx), e.name);
    case "item":
      return getField(evaluate(e.obj, ctx), evaluate(e.key, ctx));
    case "slice":
      return sliceOf(evaluate(e.obj, ctx), e.start && evaluate(e.start, ctx), e.stop && evaluate(e.stop, ctx), e.step && evaluate(e.step, ctx));
    case "list":
      return e.items.map((x) => evaluate(x, ctx));
    case "dict":
      return Object.fromEntries(e.entries.map(([k, v]) => [str(evaluate(k, ctx)), evaluate(v, ctx)]));
    case "unary": {
      const v = evaluate(e.arg, ctx);
      return e.op === "not" ? !truthy(v) : e.op === "-" ? -num(v) : num(v);
    }
    case "cond":
      return truthy(evaluate(e.test, ctx)) ? evaluate(e.then, ctx) : e.else ? evaluate(e.else, ctx) : undefined;
    case "bin":
      return binary(e.op, e.left, e.right, ctx);
    case "test":
      return runTest(e, ctx);
    case "filter":
      return runFilter(e, ctx);
  }
}

function binary(op: string, l: Expr, r: Expr, ctx: Ctx): unknown {
  if (op === "and") {
    const a = evaluate(l, ctx);
    return truthy(a) ? evaluate(r, ctx) : a;
  }
  if (op === "or") {
    const a = evaluate(l, ctx);
    return truthy(a) ? a : evaluate(r, ctx);
  }
  const a = evaluate(l, ctx);
  const b = evaluate(r, ctx);
  switch (op) {
    case "~": {
      const s = str(a) + str(b);
      if (s.length > MAX_TEMPLATE_OUTPUT) throw new TemplateError("Template output is too large.");
      return s;
    }
    case "+":
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      return num(a) + num(b);
    case "-":
      return num(a) - num(b);
    case "*":
      if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, Math.min(b, 1000)));
      return num(a) * num(b);
    case "/":
      return num(a) / num(b);
    case "//":
      return Math.floor(num(a) / num(b));
    case "%": {
      const m = num(a) % num(b);
      return m !== 0 && num(b) < 0 !== m < 0 ? m + num(b) : m;
    }
    case "**":
      return num(a) ** num(b);
    case "==":
      return same(a, b);
    case "!=":
      return !same(a, b);
    case "<":
      return (a as number) < (b as number);
    case ">":
      return (a as number) > (b as number);
    case "<=":
      return (a as number) <= (b as number);
    case ">=":
      return (a as number) >= (b as number);
    case "in":
      if (typeof b === "string") return b.includes(str(a));
      if (Array.isArray(b)) return b.some((x) => same(x, a));
      if (b && typeof b === "object") return Object.prototype.hasOwnProperty.call(b, str(a));
      return false;
  }
  throw new TemplateError(`Unknown operator ${op}.`);
}

function runTest(e: Extract<Expr, { k: "test" }>, ctx: Ctx): boolean {
  const v = evaluate(e.arg, ctx);
  const arg = e.args[0] ? evaluate(e.args[0], ctx) : undefined;
  let r: boolean;
  switch (e.name) {
    case "defined": r = v !== undefined; break;
    case "undefined": r = v === undefined; break;
    case "none": r = v === null; break;
    case "number": r = typeof v === "number"; break;
    case "integer": r = typeof v === "number" && Number.isInteger(v); break;
    case "float": r = typeof v === "number" && !Number.isInteger(v); break;
    case "string": r = typeof v === "string"; break;
    case "boolean": r = typeof v === "boolean"; break;
    case "true": r = v === true; break;
    case "false": r = v === false; break;
    case "mapping": r = Boolean(v) && typeof v === "object" && !Array.isArray(v); break;
    case "iterable": case "sequence": r = Array.isArray(v) || typeof v === "string" || (Boolean(v) && typeof v === "object"); break;
    case "even": r = num(v) % 2 === 0; break;
    case "odd": r = Math.abs(num(v) % 2) === 1; break;
    case "divisibleby": r = num(arg) !== 0 && num(v) % num(arg) === 0; break;
    case "eq": case "equalto": case "sameas": r = same(v, arg); break;
    case "ne": r = !same(v, arg); break;
    case "lt": r = (v as number) < (arg as number); break;
    case "gt": r = (v as number) > (arg as number); break;
    case "le": r = (v as number) <= (arg as number); break;
    case "ge": r = (v as number) >= (arg as number); break;
    case "in": r = Boolean(binary("in", { k: "lit", v }, { k: "lit", v: arg }, ctx)); break;
    case "lower": r = typeof v === "string" && v === v.toLowerCase(); break;
    case "upper": r = typeof v === "string" && v === v.toUpperCase(); break;
    default: throw new TemplateError(`Unknown test "${e.name}".`);
  }
  return e.negate ? !r : r;
}

function runFilter(e: Extract<Expr, { k: "filter" }>, ctx: Ctx): unknown {
  const v = evaluate(e.arg, ctx);
  if (e.name === "__where") {
    const { names, test } = (e.args[0] as { k: "lit"; v: { names: string[]; test: Expr } }).v;
    return iterable(v).filter((item) => {
      const scope: Scope = new Map();
      bindLoopNames(scope, names, item);
      ctx.scopes.push(scope);
      try {
        return truthy(evaluate(test, ctx));
      } finally {
        ctx.scopes.pop();
      }
    });
  }
  const args = e.args.map((a) => evaluate(a, ctx));
  switch (e.name) {
    case "tojson":
      return JSON.stringify(v === undefined ? null : v) ?? "null";
    case "length":
    case "count":
      return Array.isArray(v) || typeof v === "string" ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
    case "default":
    case "d":
      return v === undefined || (args[1] && !truthy(v)) ? args[0] : v;
    case "upper":
      return str(v).toUpperCase();
    case "lower":
      return str(v).toLowerCase();
    case "capitalize": {
      const s = str(v);
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    }
    case "title":
      return str(v).toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
    case "trim":
      return str(v).trim();
    case "string":
      return str(v);
    case "int": {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : (args[0] ?? 0);
    }
    case "float": {
      const n = Number(v);
      return Number.isFinite(n) ? n : (args[0] ?? 0);
    }
    case "round": {
      const digits = Math.max(0, Math.min(10, Math.trunc(num(args[0] ?? 0))));
      const method = str(args[1] ?? "common");
      const f = 10 ** digits;
      const x = num(v) * f;
      return (method === "floor" ? Math.floor(x) : method === "ceil" ? Math.ceil(x) : Math.round(x)) / f;
    }
    case "abs":
      return Math.abs(num(v));
    case "join": {
      const list = iterable(v).map((x) => (args[1] !== undefined ? getField(x, args[1]) : x));
      return list.map(str).join(args[0] === undefined ? "" : str(args[0]));
    }
    case "first":
      return iterable(v)[0];
    case "last":
      return iterable(v).at(-1);
    case "list":
      return [...iterable(v)];
    case "reverse":
      return typeof v === "string" ? [...v].reverse().join("") : [...iterable(v)].reverse();
    case "replace": {
      const s = str(v);
      const from = str(args[0]);
      return from ? s.split(from).join(str(args[1])) : s;
    }
    case "truncate": {
      const s = str(v);
      const n = Math.max(1, Math.trunc(num(args[0] ?? 255)));
      return s.length <= n ? s : `${s.slice(0, n).trimEnd()}${args[2] === undefined ? "..." : str(args[2])}`;
    }
    case "safe":
    case "e":
    case "escape":
      return v;
    case "min":
    case "max": {
      const list = iterable(v);
      if (!list.length) return undefined;
      return list.reduce((a, b) => ((e.name === "min" ? (b as number) < (a as number) : (b as number) > (a as number)) ? b : a));
    }
    case "sum":
      return iterable(v).reduce((a: number, b) => a + num(args[0] !== undefined ? getField(b, args[0]) : b), num(args[1] ?? 0));
    case "unique":
      return iterable(v).filter((x, i, all) => all.findIndex((y) => same(x, y)) === i);
    case "sort": {
      const key = args[2];
      const list = [...iterable(v)];
      const val = (x: unknown) => (key !== undefined ? getField(x, key) : x);
      list.sort((a, b) => {
        const x = val(a) as number;
        const y = val(b) as number;
        return x < y ? -1 : x > y ? 1 : 0;
      });
      return truthy(args[0]) ? list.reverse() : list;
    }
    case "map":
    case "attr":
      if (e.name === "attr") return getField(v, args[0]);
      return iterable(v).map((x) => getField(x, args[0]));
    case "select":
    case "reject":
      return iterable(v).filter((x) => truthy(args[0] !== undefined ? getField(x, args[0]) : x) === (e.name === "select"));
    case "selectattr":
    case "rejectattr": {
      // selectattr("status"), selectattr("status", "equalto", "open"), selectattr("n", ">", 2)
      const keep = e.name === "selectattr";
      const name = args[1] === undefined ? null : (TEST_ALIASES[str(args[1])] ?? str(args[1]));
      if (name !== null && !TESTS.has(name)) throw new TemplateError(`Unknown test "${name}".`);
      return iterable(v).filter((x) => {
        const field = getField(x, args[0]);
        const hit = name === null ? truthy(field) : runTest({ k: "test", arg: { k: "lit", v: field }, name, args: args.length > 2 ? [{ k: "lit", v: args[2] }] : [], negate: false }, ctx);
        return hit === keep;
      });
    }
    case "items":
      return v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
    case "dictsort":
      return v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [];
    case "batch": {
      const size = Math.max(1, Math.trunc(num(args[0] ?? 1)));
      const list = iterable(v);
      const out: unknown[][] = [];
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
      return out;
    }
    case "wordcount":
      return str(v).split(/\s+/).filter(Boolean).length;
    case "center":
    case "indent":
      return str(v);
  }
  throw new TemplateError(`Unknown filter "${e.name}".`);
}

function bindLoopNames(scope: Scope, names: string[], item: unknown): void {
  if (names.length === 1) scope.set(names[0]!, item);
  else names.forEach((n, i) => scope.set(n, getField(item, i)));
}

function write(ctx: Ctx, out: string[], text: string): void {
  ctx.written += text.length;
  if (ctx.written > MAX_TEMPLATE_OUTPUT * 2) throw new TemplateError("Template output is too large.");
  out.push(text);
}

function run(nodes: Node[], ctx: Ctx, out: string[]): void {
  for (const node of nodes) {
    tick(ctx);
    switch (node.k) {
      case "text":
        write(ctx, out, node.text);
        break;
      case "out":
        write(ctx, out, str(evaluate(node.expr, ctx)));
        break;
      case "if": {
        const hit = node.branches.find((b) => truthy(evaluate(b.test, ctx)));
        run(hit ? hit.body : node.else, ctx, out);
        break;
      }
      case "for": {
        const items = iterable(evaluate(node.iter, ctx));
        if (!items.length) {
          run(node.else, ctx, out);
          break;
        }
        const scope: Scope = new Map();
        ctx.scopes.push(scope);
        try {
          items.forEach((item, i) => {
            scope.clear();
            bindLoopNames(scope, node.names, item);
            scope.set("loop", {
              index: i + 1,
              index0: i,
              revindex: items.length - i,
              revindex0: items.length - i - 1,
              first: i === 0,
              last: i === items.length - 1,
              length: items.length,
              previtem: items[i - 1],
              nextitem: items[i + 1],
            });
            run(node.body, ctx, out);
          });
        } finally {
          ctx.scopes.pop();
        }
        break;
      }
      case "set": {
        const v = evaluate(node.expr, ctx);
        const scope = ctx.scopes.at(-1)!;
        if (node.names.length === 1) scope.set(node.names[0]!, v);
        else node.names.forEach((n, i) => scope.set(n, getField(v, i)));
        break;
      }
      case "setblock": {
        const inner: string[] = [];
        run(node.body, ctx, inner);
        ctx.scopes.at(-1)!.set(node.name, inner.join(""));
        break;
      }
    }
  }
}

export interface Template {
  render(data: Record<string, unknown>): string;
}

/** Parses a template once (throws TemplateError for syntax it doesn't support); render it many times. */
export function compileTemplate(source: string): Template {
  const nodes = parseNodes(chunks(source));
  return {
    render(data) {
      const ctx: Ctx = { scopes: [new Map(Object.entries(data)), new Map()], steps: 0, written: 0 };
      const out: string[] = [];
      run(nodes, ctx, out);
      const text = out.join("");
      if (text.length > MAX_TEMPLATE_OUTPUT) throw new TemplateError("Template output is too large.");
      return text;
    },
  };
}
