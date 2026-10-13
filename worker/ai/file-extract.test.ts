import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_KB_FILE_BYTES, MAX_KB_FILES, KB_FILE_EXTENSIONS } from "../../shared/protocol.ts";
import { chunkBlocks } from "./chunk.ts";
import { blocksFromDocx, blocksFromMarkdown, blocksFromPlainText, cleanPdfMarkdown, decodeText, sniffFormat, titleFromName, UnsupportedFile, zipEntries } from "./file-extract.ts";

// A minimal zip writer (deflate via CompressionStream, or stored) to build .docx files in tests.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}
async function zip(files: Record<string, string>, { store = false } = {}): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(content);
    const data = store ? raw : await deflateRaw(raw);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, store ? 0 : 8, true);
    header.setUint32(14, crc32(raw), true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, store ? 0 : 8, true);
    entry.setUint32(16, crc32(raw), true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string, extra = "") =>
  `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const documentXml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const stylesXml = `<?xml version="1.0"?><w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const docx = async (body: string, extra: Record<string, string> = {}, options?: { store?: boolean }) =>
  zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": documentXml(body), "word/styles.xml": stylesXml, ...extra }, options);

test("DOCX: headings (built-in, localized style ids, outline level), paragraphs, entities, tabs and breaks", async () => {
  const bytes = await docx(
    para("Acme Handbook", "Title") +
      para("Refunds", "berschrift2") +
      para("Refunds take 5 &amp; 7 days &lt;max&gt;.") +
      `<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Split </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>runs</w:t></w:r><w:r><w:delText>deleted</w:delText></w:r></w:p>` +
      para("Escalations", "Heading3") +
      para("Outline heading", undefined, '<w:outlineLvl w:val="1"/>') +
      `<w:p/>` +
      para("Call support."),
  );
  assert.deepEqual(await blocksFromDocx(bytes), [
    { kind: "heading", level: 0, text: "Acme Handbook" },
    { kind: "heading", level: 2, text: "Refunds" },
    { kind: "text", text: "Refunds take 5 & 7 days <max>." },
    { kind: "text", text: "Line one\nline two\ttabbed" },
    { kind: "text", text: "Split runs" },
    { kind: "heading", level: 3, text: "Escalations" },
    { kind: "heading", level: 2, text: "Outline heading" },
    { kind: "text", text: "Call support." },
  ]);
});

test("DOCX: list items merge into one block, table rows become a | b lines", async () => {
  const list = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  const cell = (t: string) => `<w:tc><w:tcPr/>${para(t)}</w:tc>`;
  const bytes = await docx(
    para("Steps:") +
      para("Open settings", undefined, list) +
      para("Click Billing", undefined, list) +
      `<w:tbl><w:tblPr/><w:tr><w:trPr/>${cell("Plan")}${cell("Price")}</w:tr><w:tr>${cell("Pro")}${cell("$49 &amp; up")}</w:tr></w:tbl>` +
      para("After the table."),
    {},
    { store: true },
  );
  assert.deepEqual(await blocksFromDocx(bytes), [
    { kind: "text", text: "Steps:" },
    { kind: "text", text: "- Open settings\n- Click Billing" },
    { kind: "text", text: "Plan | Price" },
    { kind: "text", text: "Pro | $49 & up" },
    { kind: "text", text: "After the table." },
  ]);
});

test("DOCX: chunks carry the document's heading path", async () => {
  const bytes = await docx(para("Guide", "Title") + para("Billing", "Heading2") + para("Invoices are emailed monthly."));
  assert.deepEqual(chunkBlocks(await blocksFromDocx(bytes)), [{ heading: "Guide › Billing", text: "Invoices are emailed monthly." }]);
});

test("zip directory: entries listed; garbage rejected", async () => {
  const bytes = await docx(para("x"));
  assert.deepEqual(zipEntries(bytes).map((e) => e.name), ["[Content_Types].xml", "word/document.xml", "word/styles.xml"]);
  assert.throws(() => zipEntries(new TextEncoder().encode("PK\u0003\u0004 not really a zip")));
});

