// Turning page text into search-sized chunks. Pure functions (no Worker APIs).

export type Block = { kind: "heading"; level: number; text: string } | { kind: "text"; text: string };

export interface Chunk {
  /** Heading path, e.g. "Billing › Refunds". */
  heading: string;
  text: string;
}

const TARGET = 1200; // characters (~250–300 tokens)
const MAX = 2000;

/** Groups blocks into chunks that stay within one section and roughly TARGET characters. */
export function chunkBlocks(blocks: Block[]): Chunk[] {
  const chunks: Chunk[] = [];
  const path: { level: number; text: string }[] = [];
  let buffer: string[] = [];
  let size = 0;

  const heading = () => path.map((h) => h.text).join(" › ");
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) chunks.push({ heading: heading(), text });
    buffer = [];
    size = 0;
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush();
      while (path.length && path[path.length - 1]!.level >= block.level) path.pop();
      path.push({ level: block.level, text: block.text });
      continue;
    }
    for (const piece of splitLong(block.text)) {
      if (size > 0 && size + piece.length > TARGET) flush();
      buffer.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  return chunks;
}

/** Splits an over-long paragraph at sentence boundaries (hard-cut as a last resort). */
function splitLong(text: string): string[] {
  if (text.length <= MAX) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > TARGET) {
      out.push(current.trim());
      current = "";
    }
    current += sentence;
    while (current.length > MAX) {
      out.push(current.slice(0, MAX));
      current = current.slice(MAX);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Snippets are plain text: paragraphs separated by blank lines, optional markdown headings. */
export function blocksFromText(text: string): Block[] {
  const blocks: Block[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading && !trimmed.includes("\n")) blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
    else blocks.push({ kind: "text", text: trimmed });
  }
  return blocks;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
