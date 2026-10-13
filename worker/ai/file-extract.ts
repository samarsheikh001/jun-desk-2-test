import { decodeEntities, type Block } from "./chunk.ts";

// K-02: uploaded knowledge files. Type checks and text extraction for Markdown, plain text and
// DOCX. Pure (web-standard APIs only: DecompressionStream, TextDecoder), so unit tests run it on
// Node. PDFs are converted by Workers AI's toMarkdown in knowledge.ts; its Markdown comes back
// through blocksFromMarkdown here.

export type FileFormat = "pdf" | "docx" | "markdown" | "text";

const EXTENSIONS: Record<string, FileFormat> = { pdf: "pdf", docx: "docx", md: "markdown", markdown: "markdown", txt: "text" };

/** A file we won't take, with a message for the admin (the route turns it into a 400). */
export class UnsupportedFile extends Error {}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The file's format from its extension, confirmed by its bytes (magic numbers, valid text). */
export function sniffFormat(name: string, bytes: Uint8Array): FileFormat {
  const format = EXTENSIONS[extensionOf(name)];
  if (!format) throw new UnsupportedFile("Upload PDF, DOCX, Markdown (.md) or plain text (.txt) files.");
  if (bytes.length === 0) throw new UnsupportedFile("The file is empty.");
  if (format === "pdf" && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new UnsupportedFile(`${name} isn't a PDF (it doesn't start with %PDF-).`);
  if (format === "docx") {
    if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new UnsupportedFile(`${name} isn't a Word document (.docx files are zip archives).`);
    let names: string[];
    try {
      names = zipEntries(bytes).map((e) => e.name);
    } catch {
      throw new UnsupportedFile(`${name} is damaged: its zip directory can't be read.`);
    }
    if (!names.includes("word/document.xml")) throw new UnsupportedFile(`${name} isn't a Word document (no word/document.xml inside). Old .doc files need saving as .docx first.`);
  }
  if (format === "markdown" || format === "text") decodeText(bytes, name); // throws on binary
  return format;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/** UTF-8 (or UTF-16 with a BOM) text; anything that looks binary is rejected. */
export function decodeText(bytes: Uint8Array, name = "The file"): string {
  let text: string;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    else text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UnsupportedFile(`${name} isn't UTF-8 text.`);
  }
  if (text.slice(0, 8192).includes("\0")) throw new UnsupportedFile(`${name} looks like a binary file, not text.`);
  return text;
}

// ---------- Markdown and text ----------

/** Plain text: paragraphs split on blank lines. */
export function blocksFromPlainText(text: string): Block[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ kind: "text" as const, text: p }));
}

/**
 * Markdown: ATX (# …) and setext (underlined) headings become heading blocks; paragraphs, lists
 * and code stay text. Front matter and HTML comments are dropped; images keep their alt text and
 * links keep their text and address.
 */
export function blocksFromMarkdown(markdown: string): Block[] {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = para.join("\n").trim();
    if (text) blocks.push({ kind: "text", text });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      para.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1]!;
      para.push(line);
      continue;
    }
    const atx = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx && atx[2]) {
      flush();
      blocks.push({ kind: "heading", level: atx[1]!.length, text: inline(atx[2]) });
      continue;
    }
    const next = lines[i + 1];
    if (line.trim() && para.length === 0 && next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) {
      blocks.push({ kind: "heading", level: next.trim().startsWith("=") ? 1 : 2, text: inline(line.trim()) });
      i++;
      continue;
    }
    if (!line.trim()) flush();
    else para.push(inline(line));
  }
  flush();
  return blocks;
}

/**
 * Workers AI's toMarkdown wraps a PDF as "# <file name>", "## Contents", then "### Page N" per
 * page. The file name and "Contents" are noise in heading paths; pages become top-level sections.
 */
export function cleanPdfMarkdown(markdown: string, name: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.trim() === `# ${name}`) lines.splice(first, 1);
  return lines
    .filter((l) => !/^##\s+Contents\s*$/.test(l))
    .map((l) => l.replace(/^###\s+(Page \d+)\s*$/, "# $1"))
    .join("\n");
}

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)[^)]*\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

