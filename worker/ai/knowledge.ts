import { newId } from "../lib/crypto.ts";
import { blocksFromText, chunkBlocks, contentHash, decodeEntities, type Block } from "./chunk.ts";
import { embed } from "./embeddings.ts";
import { extractPage } from "./extract.ts";
import { blocksFromDocx, blocksFromMarkdown, blocksFromPlainText, cleanPdfMarkdown, decodeText, type FileFormat } from "./file-extract.ts";
import { isExcluded, normalizeUrl } from "./urls.ts";

// Knowledge sources: websites (crawled through a Queue), snippets (indexed directly) and
// uploaded files (K-02: original in R2, extracted and indexed by a Queue job).
//
// Embedding can fail (e.g. Workers AI's daily free allocation, error 4006). Chunks are then
// still stored in D1 + FTS with `embedded = 0`, so keyword search finds them, and
// fillMissingVectors adds their vectors on a later re-index, sync or the daily cron.

export type CrawlJob =
  | { type: "sync"; sourceId: string }
  | { type: "page"; sourceId: string; syncToken: string; url: string; depth: number; follow: boolean }
  | { type: "file"; sourceId: string };

export const DEFAULT_MAX_PAGES = 200;
const MAX_PAGE_CHUNKS = 200;
/** A file can be a whole manual: more chunks than a web page (~1.2 MB of text). */
export const MAX_FILE_CHUNKS = 1000;
const MAX_DEPTH = 3;
const MAX_PAGE_BYTES = 2_000_000;
const USER_AGENT = "JunDeskBot/0.1 (+https://github.com/samarsheikh001/jun)";
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|csv)$/i;

interface SourceRow {
  id: string;
  workspace_id: string;
  kind: "website" | "snippet" | "file";
  url: string | null;
  title: string;
  body: string | null;
  settings: string;
}

export interface SourceSettings {
  maxPages?: number;
  syncToken?: string;
  disallow?: string[];
  /** K-04: pages the admin left out. Full URLs match exactly; "/path" entries are path prefixes ("*" = any). */
  exclude?: string[];
  /** K-02: the uploaded original (R2 key under kb/<workspace>/). */
  file?: FileInfo;
}

export interface FileInfo {
  key: string;
  name: string;
  format: FileFormat;
  size: number;
}

export const fileKey = (workspaceId: string, sourceId: string) => `kb/${workspaceId}/${sourceId}`;

const index = (env: Env, workspaceId: string) => env.KNOWLEDGE_INDEX.getByName(workspaceId);

async function loadSource(env: Env, sourceId: string): Promise<SourceRow | null> {
  return env.DB.prepare("SELECT id, workspace_id, kind, url, title, body, settings FROM kb_sources WHERE id = ?").bind(sourceId).first<SourceRow>();
}

const embeddingText = (c: { title: string; heading: string; text: string }) => `${c.title}\n${c.heading}\n${c.text}`;

/** Vectors for these texts, or null when Workers AI fails (the chunks are kept for keyword search). */
async function tryEmbed(env: Env, texts: string[]): Promise<number[][] | null> {
  try {
    return await embed(env, texts);
  } catch (error) {
    console.error("embedding failed, storing chunks for keyword search only:", error);
    return null;
  }
}

