import { chatgptOAuth as oauth, tokensFromResponse, type ChatGPTCredentials } from "@jun/llm";
import { Hono } from "hono";
import { MAX_KB_FILE_BYTES, MAX_KB_FILES } from "../../shared/protocol.ts";
import { sniffFormat, titleFromName, UnsupportedFile, type FileFormat } from "../ai/file-extract.ts";
import { deleteSource, DEFAULT_MAX_PAGES, fileKey, indexSnippet, removeDocument, startFileIndex, startSync, type SourceSettings } from "../ai/knowledge.ts";
import { effectiveModels, InvalidModelsError, JOB_DEFAULTS, parseJobModels, type JobModels } from "../ai/models.ts";
import { DEFAULT_MODELS, isLoopback, loadAiSettings, type ProviderId } from "../ai/providers.ts";
import { searchKnowledge } from "../ai/search.ts";
import { requireUser } from "../auth/session.ts";
import { newId } from "../lib/crypto.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

const PROVIDERS: ProviderId[] = ["openai", "workers-ai", "chatgpt"];

export const ai = new Hono<AppEnv>();
ai.use("/workspaces/:id/ai", requireUser);
ai.use("/workspaces/:id/ai/*", requireUser);
ai.use("/workspaces/:id/knowledge", requireUser);
ai.use("/workspaces/:id/knowledge/*", requireUser);

// ---------- AI settings (T-10, AI-07, B-03) ----------

ai.get("/workspaces/:id/ai", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const settings = await loadAiSettings(c.env, workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const usage = await c.env.DB.prepare("SELECT replies, input_tokens AS inputTokens, output_tokens AS outputTokens FROM ai_usage WHERE workspace_id = ? AND month = ?")
    .bind(workspaceId, month)
    .first();
  const chatgpt = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  const creds = chatgpt ? (JSON.parse(chatgpt.credentials) as ChatGPTCredentials) : undefined;
  return c.json({
    settings,
    defaults: DEFAULT_MODELS,
    // W-22: jobs with their own default per provider (widget editing on the large model).
    jobDefaults: JOB_DEFAULTS,
    // AI-16: the model each job runs on now (its override, else the workspace model).
    effectiveModels: effectiveModels(settings),
    openaiKeyConfigured: Boolean((c.env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY),
    devChatgpt: {
      available: true,
      connected: Boolean(creds?.tokens),
      email: creds?.tokens?.email ?? null,
    },
    usage: { month, replies: 0, inputTokens: 0, outputTokens: 0, ...(usage ?? {}) },
  });
});

ai.put("/workspaces/:id/ai", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const provider = String(body.provider ?? "workers-ai") as ProviderId;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, "invalid_field", "Unknown provider.");
  const cap = Number(body.monthlyReplyCap ?? 2000);
  if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) throw new HttpError(400, "invalid_field", "Monthly cap must be a whole number.");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 100) : null;
  // AI-16: per-job models; kept unless sent.
  let models: JobModels | undefined;
  try {
    if (body.models !== undefined) models = parseJobModels(body.models);
  } catch (error) {
    if (error instanceof InvalidModelsError) throw new HttpError(400, "invalid_field", error.message);
    throw error;
  }
  const current = typeof body.instructions === "string" && models ? null : await loadAiSettings(c.env, workspaceId);
  // Guidance now lives in the agent config (AGENTS.md); the old field is kept unless sent.
  const instructions = typeof body.instructions === "string" ? body.instructions.slice(0, 4000) : current!.instructions;
  models ??= current!.models;

  await c.env.DB.prepare(
    `INSERT INTO ai_settings (workspace_id, enabled, provider, model, models, instructions, monthly_reply_cap, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, provider = excluded.provider, model = excluded.model, models = excluded.models,
       instructions = excluded.instructions, monthly_reply_cap = excluded.monthly_reply_cap, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, body.enabled ? 1 : 0, provider, model, JSON.stringify(models), instructions, cap, Date.now())
    .run();
  return c.json({ settings: await loadAiSettings(c.env, workspaceId) });
});

// ---------- Sign in with ChatGPT (D-10, D-27) ----------

// A deployed desk can't receive the 127.0.0.1 loopback redirect, so the browser lands on a page
// that doesn't load; the admin pastes that address back (POST .../chatgpt/finish).
const PASTE_PORT = "1455";

ai.post("/workspaces/:id/ai/chatgpt/start", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const url = new URL(c.req.url);

  // OpenAI's open-source flow requires a 127.0.0.1 loopback redirect; only the port may vary.
  const paste = !isLoopback(url.hostname);
  const redirectUri = `http://127.0.0.1:${paste ? PASTE_PORT : url.port || "80"}${oauth.CALLBACK_PATH}`;
  const row = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  let creds = row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
  if (!creds) {
    // The host id must be saved before the first sign-in.
    creds = { hostId: oauth.newHostId() };
    await c.env.DB.prepare("INSERT INTO dev_chatgpt (workspace_id, credentials) VALUES (?, ?)").bind(workspaceId, JSON.stringify(creds)).run();
  }

  const state = oauth.randomToken();
  const nonce = oauth.randomToken();
  const codeVerifier = oauth.randomToken(48);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dev_chatgpt_states WHERE expires_at < ?").bind(Date.now()),
    c.env.DB.prepare(
      "INSERT INTO dev_chatgpt_states (state, workspace_id, code_verifier, nonce, redirect_uri, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(state, workspaceId, codeVerifier, nonce, redirectUri, `${url.origin}/settings`, Date.now() + 10 * 60 * 1000),
  ]);
  return c.json({
    paste,
    url: oauth.buildAuthorizeUrl({
      clientId: creds.clientId,
      hostId: creds.hostId,
      redirectUri,
      state,
      nonce,
      codeChallenge: await oauth.pkceChallenge(codeVerifier),
      idTokenHint: creds.tokens?.idToken,
    }),
  });
});

