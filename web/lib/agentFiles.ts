import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

// The Agent page's forms (Instructions, Tasks, Actions, Tests) read and write the same files
// as the Code view, `jun pull` and `jun push`. Each edit changes only the field it names, through
// yaml's Document API, so a developer's comments, key order and other keys survive a form edit.
// A file the forms can't read (invalid YAML) is left to the Code view.

export type Path = (string | number)[];

const parse = (text: string): Document | null => {
  const doc = parseDocument(text);
  return doc.errors.length ? null : doc;
};
const print = (doc: Document) => doc.toString({ lineWidth: 0 });

/** Splits `---\nyaml\n---\nbody` (as the Worker's parser does). */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized };
  return { frontmatter: match[1]!, body: normalized.slice(match[0].length) };
}

/** A YAML file (or frontmatter) as plain data, or null when it doesn't parse. */
export function readYaml(text: string): unknown {
  const doc = parse(text);
  return doc ? (doc.toJS() ?? {}) : null;
}

export function readFrontmatter(text: string): { data: Record<string, unknown> | null; body: string } {
  const { frontmatter, body } = splitFrontmatter(text);
  const data = frontmatter === null ? {} : readYaml(frontmatter);
  return { data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null, body };
}

const empty = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** Sets one field: an empty value removes it; a list or scalar that's there is changed in place (its comment stays). */
function put(doc: Document, path: Path, value: unknown, keep = false): void {
  if (empty(value) && !keep) {
    doc.deleteIn(path);
    return;
  }
  const node = doc.getIn(path, true);
  if (isScalar(node) && typeof value !== "object") node.value = value;
  else if (isSeq(node) && Array.isArray(value)) node.items = value.map((v) => doc.createNode(v));
  else doc.setIn(path, value);
}

/** A map field's own entries renamed in place, so the order (and comments) stay. An empty name or one
 * that's taken is ignored (a duplicate key would make the file unreadable). */
function renameKey(doc: Document, path: Path, from: string, to: string): void {
  const map = doc.getIn(path, true);
  if (!isMap(map) || !to || map.has(to)) return;
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (key !== from) continue;
    if (isScalar(pair.key)) pair.key.value = to;
    else pair.key = doc.createNode(to);
    return;
  }
}

/** One edit to a field (or a map's key) of a YAML document. */
export type Edit =
  /** An empty value removes the field, unless `keep` (an empty header value while it's typed). */
  | { op: "set"; path: Path; value: unknown; keep?: boolean }
  | { op: "rename"; path: Path; from: string; to: string }
  | { op: "push"; path: Path; value: unknown }
  | { op: "remove"; path: Path; index: number };

function apply(doc: Document, edits: Edit[]): void {
  for (const e of edits) {
    if (e.op === "set") put(doc, e.path, e.value, e.keep);
    else if (e.op === "rename") renameKey(doc, e.path, e.from, e.to);
    else {
      const node = e.path.length ? doc.getIn(e.path, true) : doc.contents;
      if (e.op === "push") {
        if (isSeq(node)) node.items.push(doc.createNode(e.value));
        else if (e.path.length) doc.setIn(e.path, [e.value]);
        else doc.contents = doc.createNode([e.value]);
      } else if (isSeq(node)) node.items.splice(e.index, 1);
    }
    // A map left empty by the edit goes too (`headers:` with nothing under it).
    if (e.op === "set" && e.path.length > 1) {
      const parent = doc.getIn(e.path.slice(0, -1), true);
      if (isMap(parent) && parent.items.length === 0) doc.deleteIn(e.path.slice(0, -1));
    }
  }
}

/** The YAML file with the edits applied; unchanged when it doesn't parse. */
export function editYaml(text: string, ...edits: Edit[]): string {
  const doc = parse(text);
  if (!doc) return text;
  apply(doc, edits);
  return print(doc);
}

/** The Markdown file with its frontmatter edited (created if missing, dropped if left empty); the body is kept. */
export function editFrontmatter(text: string, ...edits: Edit[]): string {
  const { frontmatter, body } = splitFrontmatter(text);
  const doc = parse(frontmatter ?? "");
  if (!doc) return text;
  apply(doc, edits);
  const contents = doc.contents;
  const blank = contents === null || (isMap(contents) && contents.items.length === 0 && !doc.commentBefore && !contents.commentBefore);
  if (blank) return body;
  return `---\n${print(doc).trimEnd()}\n---\n${body}`;
}

/** The Markdown file with a new body; the frontmatter is kept as written. */
export function setBody(text: string, body: string): string {
  const { frontmatter } = splitFrontmatter(text);
  return frontmatter === null ? body : `---\n${frontmatter}\n---\n${body}`;
}

/** A name that isn't taken yet: `base`, `base_2`, … */
export function freshName(base: string, taken: Iterable<string>, sep = "_"): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${sep}${n}`)) return `${base}${sep}${n}`;
}