/** Chunk, embed and store text for one document (or snippet), replacing its old chunks. */
async function indexText(
  env: Env,
  target: { workspaceId: string; sourceId: string; documentId: string | null; url: string | null; title: string },
  blocks: Block[],
  maxChunks = MAX_PAGE_CHUNKS,
): Promise<{ chunks: number; withoutVectors: number }> {
  const chunks = chunkBlocks(blocks).slice(0, maxChunks);
  const vectors = chunks.length ? await tryEmbed(env, chunks.map((c) => embeddingText({ title: target.title, ...c }))) : [];

  const old = await env.DB.prepare(target.documentId ? "SELECT id FROM kb_chunks WHERE document_id = ?" : "SELECT id FROM kb_chunks WHERE source_id = ? AND document_id IS NULL")
    .bind(target.documentId ?? target.sourceId)
    .all<{ id: string }>();
  if (old.results.length) await index(env, target.workspaceId).deleteChunks(old.results.map((r) => r.id));

  const rows = chunks.map((c, position) => ({ id: newId("chk"), heading: c.heading, text: c.text, position }));
  // Rows go in as JSON arrays (one statement per ~400 KB), not one statement per chunk.
  const groups: (typeof rows)[] = [];
  let size = Infinity;
  for (const row of rows) {
    if (size > 400_000) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(row);
    size += row.text.length + row.heading.length + 64;
  }
  await env.DB.batch([
    target.documentId
      ? env.DB.prepare("DELETE FROM kb_chunks WHERE document_id = ?").bind(target.documentId)
      : env.DB.prepare("DELETE FROM kb_chunks WHERE source_id = ? AND document_id IS NULL").bind(target.sourceId),
    ...groups.map((group) =>
      env.DB.prepare(
        `INSERT INTO kb_chunks (id, workspace_id, source_id, document_id, url, title, heading, text, position, embedded)
         SELECT json_extract(value, '$.id'), ?1, ?2, ?3, ?4, ?5, json_extract(value, '$.heading'), json_extract(value, '$.text'), json_extract(value, '$.position'), ?6
         FROM json_each(?7)`,
      ).bind(target.workspaceId, target.sourceId, target.documentId, target.url, target.title, vectors ? 1 : 0, JSON.stringify(group)),
    ),
  ]);
  // In slices: a 1,000-chunk file is ~8 MB of vectors, too much for one RPC.
  for (let i = 0; vectors && i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    await index(env, target.workspaceId).upsert(slice.map((r, j) => ({ chunkId: r.id, sourceId: target.sourceId, vector: vectors[i + j]! })));
  }
  return { chunks: rows.length, withoutVectors: vectors ? 0 : rows.length };
}

/**
 * Adds vectors to a source's chunks that were stored without one (embedding failed earlier).
 * Stops quietly if embedding still fails. Returns how many chunks are still without a vector.
 */
export async function fillMissingVectors(env: Env, workspaceId: string, sourceId: string): Promise<number> {
  for (let round = 0; round < 20; round++) {
    const rows = await env.DB.prepare("SELECT id, title, heading, text FROM kb_chunks WHERE source_id = ? AND embedded = 0 ORDER BY rowid LIMIT 64")
      .bind(sourceId)
      .all<{ id: string; title: string; heading: string; text: string }>();
    if (rows.results.length === 0) return 0;
    const vectors = await tryEmbed(env, rows.results.map(embeddingText));
    if (!vectors) break;
    await index(env, workspaceId).upsert(rows.results.map((r, i) => ({ chunkId: r.id, sourceId, vector: vectors[i]! })));
    await env.DB.prepare("UPDATE kb_chunks SET embedded = 1 WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(rows.results.map((r) => r.id)))
      .run();
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE source_id = ? AND embedded = 0").bind(sourceId).first<{ n: number }>();
  return left?.n ?? 0;
}

export async function indexSnippet(env: Env, sourceId: string): Promise<void> {
  const source = await loadSource(env, sourceId);
  if (!source || source.kind !== "snippet") return;
  await indexText(env, { workspaceId: source.workspace_id, sourceId, documentId: null, url: null, title: source.title }, blocksFromText(source.body ?? ""));
  await env.DB.prepare("UPDATE kb_sources SET status = 'ready', page_count = 1, last_synced_at = ?, error = NULL WHERE id = ?").bind(Date.now(), sourceId).run();
}

/** K-04: takes one page out of the knowledge base, and keeps it out of future crawls. */
export async function removeDocument(env: Env, workspaceId: string, sourceId: string, documentId: string): Promise<boolean> {
  const doc = await env.DB.prepare("SELECT d.url, s.settings FROM kb_documents d JOIN kb_sources s ON s.id = d.source_id WHERE d.id = ? AND d.source_id = ? AND s.workspace_id = ?")
    .bind(documentId, sourceId, workspaceId)
    .first<{ url: string; settings: string }>();
  if (!doc) return false;
  const chunks = await env.DB.prepare("SELECT id FROM kb_chunks WHERE document_id = ?").bind(documentId).all<{ id: string }>();
  if (chunks.results.length) await index(env, workspaceId).deleteChunks(chunks.results.map((r) => r.id));
  const settings = JSON.parse(doc.settings) as SourceSettings;
  settings.exclude = [...new Set([...(settings.exclude ?? []), doc.url])].slice(0, 500);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_documents WHERE id = ?").bind(documentId),
    env.DB.prepare(
      "UPDATE kb_sources SET settings = ?, page_count = (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) WHERE id = ?2",
    ).bind(JSON.stringify(settings), sourceId),
  ]);
  return true;
}