ai.post("/workspaces/:id/ai/chatgpt/finish", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  let callback: URL;
  try {
    callback = new URL(String(body.callbackUrl ?? "").trim());
  } catch {
    throw new HttpError(400, "invalid_field", "Paste the full address of the page that didn't load (it starts with http://127.0.0.1).");
  }
  if (callback.pathname !== oauth.CALLBACK_PATH) throw new HttpError(400, "invalid_field", "That isn't the sign-in return address. It should end in /auth/callback?code=…");
  try {
    await finishChatGPTSignIn(c.env, callback.searchParams, workspaceId);
  } catch (e) {
    throw new HttpError(400, "chatgpt_failed", (e as Error).message);
  }
  return c.json({ ok: true });
});

/**
 * Local only (e2e): use an access token from the CLI's ChatGPT login (`~/.jun/chatgpt.json`)
 * without its refresh token, so the CLI stays the one place that rotates it. When the token
 * expires, AI turns fail and hand off, as with any AI error.
 */
ai.post("/workspaces/:id/ai/chatgpt/access-token", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  if (!isLoopback(new URL(c.req.url).hostname)) throw new HttpError(404, "not_found", "Not found.");
  const body = await readJson(c.req);
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  const expiresAt = Number(body.expiresAt);
  if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new HttpError(400, "invalid_field", "Needs an unexpired accessToken and its expiresAt.");
  const row = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  const existing = row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
  const creds: ChatGPTCredentials = {
    hostId: existing?.hostId ?? oauth.newHostId(),
    clientId: typeof body.clientId === "string" && body.clientId ? body.clientId : (existing?.clientId ?? "cli"),
    tokens: { accessToken, refreshToken: "", expiresAt, earliestRefreshAt: expiresAt },
  };
  await c.env.DB.prepare("INSERT INTO dev_chatgpt (workspace_id, credentials) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET credentials = excluded.credentials")
    .bind(workspaceId, JSON.stringify(creds))
    .run();
  await c.env.WORKSPACE_HUB.getByName(workspaceId).resetChatGPT();
  return c.json({ ok: true });
});

ai.delete("/workspaces/:id/ai/chatgpt", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const row = await c.env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
  if (row) {
    const creds = JSON.parse(row.credentials) as ChatGPTCredentials;
    if (creds.clientId && creds.tokens) await oauth.revokeToken({ clientId: creds.clientId, token: creds.tokens.refreshToken }).catch(() => {});
    // Keep the host and client ids for the next sign-in, as the docs ask.
    await c.env.DB.prepare("UPDATE dev_chatgpt SET credentials = ? WHERE workspace_id = ?")
      .bind(JSON.stringify({ hostId: creds.hostId, clientId: creds.clientId }), workspaceId)
      .run();
  }
  await c.env.WORKSPACE_HUB.getByName(workspaceId).resetChatGPT();
  return c.json({ ok: true });
});