// ---------- DOCX ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Entries from a zip's central directory. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: last 22+ bytes (a comment can follow, up to 64 KB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No zip directory");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error("Bad zip directory");
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    entries.push({
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Most text we'll inflate from one entry: guards against zip bombs. */
const MAX_INFLATED = 50 * 1024 * 1024;

async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("Bad zip entry");
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`Unsupported zip compression (${entry.method})`);
  if (entry.size > MAX_INFLATED) throw new Error("Document too large once unpacked");

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
    total += part.length;
    if (total > MAX_INFLATED) throw new Error("Document too large once unpacked");
    parts.push(part);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Heading levels by paragraph style id, from word/styles.xml ("heading 1", "Title", outline level). */
function headingStyles(stylesXml: string): Map<string, number> {
  const levels = new Map<string, number>();
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = /w:styleId="([^"]+)"/.exec(match[1]!)?.[1];
    if (!id) continue;
    const name = /<w:name w:val="([^"]+)"/.exec(match[2]!)?.[1] ?? "";
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(match[2]!)?.[1];
    const level = headingLevel(name) ?? (outline !== undefined ? Number(outline) + 1 : undefined);
    if (level !== undefined) levels.set(id, level);
  }
  return levels;
}

function headingLevel(style: string): number | undefined {
  if (/^title$/i.test(style)) return 0; // above Heading 1, so "Title › Heading" paths keep it
  const m = /^heading\s?(\d)$/i.exec(style);
  return m ? Math.min(Number(m[1]), 6) : undefined;
}

const paragraphText = (xml: string): string =>
  decodeEntities(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "") // tracked deletions
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "") // field codes
      .replace(/<(?!\/?w:t[\s>])[^>]*>/g, "")
      .replace(/<\/?w:t[^>]*>/g, ""),
  );

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Paragraphs and headings of a .docx (word/document.xml). Table rows become "a | b | c" lines. */
export async function blocksFromDocx(bytes: Uint8Array): Promise<Block[]> {
  const entries = zipEntries(bytes);
  const documentEntry = entries.find((e) => e.name === "word/document.xml");
  if (!documentEntry) throw new UnsupportedFile("This isn't a Word document (no word/document.xml inside).");
  const decoder = new TextDecoder();
  let xml = decoder.decode(await readEntry(bytes, documentEntry));
  const stylesEntry = entries.find((e) => e.name === "word/styles.xml");
  const styles = stylesEntry ? headingStyles(decoder.decode(await readEntry(bytes, stylesEntry))) : new Map<string, number>();

  xml = xml.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = row
      .split(/<w:tc[\s>]/)
      .slice(1)
      .map((cell) => [...cell.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]).trim()).filter(Boolean).join(" "));
    const line = cells.join(" | ").trim();
    return line ? `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>` : "";
  });

  const blocks: Block[] = [];
  for (const match of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const p = match[0];
    const text = paragraphText(p).replace(/[ \t]+\n/g, "\n").trim();
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(p)?.[1];
    const level = (style ? (styles.get(style) ?? headingLevel(style)) : undefined) ?? (outline !== undefined ? Number(outline) + 1 : undefined);
    if (level !== undefined && text.length <= 200) blocks.push({ kind: "heading", level, text: text.replace(/\s+/g, " ") });
    else blocks.push({ kind: "text", text: /<w:numPr>/.test(p) ? `- ${text}` : text });
  }
  return mergeListItems(blocks);
}

/** Consecutive list items read better (and chunk better) as one block. */
function mergeListItems(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.kind === "text" && block.text.startsWith("- ") && last?.kind === "text" && /(^|\n)- [^\n]*$/.test(last.text) && last.text.length < 1000) {
      last.text += `\n${block.text}`;
    } else out.push({ ...block });
  }
  return out;
}

/** Title for a file's chunks: its name without the extension. */
export function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim() || name;
}