/** Removes a source: its vectors, its D1 rows (documents, chunks and FTS rows cascade) and an uploaded original. */
export async function deleteSource(env: Env, workspaceId: string, sourceId: string): Promise<boolean> {
  const row = await env.DB.prepare("DELETE FROM kb_sources WHERE id = ? AND workspace_id = ? RETURNING settings")
    .bind(sourceId, workspaceId)
    .first<{ settings: string }>();
  if (!row) return false;
  await index(env, workspaceId).deleteSource(sourceId);
  const { file } = JSON.parse(row.settings) as SourceSettings;
  if (file) await env.FILES.delete(file.key);
  return true;
}

// ---------- uploaded files (K-02) ----------

/** Queues (re-)extraction and indexing of an uploaded file. */
export async function startFileIndex(env: Env, sourceId: string): Promise<void> {
  await env.DB.prepare("UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = ?").bind(sourceId).run();
  await env.CRAWL_QUEUE.send({ type: "file", sourceId } satisfies CrawlJob);
}

/**
 * PDFs go through Workers AI's document conversion (toMarkdown: free for PDFs, no extra
 * dependency). Embedded images aren't described: that would use AI models and the free allocation.
 */
async function pdfToMarkdown(env: Env, name: string, bytes: Uint8Array): Promise<string> {
  let result;
  try {
    result = await env.AI.toMarkdown(
      { name, blob: new Blob([bytes], { type: "application/pdf" }) },
      { conversionOptions: { pdf: { images: { convert: false }, metadata: false } } },
    );
  } catch (error) {
    throw new Error(`Couldn't convert this PDF right now (${(error as Error).message}). Re-index to try again, or upload it as DOCX or text.`);
  }
  if (result.format === "error") throw new Error(`Couldn't read this PDF: ${result.error}`);
  return result.data;
}

async function extractFile(env: Env, file: FileInfo, bytes: Uint8Array): Promise<Block[]> {
  switch (file.format) {
    case "markdown":
      return blocksFromMarkdown(decodeText(bytes, file.name));
    case "text":
      return blocksFromPlainText(decodeText(bytes, file.name));
    case "docx":
      return blocksFromDocx(bytes);
    case "pdf":
      return blocksFromMarkdown(cleanPdfMarkdown(await pdfToMarkdown(env, file.name, bytes), file.name));
  }
}