/** GET /auth/callback on 127.0.0.1 (outside /api): finishes a local ChatGPT sign-in. */
export async function handleChatGPTCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = (title: string, body: string, status = 400) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  try {
    const returnTo = await finishChatGPTSignIn(env, url.searchParams);
    return Response.redirect(`${returnTo}?chatgpt=connected`, 302);
  } catch (e) {
    return page("Sign-in failed", String((e as Error).message).replace(/</g, "&lt;"));
  }
}

/**
 * Exchanges the callback's code for tokens and switches the workspace to ChatGPT. Returns the
 * page to go back to. `workspaceId`, when given, must match the sign-in that was started.
 */
async function finishChatGPTSignIn(env: Env, params: URLSearchParams, workspaceId?: string): Promise<string> {
  const stateRow = await env.DB.prepare(
    "DELETE FROM dev_chatgpt_states WHERE state = ? AND expires_at > ? AND (?3 IS NULL OR workspace_id = ?3) RETURNING workspace_id, code_verifier, nonce, redirect_uri, return_to",
  )
    .bind(params.get("state") ?? "", Date.now(), workspaceId ?? null)
    .first<{ workspace_id: string; code_verifier: string; nonce: string; redirect_uri: string; return_to: string }>();
  if (!stateRow) throw new Error("This sign-in is old or was already used. Start again from Settings.");
  const error = params.get("error");
  if (error) throw new Error(`${error} ${params.get("error_description") ?? ""}`.trim());

  const row = await env.DB.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(stateRow.workspace_id).first<{ credentials: string }>();
  const existing = row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
  const clientId = params.get("client_id") ?? existing?.clientId;
  const code = params.get("code");
  if (!existing || !clientId || clientId === oauth.REGISTRATION_CLIENT_ID || !code) throw new Error("The return address was missing the code or client id.");

  const response = await oauth.exchangeCode({ clientId, code, codeVerifier: stateRow.code_verifier, redirectUri: stateRow.redirect_uri });
  if (!response.id_token) throw new Error("No id_token in the token response.");
  await oauth.verifyIdToken(response.id_token, { clientId, nonce: stateRow.nonce });
  const creds: ChatGPTCredentials = { hostId: existing.hostId, clientId, tokens: tokensFromResponse(response) };
  await env.DB.batch([
    env.DB.prepare("UPDATE dev_chatgpt SET credentials = ? WHERE workspace_id = ?").bind(JSON.stringify(creds), stateRow.workspace_id),
    env.DB.prepare(
      `INSERT INTO ai_settings (workspace_id, enabled, provider, updated_at) VALUES (?, 1, 'chatgpt', ?)
       ON CONFLICT (workspace_id) DO UPDATE SET provider = 'chatgpt', updated_at = excluded.updated_at`,
    ).bind(stateRow.workspace_id, Date.now()),
  ]);
  await env.WORKSPACE_HUB.getByName(stateRow.workspace_id).resetChatGPT();
  return stateRow.return_to;
}

// ---------- knowledge base (K-01, K-03, K-04 lite) ----------

