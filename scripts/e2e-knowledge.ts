// End-to-end test of K-02 (files in the knowledge base) against a running dev server: upload
// Markdown, text, DOCX and PDF fixtures (scripts/fixtures/kb), see them indexed and searchable,
// the AI answers from one in a widget chat (E2E_AI_PROVIDER, default ChatGPT), limits and roles,
// W-15 suggested questions drafted from the indexed knowledge, and delete. PDFs are converted by
// Workers AI (toMarkdown), so this needs Cloudflare access.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const owner = new Client();
const teammate = new Client();
const run = Date.now().toString(36);
let workspaceId = "";
let widgetKey = "";
const AI_TIMEOUT = 120_000;

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/kb/${name}`, import.meta.url)));
const FILES = [
  { name: "glacier-refunds.md", query: "Glacier plan refund business days", text: /9 business days/ },
  { name: "iceland-shipping.txt", query: "Reykjavik warehouse parcels Iceland", text: /every Tuesday/ },
  { name: "zephyr-warranty.docx", query: "Zephyr X2 headset warranty", text: /27 months/ },
  { name: "orbit-api-keys.pdf", query: "Orbit API keys rotate", text: /45 days/ },
] as const;
const ids = new Map<string, string>();

const kb = () => `/workspaces/${workspaceId}/knowledge`;
const upload = (client: Client, name: string, bytes: Uint8Array, headers: Record<string, string> = {}) =>
  client.call(`${kb()}/files`, { body: bytes, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), ...headers } });

interface SourceRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  error: string | null;
  fileName: string | null;
  fileSize: number | null;
  chunkCount: number;
  chunksWithoutVectors: number;
}
const sources = async () => (await owner.call(kb())).json.sources as SourceRow[];

async function waitIndexed(id: string, timeoutMs = 60_000): Promise<SourceRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const source = (await sources()).find((s) => s.id === id);
    if (source && (source.status === "ready" || source.status === "error")) return source;
    if (Date.now() > deadline) throw new Error(`not indexed in time: ${JSON.stringify(source)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const search = async (query: string) => (await owner.call(`${kb()}/search`, { body: { query } })).json.hits as { title: string; heading: string; text: string; url: string | null }[];

await step("owner signs in, a teammate (agent role) joins, the AI is on", async () => {
  assert.equal((await owner.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await owner.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  const invite = await owner.call(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } });
  const token = new URL(invite.json.url).pathname.split("/").pop()!;
  assert.equal((await teammate.register(`/invites/${token}`, new SoftAuthenticator(), { name: `Kim ${run}`, email: `kim-${run}@acme.test` })).status, 200);
  const ai = await owner.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, model: null, monthlyReplyCap: 1_000_000 } });
  assert.equal(ai.status, 200, JSON.stringify(ai.json));
});

const draftSuggestions = (client: Client) => client.call(`/workspaces/${workspaceId}/inbox/suggestions/draft`, { body: {} });

await step("W-15: drafting suggested questions needs knowledge (a fresh desk gets a clear 400)", async () => {
  // Only checkable on a fresh database: a rerun keeps the files a previous run left indexed.
  if ((await sources()).some((s) => s.chunkCount > 0)) {
    console.log("    skipped: knowledge from an earlier run is still indexed");
    return;
  }
  const res = await draftSuggestions(owner);
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(res.json.error.code, "no_knowledge");
  assert.match(res.json.error.message, /knowledge source/i);
});

await step("only owners and admins upload; signed-out requests are refused", async () => {
  const res = await upload(teammate, "glacier-refunds.md", fixture("glacier-refunds.md"));
  assert.equal(res.status, 403, JSON.stringify(res.json));
  assert.equal((await upload(new Client(), "glacier-refunds.md", fixture("glacier-refunds.md"))).status, 401);
  // The teammate can still read the list.
  assert.equal((await teammate.call(kb())).status, 200);
});