async function runFile(env: Env, sourceId: string): Promise<void> {
  const source = await loadSource(env, sourceId);
  if (!source || source.kind !== "file") return;
  const { file } = JSON.parse(source.settings) as SourceSettings;
  if (!file) return;
  await env.DB.prepare("UPDATE kb_sources SET status = 'syncing', error = NULL WHERE id = ?").bind(sourceId).run();
  try {
    const object = await env.FILES.get(file.key);
    if (!object) throw new Error("The uploaded file is missing from storage. Remove it and upload it again.");
    const blocks = await extractFile(env, file, new Uint8Array(await object.arrayBuffer()));
    if (!blocks.some((b) => b.kind === "text")) {
      throw new Error(file.format === "pdf" ? "No text found in this PDF. Scanned PDFs (pictures of pages) can't be read yet." : "No text found in this file.");
    }
    const hash = await contentHash(`${source.title}\n${blocks.map((b) => b.text).join("\n")}`);
    const doc = (await env.DB.prepare(
      `INSERT INTO kb_documents (id, workspace_id, source_id, url, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, url) DO UPDATE SET title = excluded.title
       RETURNING id, content_hash`,
    )
      .bind(newId("doc"), source.workspace_id, sourceId, `file:${file.name}`, source.title, Date.now())
      .first<{ id: string; content_hash: string | null }>())!;
    const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE document_id = ?").bind(doc.id).first<{ n: number }>();
    // Unchanged text keeps its chunks; only missing vectors get filled below.
    if (doc.content_hash !== hash || !existing?.n) {
      await indexText(env, { workspaceId: source.workspace_id, sourceId, documentId: doc.id, url: null, title: source.title }, blocks, MAX_FILE_CHUNKS);
      await env.DB.prepare("UPDATE kb_documents SET content_hash = ?, updated_at = ? WHERE id = ?").bind(hash, Date.now(), doc.id).run();
    }
    await fillMissingVectors(env, source.workspace_id, sourceId);
    await env.DB.prepare("UPDATE kb_sources SET status = 'ready', page_count = 1, last_synced_at = ?, error = NULL WHERE id = ?").bind(Date.now(), sourceId).run();
  } catch (error) {
    console.error(`index file ${sourceId}:`, error);
    await env.DB.prepare("UPDATE kb_sources SET status = 'error', error = ? WHERE id = ?").bind((error as Error).message.slice(0, 300), sourceId).run();
  }
}

// ---------- website crawling ----------

function inScope(url: URL, start: URL): boolean {
  if (url.origin !== start.origin) return false;
  const dir = start.pathname.endsWith("/") ? start.pathname : start.pathname.slice(0, start.pathname.lastIndexOf("/") + 1);
  return url.pathname.startsWith(dir) && !SKIP_EXTENSIONS.test(url.pathname);
}