ai.get("/workspaces/:id/knowledge", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url, title, status, page_count AS pageCount, pending_jobs AS pendingJobs, error, last_synced_at AS lastSyncedAt, created_at AS createdAt,
            json_extract(settings, '$.file.name') AS fileName, json_extract(settings, '$.file.size') AS fileSize,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.source_id = s.id) AS chunkCount,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.source_id = s.id AND k.embedded = 0) AS chunksWithoutVectors
     FROM kb_sources s WHERE workspace_id = ? ORDER BY created_at DESC`,
  )
    .bind(workspaceId)
    .all();
  return c.json({ sources: rows.results });
});

ai.post("/workspaces/:id/knowledge/websites", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  let url: URL;
  try {
    url = new URL(text(body, "url", { max: 2000 }));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new HttpError(400, "invalid_field", "Enter a full URL, like https://docs.example.com.");
  }
  const maxPages = Math.min(Math.max(Number(body.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES, 1), 2000);
  const id = newId("src");
  await c.env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, url, title, settings, created_at) VALUES (?, ?, 'website', ?, ?, ?, ?)")
    .bind(id, workspaceId, url.toString(), url.host + (url.pathname === "/" ? "" : url.pathname), JSON.stringify({ maxPages }), Date.now())
    .run();
  await startSync(c.env, id);
  return c.json({ id });
});

ai.post("/workspaces/:id/knowledge/snippets", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const id = newId("src");
  await c.env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, title, body, created_at) VALUES (?, ?, 'snippet', ?, ?, ?)")
    .bind(id, workspaceId, text(body, "title", { max: 200 }), text(body, "body", { max: 20_000 }), Date.now())
    .run();
  await indexSnippet(c.env, id);
  return c.json({ id });
});

// K-02: upload a file (raw body with X-Jun-Upload: 1 and a URI-encoded X-File-Name, like
// attachments). The original goes to R2; a Queue job extracts and indexes it.
const FILE_CONTENT_TYPES: Record<FileFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown; charset=utf-8",
  text: "text/plain; charset=utf-8",
};
const TOO_LARGE = `Files are limited to ${MAX_KB_FILE_BYTES / 1024 / 1024} MB.`;

ai.post("/workspaces/:id/knowledge/files", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  if (c.req.header("x-jun-upload") !== "1") throw new HttpError(400, "upload_required", "Send the file as the request body with X-Jun-Upload: 1.");
  if (Number(c.req.header("content-length") ?? 0) > MAX_KB_FILE_BYTES) throw new HttpError(400, "too_large", TOO_LARGE);
  let name = "";
  try {
    name = decodeURIComponent(c.req.header("x-file-name") ?? "");
  } catch {
    // rejected below
  }
  name = name.replace(/[\\/\r\n"\0]/g, "_").trim().slice(0, 200);
  if (!name) throw new HttpError(400, "invalid_field", "Send the file name in X-File-Name.");
  const { n } = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM kb_sources WHERE workspace_id = ? AND kind = 'file'").bind(workspaceId).first<{ n: number }>())!;
  if (n >= MAX_KB_FILES) throw new HttpError(400, "too_many_files", `A workspace can have up to ${MAX_KB_FILES} files. Remove some first.`);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > MAX_KB_FILE_BYTES) throw new HttpError(400, "too_large", TOO_LARGE);
  let format: FileFormat;
  try {
    format = sniffFormat(name, bytes);
  } catch (error) {
    if (error instanceof UnsupportedFile) throw new HttpError(400, "unsupported_file", error.message);
    throw error;
  }

  const id = newId("src");
  const key = fileKey(workspaceId, id);
  const title = titleFromName(name);
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: FILE_CONTENT_TYPES[format] } });
  await c.env.DB.prepare("INSERT INTO kb_sources (id, workspace_id, kind, title, settings, created_at) VALUES (?, ?, 'file', ?, ?, ?)")
    .bind(id, workspaceId, title, JSON.stringify({ file: { key, name, format, size: bytes.byteLength } } satisfies SourceSettings), Date.now())
    .run();
  await startFileIndex(c.env, id);
  return c.json({ id, title, format, size: bytes.byteLength });
});

// K-02: the uploaded original, for the team (always a download).
ai.get("/workspaces/:id/knowledge/:sourceId/file", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const source = await c.env.DB.prepare("SELECT settings FROM kb_sources WHERE id = ? AND workspace_id = ? AND kind = 'file'")
    .bind(c.req.param("sourceId"), workspaceId)
    .first<{ settings: string }>();
  const file = source ? (JSON.parse(source.settings) as SourceSettings).file : undefined;
  const object = file ? await c.env.FILES.get(file.key) : null;
  if (!file || !object) throw new HttpError(404, "not_found", "File not found.");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  });
});

ai.post("/workspaces/:id/knowledge/:sourceId/sync", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const source = await c.env.DB.prepare("SELECT kind FROM kb_sources WHERE id = ? AND workspace_id = ?").bind(c.req.param("sourceId"), workspaceId).first<{ kind: string }>();
  if (!source) throw new HttpError(404, "not_found", "Source not found.");
  if (source.kind === "website") await startSync(c.env, c.req.param("sourceId"));
  else if (source.kind === "file") await startFileIndex(c.env, c.req.param("sourceId"));
  else await indexSnippet(c.env, c.req.param("sourceId"));
  return c.json({ ok: true });
});

// K-04: what a source contains (pages, chunk counts) and its settings.
ai.get("/workspaces/:id/knowledge/:sourceId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const source = await c.env.DB.prepare("SELECT id, kind, url, title, body, settings FROM kb_sources WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("sourceId"), workspaceId)
    .first<{ id: string; kind: string; url: string | null; title: string; body: string | null; settings: string }>();
  if (!source) throw new HttpError(404, "not_found", "Source not found.");
  const settings = JSON.parse(source.settings) as SourceSettings;
  const documents = await c.env.DB.prepare(
    `SELECT d.id, d.url, d.title, d.updated_at AS updatedAt, (SELECT COUNT(*) FROM kb_chunks k WHERE k.document_id = d.id) AS chunkCount,
            (SELECT COUNT(*) FROM kb_chunks k WHERE k.document_id = d.id AND k.embedded = 0) AS chunksWithoutVectors
     FROM kb_documents d WHERE d.source_id = ? AND d.content_hash IS NOT NULL ORDER BY d.url LIMIT 1000`,
  )
    .bind(source.id)
    .all();
  const file = settings.file ? { name: settings.file.name, format: settings.file.format, size: settings.file.size } : null;
  return c.json({
    source: { id: source.id, kind: source.kind, url: source.url, title: source.title, body: source.body, maxPages: settings.maxPages ?? DEFAULT_MAX_PAGES, exclude: settings.exclude ?? [], file },
    documents: documents.results,
  });
});

// K-04: rename, edit a snippet (re-indexed now), or change a website's page cap / skipped pages (next sync).
ai.patch("/workspaces/:id/knowledge/:sourceId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const sourceId = c.req.param("sourceId");
  const source = await c.env.DB.prepare("SELECT kind, title, body, settings FROM kb_sources WHERE id = ? AND workspace_id = ?")
    .bind(sourceId, workspaceId)
    .first<{ kind: string; title: string; body: string | null; settings: string }>();
  if (!source) throw new HttpError(404, "not_found", "Source not found.");
  const body = await readJson(c.req);
  const title = body.title === undefined ? source.title : text(body, "title", { max: 200 });
  if (source.kind === "snippet") {
    const snippet = body.body === undefined ? (source.body ?? "") : text(body, "body", { max: 20_000 });
    await c.env.DB.prepare("UPDATE kb_sources SET title = ?, body = ? WHERE id = ?").bind(title, snippet, sourceId).run();
    await indexSnippet(c.env, sourceId);
    return c.json({ ok: true });
  }
  if (source.kind === "file") {
    // Chunks carry the title (and FTS indexes it), so a new title means re-indexing.
    if (title !== source.title) {
      await c.env.DB.prepare("UPDATE kb_sources SET title = ? WHERE id = ?").bind(title, sourceId).run();
      await startFileIndex(c.env, sourceId);
    }
    return c.json({ ok: true });
  }
  const settings = JSON.parse(source.settings) as SourceSettings;
  if (body.maxPages !== undefined) {
    const n = Number(body.maxPages);
    if (!Number.isInteger(n) || n < 1 || n > 2000) throw new HttpError(400, "invalid_field", "Max pages must be a whole number from 1 to 2000.");
    settings.maxPages = n;
  }
  if (body.exclude !== undefined) {
    const list = (Array.isArray(body.exclude) ? body.exclude.map(String) : String(body.exclude).split(/\n+/)).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !s.startsWith("/") && !/^https?:\/\//.test(s));
    if (bad.length) throw new HttpError(400, "invalid_field", `Use a path like /blog/ or a full URL: ${bad.slice(0, 3).join(", ")}`);
    settings.exclude = [...new Set(list)].slice(0, 500);
  }
  await c.env.DB.prepare("UPDATE kb_sources SET title = ?, settings = ? WHERE id = ?").bind(title, JSON.stringify(settings), sourceId).run();
  return c.json({ ok: true });
});

// K-04: exactly what was indexed from one page (what the AI can quote).
ai.get("/workspaces/:id/knowledge/:sourceId/documents/:docId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    "SELECT heading, text FROM kb_chunks WHERE document_id = ? AND source_id = ? AND workspace_id = ? ORDER BY position",
  )
    .bind(c.req.param("docId"), c.req.param("sourceId"), workspaceId)
    .all<{ heading: string; text: string }>();
  return c.json({ chunks: rows.results });
});

ai.delete("/workspaces/:id/knowledge/:sourceId/documents/:docId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  if (!(await removeDocument(c.env, workspaceId, c.req.param("sourceId"), c.req.param("docId")))) throw new HttpError(404, "not_found", "Page not found.");
  return c.json({ ok: true });
});

ai.delete("/workspaces/:id/knowledge/:sourceId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  if (!(await deleteSource(c.env, workspaceId, c.req.param("sourceId")))) throw new HttpError(404, "not_found", "Source not found.");
  return c.json({ ok: true });
});

// "Test a question": see exactly what the AI would get as sources.
ai.post("/workspaces/:id/knowledge/search", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = await readJson(c.req);
  return c.json({ hits: await searchKnowledge(c.env, workspaceId, text(body, "query", { max: 1000 })) });
});