await step("wrong types, fakes, empty and oversize files get clear 400s", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cases: [string, Uint8Array, RegExp][] = [
    ["logo.png", png, /Upload PDF, DOCX, Markdown/],
    ["report.pdf", new TextEncoder().encode("<html>not a pdf</html>"), /isn't a PDF/],
    ["notes.docx", fixture("orbit-api-keys.pdf"), /isn't a Word document/],
    ["binary.txt", new Uint8Array([0x68, 0x00, 0x69, 0xff, 0xfe]), /UTF-8|binary/],
    ["empty.md", new Uint8Array(), /empty/],
    ["huge.txt", new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61), /10 MB/],
  ];
  for (const [name, bytes, message] of cases) {
    const res = await upload(owner, name, bytes);
    assert.equal(res.status, 400, `${name}: ${JSON.stringify(res.json)}`);
    assert.match(res.json.error.message, message, name);
  }
  // A plain form post can't upload (CSRF guard: JSON or X-Jun-Upload only).
  const form = await owner.call(`${kb()}/files`, { body: "x", headers: { "Content-Type": "text/plain", "X-File-Name": "a.txt" } });
  assert.equal(form.status, 400);
  assert.equal(form.json.error.code, "json_required");
  assert.equal((await owner.call(`${kb()}/files`, { body: { name: "a.txt" } })).json.error.code, "upload_required");
  assert.ok(!(await sources()).some((s) => s.kind === "file" && /logo|report|notes|binary|empty|huge/.test(s.fileName ?? "")), "nothing rejected was stored");
});