function allowedByRobots(url: URL, disallow: string[]): boolean {
  return !disallow.some((rule) => {
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`);
    return pattern.test(url.pathname + url.search);
  });
}

/** Disallow rules for `*` (or us) and any Sitemap: lines. */
async function readRobots(origin: string): Promise<{ disallow: string[]; sitemaps: string[] }> {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { disallow, sitemaps };
    let applies = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const [field, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      const key = field?.toLowerCase();
      if (key === "user-agent") applies = value === "*" || /jundeskbot/i.test(value);
      else if (key === "disallow" && applies && value) disallow.push(value);
      else if (key === "sitemap" && value) sitemaps.push(value);
    }
  } catch {
    // no robots.txt: everything allowed
  }
  return { disallow, sitemaps };
}

/** URLs from a sitemap (follows one level of sitemap index). */
async function readSitemap(url: string, depth = 0): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));
    if (/<sitemapindex/i.test(xml) && depth === 0) {
      const nested = await Promise.all(locs.slice(0, 20).map((l) => readSitemap(l, 1)));
      return nested.flat();
    }
    return locs;
  } catch {
    return [];
  }
}

/**
 * Claims URLs for this sync (dedupes across jobs via UNIQUE(source_id, url)), respecting
 * the page cap, and enqueues a page job for each newly claimed URL.
 */
async function claimAndEnqueue(env: Env, source: SourceRow, settings: SourceSettings, urls: URL[], depth: number, follow: boolean): Promise<number> {
  const syncToken = settings.syncToken!;
  const maxPages = settings.maxPages ?? DEFAULT_MAX_PAGES;
  const { claimed } = (await env.DB.prepare("SELECT COUNT(*) AS claimed FROM kb_documents WHERE source_id = ? AND sync_token = ?")
    .bind(source.id, syncToken)
    .first<{ claimed: number }>())!;
  let budget = maxPages - claimed;
  const jobs: CrawlJob[] = [];
  for (const url of urls) {
    if (budget <= 0) break;
    if (isExcluded(url, settings.exclude)) continue;
    const href = url.toString();
    const row = await env.DB.prepare(
      `INSERT INTO kb_documents (id, workspace_id, source_id, url, sync_token, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, url) DO UPDATE SET sync_token = excluded.sync_token
       WHERE kb_documents.sync_token IS NOT excluded.sync_token
       RETURNING id`,
    )
      .bind(newId("doc"), source.workspace_id, source.id, href, syncToken, Date.now())
      .first();
    if (!row) continue; // already claimed in this sync
    budget--;
    jobs.push({ type: "page", sourceId: source.id, syncToken, url: href, depth, follow });
  }
  if (jobs.length === 0) return 0;
  await env.DB.prepare("UPDATE kb_sources SET pending_jobs = pending_jobs + ? WHERE id = ?").bind(jobs.length, source.id).run();
  for (let i = 0; i < jobs.length; i += 100) await env.CRAWL_QUEUE.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
  return jobs.length;
}

/** Starts (or restarts) a crawl of a website source. */
export async function startSync(env: Env, sourceId: string): Promise<void> {
  await env.CRAWL_QUEUE.send({ type: "sync", sourceId } satisfies CrawlJob);
}

async function runSync(env: Env, sourceId: string): Promise<void> {
  const source = await loadSource(env, sourceId);
  if (!source || source.kind !== "website" || !source.url) return;
  const start = normalizeUrl(source.url);
  if (!start) {
    await env.DB.prepare("UPDATE kb_sources SET status = 'error', error = 'Invalid URL' WHERE id = ?").bind(sourceId).run();
    return;
  }

  const robots = await readRobots(start.origin);
  const settings: SourceSettings = { ...(JSON.parse(source.settings) as SourceSettings), syncToken: newId("sync"), disallow: robots.disallow };
  await env.DB.prepare("UPDATE kb_sources SET status = 'syncing', error = NULL, pending_jobs = 0, settings = ? WHERE id = ?")
    .bind(JSON.stringify(settings), sourceId)
    .run();

  // Prefer the sitemap; fall back to following links from the start page.
  const fromSitemaps = (await Promise.all([...new Set([...robots.sitemaps, `${start.origin}/sitemap.xml`])].map((s) => readSitemap(s)))).flat();
  const sitemapUrls = fromSitemaps
    .map(normalizeUrl)
    .filter((u): u is URL => u !== null && inScope(u, start) && allowedByRobots(u, robots.disallow));

  const enqueued = sitemapUrls.length
    ? await claimAndEnqueue(env, source, settings, [start, ...sitemapUrls], 0, false)
    : await claimAndEnqueue(env, source, settings, [start], 0, true);
  if (enqueued === 0) await finishSync(env, source, settings);
}

async function runPage(env: Env, job: Extract<CrawlJob, { type: "page" }>): Promise<void> {
  const source = await loadSource(env, job.sourceId);
  if (!source) return;
  const settings = JSON.parse(source.settings) as SourceSettings;
  if (settings.syncToken !== job.syncToken) return; // superseded by a newer sync

  try {
    const url = new URL(job.url);
    if (!allowedByRobots(url, settings.disallow ?? []) || isExcluded(url, settings.exclude)) return;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) return;

    const page = await extractPage(res, res.url || job.url);
    const text = page.blocks.map((b) => b.text).join("\n");
    const hash = await contentHash(`${page.title}\n${text}`);
    const doc = await env.DB.prepare("SELECT id, content_hash FROM kb_documents WHERE source_id = ? AND url = ?")
      .bind(source.id, job.url)
      .first<{ id: string; content_hash: string | null }>();

    if (doc && doc.content_hash !== hash && text.length > 50) {
      const title = page.title || url.pathname;
      await indexText(env, { workspaceId: source.workspace_id, sourceId: source.id, documentId: doc.id, url: job.url, title }, page.blocks);
      await env.DB.prepare("UPDATE kb_documents SET title = ?, content_hash = ?, updated_at = ? WHERE id = ?").bind(title, hash, Date.now(), doc.id).run();
    }

    if (job.follow && job.depth < MAX_DEPTH) {
      const start = normalizeUrl(source.url!)!;
      const links = page.links
        .map(normalizeUrl)
        .filter((u): u is URL => u !== null && inScope(u, start) && allowedByRobots(u, settings.disallow ?? []));
      await claimAndEnqueue(env, source, settings, links, job.depth + 1, true);
    }
  } catch (error) {
    console.error(`crawl ${job.url}:`, error);
    // Remembered so a crawl that reads nothing can say why.
    await env.DB.prepare("UPDATE kb_sources SET error = ? WHERE id = ?").bind(`${job.url}: ${(error as Error).message}`.slice(0, 300), source.id).run();
  } finally {
    const row = await env.DB.prepare("UPDATE kb_sources SET pending_jobs = pending_jobs - 1 WHERE id = ? RETURNING pending_jobs")
      .bind(source.id)
      .first<{ pending_jobs: number }>();
    if (row && row.pending_jobs <= 0) await finishSync(env, source, settings);
  }
}

/** After the last page: drop pages that disappeared from the site and mark the source ready. */
async function finishSync(env: Env, source: SourceRow, settings: SourceSettings): Promise<void> {
  const stale = await env.DB.prepare("SELECT c.id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id WHERE d.source_id = ? AND d.sync_token IS NOT ?")
    .bind(source.id, settings.syncToken)
    .all<{ id: string }>();
  if (stale.results.length) await index(env, source.workspace_id).deleteChunks(stale.results.map((r) => r.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_documents WHERE source_id = ? AND sync_token IS NOT ?").bind(source.id, settings.syncToken),
    // A crawl that indexed nothing is an error the admin should see, not "ready, 0 pages".
    env.DB.prepare(
      `UPDATE kb_sources SET last_synced_at = ?1,
         page_count = (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL),
         status = CASE WHEN (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) > 0 THEN 'ready' ELSE 'error' END,
         error = CASE WHEN (SELECT COUNT(*) FROM kb_documents WHERE source_id = ?2 AND content_hash IS NOT NULL) > 0 THEN NULL
                      ELSE COALESCE('No readable pages. Last error: ' || error, 'No readable pages found at this URL.') END
       WHERE id = ?2`,
    ).bind(Date.now(), source.id),
  ]);
  await fillMissingVectors(env, source.workspace_id, source.id);
}

/** Queue consumer. Every job is acknowledged; failures are logged, not retried forever. */
export async function handleCrawlBatch(batch: MessageBatch<CrawlJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === "sync") await runSync(env, message.body.sourceId);
      else if (message.body.type === "file") await runFile(env, message.body.sourceId);
      else await runPage(env, message.body);
    } catch (error) {
      console.error("crawl job failed:", error);
    }
    message.ack();
  }
}

/**
 * Daily re-sync of website sources (cron). Unchanged pages are skipped by content hash, and a
 * finished sync fills missing vectors. Snippets and files only get their missing vectors.
 */
export async function resyncAll(env: Env): Promise<void> {
  const due = await env.DB.prepare("SELECT id FROM kb_sources WHERE kind = 'website' AND status != 'syncing' AND (last_synced_at IS NULL OR last_synced_at < ?)")
    .bind(Date.now() - 20 * 60 * 60 * 1000)
    .all<{ id: string }>();
  for (const { id } of due.results) await startSync(env, id);
  const unembedded = await env.DB.prepare(
    "SELECT s.id, s.workspace_id FROM kb_sources s WHERE s.kind != 'website' AND EXISTS (SELECT 1 FROM kb_chunks c WHERE c.source_id = s.id AND c.embedded = 0)",
  ).all<{ id: string; workspace_id: string }>();
  for (const s of unembedded.results) {
    if ((await fillMissingVectors(env, s.workspace_id, s.id)) > 0) break; // still failing: try again tomorrow
  }
}