test("sniffing: extension must match the bytes", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n%…");
  const doc = await docx(para("hello"));
  assert.equal(sniffFormat("Guide.PDF", pdf), "pdf");
  assert.equal(sniffFormat("guide.docx", doc), "docx");
  assert.equal(sniffFormat("notes.md", new TextEncoder().encode("# Hi")), "markdown");
  assert.equal(sniffFormat("notes.markdown", new TextEncoder().encode("Hi")), "markdown");
  assert.equal(sniffFormat("notes.txt", new TextEncoder().encode("Héllo")), "text");

  const rejects = (name: string, bytes: Uint8Array, message: RegExp) =>
    assert.throws(() => sniffFormat(name, bytes), (e: unknown) => e instanceof UnsupportedFile && message.test(e.message));
  rejects("photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), /Upload PDF, DOCX/);
  rejects("noextension", pdf, /Upload PDF, DOCX/);
  rejects("old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), /Upload PDF, DOCX/);
  rejects("fake.pdf", new TextEncoder().encode("<html>"), /isn't a PDF/);
  rejects("fake.docx", pdf, /isn't a Word document/);
  rejects("archive.docx", await zip({ "readme.txt": "hi" }), /no word\/document\.xml/);
  rejects("binary.txt", new Uint8Array([0x68, 0x00, 0x69, 0x00, 0xff]), /UTF-8|binary/);
  rejects("nul.md", new TextEncoder().encode("abc\0def"), /binary/);
  rejects("empty.txt", new Uint8Array(), /empty/);
});

test("text decoding: BOMs and UTF-16", () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), "hi");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])), "hi");
});

test("markdown: ATX and setext headings, front matter, code fences, links and images", () => {
  const md = [
    "---",
    "title: ignored",
    "---",
    "# Getting started ##",
    "Install the app.",
    "Then sign in.",
    "",
    "Billing",
    "=======",
    "See [the pricing page](https://acme.test/pricing) or [docs](/docs). ![diagram](x.png)",
    "",
    "## API",
    "```bash",
    "# not a heading",
    "",
    "curl https://api.acme.test",
    "```",
    "<!-- hidden -->",
    "- one",
    "- two",
    "",
    "Sub",
    "---",
    "Text.",
  ].join("\r\n");
  assert.deepEqual(blocksFromMarkdown(md), [
    { kind: "heading", level: 1, text: "Getting started" },
    { kind: "text", text: "Install the app.\nThen sign in." },
    { kind: "heading", level: 1, text: "Billing" },
    { kind: "text", text: "See the pricing page (https://acme.test/pricing) or docs. diagram" },
    { kind: "heading", level: 2, text: "API" },
    { kind: "text", text: "```bash\n# not a heading\n\ncurl https://api.acme.test\n```" },
    { kind: "text", text: "- one\n- two" },
    { kind: "heading", level: 2, text: "Sub" },
    { kind: "text", text: "Text." },
  ]);
});

test("PDF markdown from toMarkdown: file name and Contents wrappers dropped, pages become sections", () => {
  const md = "# guide.pdf\n## Contents\n### Page 1\nKeys rotate every 45 days.\n\n### Page 2\nOld keys work for 72 hours.\n";
  assert.deepEqual(chunkBlocks(blocksFromMarkdown(cleanPdfMarkdown(md, "guide.pdf"))), [
    { heading: "Page 1", text: "Keys rotate every 45 days." },
    { heading: "Page 2", text: "Old keys work for 72 hours." },
  ]);
  assert.equal(cleanPdfMarkdown("# Real title\ntext", "guide.pdf"), "# Real title\ntext");
});

test("plain text: paragraphs only (a leading # stays text)", () => {
  assert.deepEqual(blocksFromPlainText("# Not a heading\r\nstill para\r\n\r\n\r\nSecond."), [
    { kind: "text", text: "# Not a heading\nstill para" },
    { kind: "text", text: "Second." },
  ]);
});

test("limits and names", () => {
  assert.equal(MAX_KB_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_KB_FILES, 200);
  assert.deepEqual(KB_FILE_EXTENSIONS, [".pdf", ".docx", ".md", ".markdown", ".txt"]);
  assert.equal(titleFromName("Refund policy.v2.pdf"), "Refund policy.v2");
  assert.equal(titleFromName(".txt"), ".txt");
});