await step("Markdown, text, DOCX and PDF files upload and get indexed", async () => {
  // A rerun on the same database starts from no copies of these files.
  for (const old of (await sources()).filter((s) => FILES.some((f) => f.name === s.fileName))) {
    assert.equal((await owner.call(`${kb()}/${old.id}`, { method: "DELETE" })).status, 200);
  }
  for (const file of FILES) {
    const bytes = fixture(file.name);
    const res = await upload(owner, file.name, bytes);
    assert.equal(res.status, 200, `${file.name}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.size, bytes.length);
    ids.set(file.name, res.json.id);
  }
  for (const file of FILES) {
    const source = await waitIndexed(ids.get(file.name)!);
    assert.equal(source.status, "ready", `${file.name}: ${JSON.stringify(source)}`);
    assert.equal(source.kind, "file");
    assert.equal(source.fileName, file.name);
    assert.equal(source.fileSize, fixture(file.name).length);
    assert.equal(source.title, file.name.replace(/\.[^.]+$/, ""));
    assert.ok(source.chunkCount > 0, JSON.stringify(source));
    // Workers AI may be out of its daily allocation: then the chunks are kept for keyword search.
    if (source.chunksWithoutVectors > 0) console.log(`    ${file.name}: ${source.chunksWithoutVectors} chunks indexed without vectors (embedding failed)`);
  }
});

await step("source detail shows what was indexed; the original downloads unchanged", async () => {
  const id = ids.get("zephyr-warranty.docx")!;
  const detail = (await teammate.call(`${kb()}/${id}`)).json;
  assert.deepEqual(detail.source.file, { name: "zephyr-warranty.docx", format: "docx", size: fixture("zephyr-warranty.docx").length });
  assert.equal(detail.documents.length, 1);
  const chunks = (await teammate.call(`${kb()}/${id}/documents/${detail.documents[0].id}`)).json.chunks as { heading: string; text: string }[];
  assert.ok(chunks.some((c) => c.heading === "Zephyr headset warranty › Coverage" && /27 months/.test(c.text)), JSON.stringify(chunks));

  const res = await fetch(`${BASE}/api${kb()}/${id}/file`, { headers: { Cookie: cookieHeader(teammate) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''zephyr-warranty\.docx$/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), fixture("zephyr-warranty.docx"));
  assert.equal((await fetch(`${BASE}/api${kb()}/${id}/file`)).status, 401);
});

await step("search finds each file's content", async () => {
  for (const file of FILES) {
    const hits = await search(file.query);
    const hit = hits.find((h) => file.text.test(h.text));
    assert.ok(hit, `${file.name}: ${JSON.stringify(hits.map((h) => h.title))}`);
    assert.equal(hit.title, file.name.replace(/\.[^.]+$/, ""));
    assert.equal(hit.url, null, "files have no public URL");
    // PDF pages become sections (toMarkdown's file-name and "Contents" wrappers are dropped).
    if (file.name.endsWith(".pdf")) assert.equal(hit.heading, "Page 1");
  }
});

await step("W-15: the AI drafts up to 4 suggested questions from the knowledge, without saving them; owners and admins only", async () => {
  assert.equal((await draftSuggestions(teammate)).status, 403);
  assert.equal((await draftSuggestions(new Client())).status, 401);
  const usage = async () => (await owner.call(`/workspaces/${workspaceId}/ai`)).json.usage as { inputTokens: number };
  const before = (await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.settings.suggestions;
  const usageBefore = await usage();
  const res = await draftSuggestions(owner);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const suggestions = res.json.suggestions as unknown[];
  console.log(`    drafted: ${JSON.stringify(suggestions)}`);
  assert.ok(Array.isArray(suggestions) && suggestions.length >= 1 && suggestions.length <= 4, JSON.stringify(res.json));
  for (const q of suggestions) assert.ok(typeof q === "string" && q.trim() === q && q.length > 0 && q.length <= 80, JSON.stringify(q));
  assert.equal(new Set(suggestions.map((q) => (q as string).toLowerCase())).size, suggestions.length, "no duplicates");
  // Nothing saved: the widget's questions only change when an admin saves them.
  assert.deepEqual((await owner.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.settings.suggestions, before);
  assert.ok((await usage()).inputTokens > usageBefore.inputTokens, "input tokens recorded");
});

await step("re-index (and a rename) indexes again; non-admins can't", async () => {
  const id = ids.get("glacier-refunds.md")!;
  assert.equal((await teammate.call(`${kb()}/${id}/sync`, { body: {} })).status, 403);
  assert.equal((await owner.call(`${kb()}/${id}/sync`, { body: {} })).status, 200);
  assert.equal((await waitIndexed(id)).status, "ready");
  assert.equal((await owner.call(`${kb()}/${id}`, { method: "PATCH", body: { title: `Glacier refunds ${run}` } })).status, 200);
  const renamed = await waitIndexed(id);
  assert.equal(renamed.status, "ready");
  assert.equal(renamed.title, `Glacier refunds ${run}`);
  const hits = await search("Glacier plan refund business days");
  assert.ok(hits.some((h) => h.title === `Glacier refunds ${run}`), JSON.stringify(hits.map((h) => h.title)));
});

await step("the AI answers a visitor from an uploaded file and cites it", async () => {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body: "How long is the warranty on the Zephyr X2 headset?" },
    headers: { "X-Visitor-Token": token },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${res.json.conversation.id}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  const match = (m: { authorType: string }) => m.authorType === "ai" || m.authorType === "system";
  const event = await socket.next((e) => (e.type === "message" && match(e.message)) || (e.type === "messages" && e.messages.some(match)), AI_TIMEOUT);
  const answer = event.type === "message" ? event.message : event.messages.find(match);
  socket.close();
  console.log(`    AI: ${answer.body.replace(/\s+/g, " ").slice(0, 160)}`);
  assert.equal(answer.authorType, "ai", answer.body);
  assert.match(answer.body, /27[ -]months?|twenty-seven/i);
  assert.ok(answer.meta.sources?.some((s: { title: string; url: string | null }) => s.title.startsWith("zephyr-warranty") && s.url === null), JSON.stringify(answer.meta));
});

await step("delete removes the file from the list, search and storage; non-admins can't", async () => {
  const id = ids.get("zephyr-warranty.docx")!;
  assert.equal((await teammate.call(`${kb()}/${id}`, { method: "DELETE" })).status, 403);
  assert.equal((await owner.call(`${kb()}/${id}`, { method: "DELETE" })).status, 200);
  assert.ok(!(await sources()).some((s) => s.id === id));
  const hits = await search("Zephyr X2 headset warranty");
  assert.ok(!hits.some((h) => /27 months/.test(h.text)), JSON.stringify(hits));
  assert.equal((await owner.call(`${kb()}/${id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api${kb()}/${id}/file`, { headers: { Cookie: cookieHeader(owner) } })).status, 404);
  assert.equal((await owner.call(`${kb()}/${id}`, { method: "DELETE" })).status, 404);
  // The others are still there.
  assert.ok((await search("Orbit API keys rotate")).some((h) => /45 days/.test(h.text)));
});

summary();
