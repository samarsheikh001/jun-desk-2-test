import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { parseConfig, type ConfigFiles } from "../ai/config.ts";
import { ConfigConflictError, listVersions, loadConfigFiles, saveConfig } from "../ai/config-store.ts";
import { DEFAULT_REPLAY_SAMPLE, MAX_REPLAY_SAMPLE, runEval, type EvalEvent } from "../ai/eval.ts";
import { AiUnavailableError, createModel, loadAiSettings } from "../ai/providers.ts";
import { WIDGET_EDIT_MAX_TOKENS, WIDGET_EDIT_PROMPT, WidgetEditError, widgetEditMessage } from "../ai/widget-edit.ts";
import { AGENT_FILE_EDIT_MAX_TOKENS, AgentFileEditError, agentFileEditMessages, TASK_EDIT_MAX_TOKENS, taskEditMessages } from "../ai/agent-file-edit.ts";
import { editorSettings, editStream } from "../ai/edit-stream.ts";
import { recordUsage } from "../ai/topics.ts";
import { agentFileKind } from "../../shared/agent-file-ai.ts";
import { MAX_EDIT_HISTORY, MAX_EDIT_MESSAGE, type WidgetEditTurn } from "../../shared/widget-ai.ts";
import { MAX_WIDGET_JSON } from "../../shared/widgets.ts";
import { getSessionUser, requireUser } from "../auth/session.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { readJson, text } from "../lib/validate.ts";
import { loadToolSecrets, workerSecretNames } from "../lib/tool-secrets.ts";
import { runTool } from "../ai/tools.ts";
import { runTestChat } from "../ai/test-chat.ts";
import { MAX_TEST_MESSAGE, MAX_TEST_TURNS, type TestChatEvent, type TestPress, type TestReply, type TestTurn } from "../../shared/test-chat.ts";
import type { SeenPageAction } from "../../shared/actions.ts";
import type { ToolUser } from "../ai/config.ts";
import { MAX_DESK_SECRETS, MAX_SECRET_VALUE, SECRET_NAME } from "../../shared/action-setup.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// Agent config as code (AI-18) and `jun eval` (AI-19). The `jun` CLI calls these with a
// personal API token (Authorization: Bearer jun_…); the dashboard with its session cookie.

const TOKEN_PREFIX = "jun_";

/** Session cookie, or an API token for this workspace (tokens never work across workspaces). */
const requireUserOrToken = createMiddleware<AppEnv & { Variables: { tokenWorkspace: string | null } }>(async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const hash = await sha256(auth.slice("Bearer ".length).trim());
    const row = await c.env.DB.prepare(
      `SELECT t.id, t.workspace_id, u.id AS user_id, u.name, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
      .bind(hash)
      .first<{ id: string; workspace_id: string; user_id: string; name: string; email: string | null }>();
    if (!row) throw new HttpError(401, "bad_token", "This API token isn't valid. Create a new one in Settings → API tokens.");
    const workspaceId = c.req.param("id");
    if (workspaceId && workspaceId !== row.workspace_id) throw new HttpError(403, "wrong_workspace", "This API token belongs to another workspace.");
    c.set("user", { id: row.user_id, name: row.name, email: row.email });
    c.set("tokenWorkspace", row.workspace_id);
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run());
    return next();
  }
  const user = await getSessionUser(c as unknown as AppContext);
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in first.");
  c.set("user", user);
  c.set("tokenWorkspace", null);
  await next();
});

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change the agent.");
}

function readFiles(body: Record<string, unknown>): ConfigFiles {
  const files = body.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "invalid_field", "files must be an object of path → text.");
  const out: ConfigFiles = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== "string") throw new HttpError(400, "invalid_field", `${path}: file content must be text.`);
    out[path.replace(/\\/g, "/")] = content;
  }
  return out;
}

function summary(files: ConfigFiles) {
  const { config, issues } = parseConfig(files);
  return {
    issues,
    summary: {
      skills: config.skills.map((s) => s.name),
      tools: config.tools.map((t) => t.name),
      widgets: config.widgets.map((w) => w.name),
      evals: config.evals.length,
      maxReplies: config.maxReplies,
      handoffTopics: config.handoffTopics,
    },
  };
}

export const agent = new Hono<AppEnv>();
agent.use("/workspaces/:id/agent", requireUserOrToken);
agent.use("/workspaces/:id/agent/*", requireUserOrToken);
agent.use("/cli/whoami", requireUserOrToken);
agent.use("/workspaces/:id/tokens", requireUser);
// AI-24: keys for actions. Signed-in people only (an API token can't read or change them).
agent.use("/workspaces/:id/action-secrets", requireUser);
agent.use("/workspaces/:id/action-secrets/*", requireUser);
agent.use("/workspaces/:id/tokens/*", requireUser);

/** `jun login` checks its token here. */
agent.get("/cli/whoami", async (c) => {
  const workspaceId = (c as unknown as { get(k: "tokenWorkspace"): string | null }).get("tokenWorkspace");
  if (!workspaceId) throw new HttpError(400, "token_required", "Use an API token.");
  const ws = await c.env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ id: string; name: string }>();
  return c.json({ user: c.get("user"), workspace: ws, role: await memberRole(c, workspaceId) });
});

/**
 * AI-24: the keys actions can use ({secrets.NAME}), by name only: a Worker secret JUN_SECRET_<NAME>
 * (set by a developer, wins) or one pasted here (kept in the workspace hub, never D1). Values are
 * never returned; a pasted one shows its last 4 characters.
 */
agent.get("/workspaces/:id/action-secrets", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const desk = await c.env.WORKSPACE_HUB.getByName(workspaceId).actionSecrets();
  const worker = new Set(workerSecretNames(c.env));
  const names = [...new Set([...worker, ...Object.keys(desk)])].sort();
  return c.json({
    secrets: names.map((name) => (worker.has(name) ? { name, source: "worker" } : { name, source: "desk", last4: desk[name]!.slice(-4) })),
  });
});

agent.put("/workspaces/:id/action-secrets/:name", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const name = c.req.param("name");
  if (!SECRET_NAME.test(name)) throw new HttpError(400, "invalid_field", "Key names are UPPER_SNAKE_CASE, like API_KEY.");
  const body = await readJson(c.req);
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value) throw new HttpError(400, "invalid_field", "Paste the key.");
  if (value.length > MAX_SECRET_VALUE) throw new HttpError(400, "invalid_field", `A key is at most ${MAX_SECRET_VALUE} characters.`);
  const hub = c.env.WORKSPACE_HUB.getByName(workspaceId);
  const desk = await hub.actionSecrets();
  if (!(name in desk) && Object.keys(desk).length >= MAX_DESK_SECRETS) throw new HttpError(400, "too_many", `At most ${MAX_DESK_SECRETS} keys. Remove one you no longer use.`);
  await hub.setActionSecret(name, value);
  return c.json({ name, source: workerSecretNames(c.env).includes(name) ? "worker" : "desk", last4: value.slice(-4) });
});

agent.delete("/workspaces/:id/action-secrets/:name", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.WORKSPACE_HUB.getByName(workspaceId).setActionSecret(c.req.param("name"), null);
  return c.json({ ok: true });
});

// W-31: the website actions seen on the customer's site (names, descriptions, result shapes; never values).
agent.get("/workspaces/:id/agent/page-actions", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  return c.json({ actions: await c.env.WORKSPACE_HUB.getByName(workspaceId).pageActions() });
});

/** AI-25: a "Try it" result kept for the page, at most (the AI reads a shortened `output` anyway). */
const MAX_TRY_RESULT = 200_000;
/** AI-29: a test chat sent back with each message, at most (its cards count). */
const MAX_TEST_BODY = 400_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "").map(([k, s]) => [k, s.slice(0, MAX_SECRET_VALUE)])) : {};

/** AI-25 / AI-29: a test customer the admin typed (for {user.*}), or null. */
function testCustomer(value: unknown): ToolUser | null {
  if (!isObject(value)) return null;
  const fields = strings(value);
  return { id: fields.id ?? "test-customer", email: fields.email ?? null, name: fields.name ?? null, attributes: strings(value.attributes), secrets: strings(value.secrets) };
}

/** AI-29: the test chat's turns from the body: customer messages and earlier replies (their cards too). */
function readTestTurns(value: unknown): TestTurn[] {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, "invalid_field", "turns is the test chat so far.");
  if (JSON.stringify(value).length > MAX_TEST_BODY) throw new HttpError(400, "too_long", "This test chat is too long. Reset it and start again.");
  const turns = value.slice(-MAX_TEST_TURNS).map((t): TestTurn => {
    if (isObject(t) && t.role === "customer" && typeof t.text === "string") {
      // AI-30: a card's button press: which card, the action, what was entered (checked against the card in runTestChat).
      const p = isObject(t.press) ? t.press : null;
      const press: TestPress | null =
        p && typeof p.turn === "number" && typeof p.widgetId === "string" && isObject(p.action) && typeof p.action.type === "string"
          ? {
              turn: p.turn,
              widgetId: p.widgetId,
              action: { type: p.action.type, ...(p.action.payload !== undefined ? { payload: p.action.payload } : {}) },
              values: isObject(p.values) ? (Object.fromEntries(Object.entries(p.values).filter(([, v]) => typeof v === "string" || typeof v === "boolean")) as Record<string, string | boolean>) : {},
              ...(typeof p.item === "string" ? { item: p.item } : {}),
              ...(isObject(p.tool) && typeof p.tool.name === "string" && (p.tool.status === "ok" || p.tool.status === "error")
                ? { tool: { name: p.tool.name, status: p.tool.status, output: typeof p.tool.output === "string" ? p.tool.output.slice(0, 4000) : "", ...(typeof p.tool.done === "string" ? { done: p.tool.done } : {}) } }
                : {}),
            }
          : null;
      return { role: "customer", text: t.text.slice(0, MAX_TEST_MESSAGE), ...(press ? { press } : {}) };
    }
    if (isObject(t) && t.role === "ai" && isObject(t.reply)) {
      const r = t.reply;
      return {
        role: "ai",
        reply: {
          text: typeof r.text === "string" ? r.text.slice(0, 8000) : "",
          ...(typeof r.handoff === "string" ? { handoff: r.handoff } : {}),
          widgets: Array.isArray(r.widgets) ? (r.widgets.filter((w) => isObject(w) && typeof w.name === "string" && isObject(w.root)).slice(0, 6) as unknown as TestReply["widgets"]) : [],
          calls: [],
          ...(isObject(r.pageAction) && typeof r.pageAction.name === "string" ? { pageAction: { name: r.pageAction.name, input: isObject(r.pageAction.input) ? r.pageAction.input : {} } } : {}),
        },
      };
    }
    throw new HttpError(400, "invalid_field", "Each turn is { role: customer, text } or { role: ai, reply }.");
  });
  if (turns.at(-1)?.role !== "customer") throw new HttpError(400, "invalid_field", "The last turn must be the customer's message.");
  return turns;
}

// AI-29: one reply in a task page's test chat, from the draft (shared/test-chat.ts). Body: { files,
// turns, real?, customer?, page? }. Streams TestChatEvents, one JSON object a line. Nothing is stored; the tokens
// count toward the month's usage. Safe unless `real: true`: changes (POST) are answered, not made.
agent.post("/workspaces/:id/agent/test-chat", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const turns = readTestTurns(body.turns);
  const page = typeof body.page === "string" && body.page.startsWith("/") ? body.page.slice(0, 300) : null;
  const { config } = parseConfig(files);
  const [settings, workspace, seen] = await Promise.all([
    loadAiSettings(c.env, workspaceId),
    c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>(),
    c.env.WORKSPACE_HUB.getByName(workspaceId).pageActions() as Promise<SeenPageAction[]>,
  ]);
  let model;
  try {
    model = createModel(c.env, workspaceId, settings, "answer");
  } catch (error) {
    if (error instanceof AiUnavailableError) throw new HttpError(400, "ai_unavailable", error.message);
    throw error;
  }
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = (event: TestChatEvent) => void writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  c.executionCtx.waitUntil(
    runTestChat(
      { env: c.env, workspaceId, workspaceName: workspace?.name ?? "this company", model, config, turns, real: body.real === true, user: testCustomer(body.customer), page, seen: seen.slice(0, 60) },
      emit,
    )
      .then((usage) => recordUsage(c.env, workspaceId, usage))
      .catch((error: unknown) => emit({ type: "error", message: (error as Error).message || "The AI couldn't answer." }))
      .finally(() => writer.close().catch(() => {})),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});

// AI-25: "Try it" on an action's page: the draft's version of the action, called once for real with
// the inputs the admin typed (and, for {user.*}, a test customer they typed). Same request, keys and
// scrubbing as a live chat; nothing is saved or audited (no conversation). Body: { files, name,
// input, customer? }. The page shows the answer and can make it the card's example data.
agent.post("/workspaces/:id/agent/try-action", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const name = text(body, "name", { max: 60 });
  const { config, issues } = parseConfig(files);
  const spec = config.tools.find((t) => t.name === name);
  if (!spec) {
    const problem = issues.find((i) => i.path === `tools/${name}.yaml`);
    throw new HttpError(400, "invalid_config", problem ? `Fix this first: ${problem.message}` : "There's no action with this name in the draft.");
  }
  const input = isObject(body.input) ? body.input : {};
  const customer = testCustomer(body.customer);
  const secrets = await loadToolSecrets(c.env, workspaceId);
  const { action, result } = await runTool(spec, input, { secrets, user: customer, widgets: config.widgets }, "wtry");
  const keep = result !== undefined && JSON.stringify(result).length <= MAX_TRY_RESULT;
  return c.json({
    status: action.status,
    httpStatus: action.httpStatus,
    durationMs: action.durationMs,
    output: action.output,
    ...(keep ? { result } : {}),
    ...(result !== undefined && !keep ? { tooBig: true } : {}),
  });
});

agent.get("/workspaces/:id/agent", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const v = c.req.query("version");
  const stored = await loadConfigFiles(c.env, workspaceId, v ? Number(v) : undefined);
  if (v && stored.version === null) throw new HttpError(404, "not_found", `No version ${v}.`);
  return c.json({ version: stored.version, files: stored.files, ...summary(stored.files), versions: await listVersions(c.env, workspaceId) });
});

agent.post("/workspaces/:id/agent/validate", async (c) => {
  await memberRole(c, c.req.param("id"));
  return c.json(summary(readFiles(await readJson(c.req))));
});

agent.put("/workspaces/:id/agent", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const base = body.base === null || body.base === undefined ? null : Number(body.base);
  const tokenWorkspace = (c as unknown as { get(k: "tokenWorkspace"): string | null }).get("tokenWorkspace");
  try {
    const result = await saveConfig(c.env, workspaceId, {
      files,
      base,
      force: body.force === true,
      message: text(body, "message", { max: 500, optional: true }),
      source: tokenWorkspace ? "cli" : "dashboard",
      userId: c.get("user").id,
    });
    if (result.version === null) return c.json({ error: { code: "invalid_config", message: "The config has errors.", issues: result.issues } }, 400);
    return c.json({ version: result.version, ...summary(files) });
  } catch (error) {
    if (error instanceof ConfigConflictError) return c.json({ error: { code: "conflict", message: error.message, current: error.current } }, 409);
    throw error;
  }
});

const WIDGET_EDIT_SKIPS = {
  ai_off: "Turn on the AI first (Agent → Settings).",
  cap_reached: "The monthly AI limit is reached, so the AI can't make changes here until next month.",
} as const;

function readHistory(body: Record<string, unknown>): WidgetEditTurn[] {
  return (Array.isArray(body.history) ? body.history : [])
    .filter((t): t is WidgetEditTurn => typeof t === "object" && t !== null && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
    .slice(-MAX_EDIT_HISTORY)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_EDIT_MESSAGE) }));
}

/** The AI is on and under the month's cap, else the reason as a 400. */
async function editorReady(c: AppContext, workspaceId: string) {
  const settings = await editorSettings(c.env, workspaceId);
  if ("skipped" in settings) throw new HttpError(400, settings.skipped, WIDGET_EDIT_SKIPS[settings.skipped]);
  return settings;
}

// W-22: one change to a widget, asked for in plain words. Body: { name, file, message, history?,
// files?, error? } (error: { template, message }, the last answer's problem, for the one retry).
// D-62: returns the model's answer as its raw event stream (header x-jun-format); the browser
// applies and checks it. Nothing is saved (the file goes into the admin's draft).
agent.post("/workspaces/:id/agent/widget-edit", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const name = text(body, "name", { max: 60 });
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new HttpError(400, "invalid_field", "name is a widget's file name.");
  const message = text(body, "message", { max: MAX_EDIT_MESSAGE });
  if (typeof body.file !== "string" || !body.file.trim() || body.file.length > MAX_WIDGET_JSON * 2) throw new HttpError(400, "invalid_field", "file is the widget file's text.");
  const raw = body.error as { template?: unknown; message?: unknown } | undefined;
  const error = raw && typeof raw.template === "string" && typeof raw.message === "string" ? { template: raw.template.slice(0, MAX_WIDGET_JSON * 2), message: raw.message.slice(0, 2000) } : undefined;
  const settings = await editorReady(c, workspaceId);
  let user: string;
  try {
    // W-27: the draft (optional), so the AI sees the actions the widget's buttons run.
    const files = body.files === undefined ? undefined : readFiles(body);
    // W-32: the website actions seen on the customer's site, for `page:<name>` buttons.
    const siteActions = ((await c.env.WORKSPACE_HUB.getByName(workspaceId).pageActions()) as unknown as { name: string; description: string; params: string[] }[]).slice(0, 30);
    user = widgetEditMessage({ name, file: body.file, message, history: readHistory(body), siteActions, ...(files ? { files } : {}), ...(error ? { error } : {}) });
  } catch (e) {
    if (e instanceof WidgetEditError) throw new HttpError(400, "edit_failed", e.message);
    throw e;
  }
  return editStream(c.env, workspaceId, settings, WIDGET_EDIT_PROMPT, user, WIDGET_EDIT_MAX_TOKENS);
});

// W-24: one change to an action or a procedure, asked for in plain words. Body: { path, files, message,
// history?, error?, task? } (files: the whole draft; error: { file, problems }, for the one retry). D-62:
// returns the model's answer as its raw event stream; the browser checks it like a save
// (…/agent/validate). Nothing is saved.
agent.post("/workspaces/:id/agent/file-edit", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const path = text(body, "path", { max: 200 });
  if (!agentFileKind(path)) throw new HttpError(400, "invalid_field", "path must be an action (tools/<name>.yaml) or a procedure (skills/<name>/SKILL.md).");
  const files = readFiles(body);
  const message = text(body, "message", { max: MAX_EDIT_MESSAGE });
  const raw = body.error as { file?: unknown; problems?: unknown } | undefined;
  const error =
    raw && typeof raw.file === "string" && Array.isArray(raw.problems)
      ? { file: raw.file.slice(0, 100_000), problems: raw.problems.filter((p): p is string => typeof p === "string").slice(0, 20).map((p) => p.slice(0, 500)) }
      : undefined;
  const settings = await editorReady(c, workspaceId);
  let prompt: { system: string; user: string };
  try {
    // AI-27: `task: true` on a procedure (a task): its chat may change the actions it uses and create new ones.
    const edit = { path, files, message, history: readHistory(body), ...(error ? { error } : {}) };
    prompt = body.task === true ? taskEditMessages(edit) : agentFileEditMessages(edit);
  } catch (e) {
    if (e instanceof AgentFileEditError) throw new HttpError(400, "edit_failed", e.message);
    throw e;
  }
  return editStream(c.env, workspaceId, settings, prompt.system, prompt.user, body.task === true ? TASK_EDIT_MAX_TOKENS : AGENT_FILE_EDIT_MAX_TOKENS);
});

// D-62: the tokens an editor answer used, reported by the browser once the stream ends (the Worker
// no longer reads the stream), for the month's usage. Body: { inputTokens, outputTokens }.
agent.post("/workspaces/:id/agent/usage", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 1_000_000) : 0);
  await recordUsage(c.env, workspaceId, { inputTokens: count(body.inputTokens), outputTokens: count(body.outputTokens) });
  return c.json({ ok: true });
});

// AI-19: streams NDJSON EvalEvents. Body: { files, sample?, mockTools?, cases?, replay? }.
agent.post("/workspaces/:id/agent/eval", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = await readJson(c.req);
  const files = readFiles(body);
  const parsed = parseConfig(files);
  if (parsed.issues.length) return c.json({ error: { code: "invalid_config", message: "Fix the config errors first.", issues: parsed.issues } }, 400);
  const sample = Math.min(Math.max(Number(body.sample ?? DEFAULT_REPLAY_SAMPLE) || 0, 0), MAX_REPLAY_SAMPLE);

  const [settings, liveFiles, workspace] = await Promise.all([
    loadAiSettings(c.env, workspaceId),
    loadConfigFiles(c.env, workspaceId),
    c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>(),
  ]);
  let model, judgeModel;
  try {
    model = createModel(c.env, workspaceId, settings, "answer");
    judgeModel = createModel(c.env, workspaceId, settings, "judge");
  } catch (error) {
    if (error instanceof AiUnavailableError) throw new HttpError(400, "ai_unavailable", error.message);
    throw error;
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = (event: EvalEvent) => void writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
  c.executionCtx.waitUntil(
    runEval(
      {
        env: c.env,
        workspaceId,
        workspaceName: workspace?.name ?? "this company",
        model,
        judgeModel,
        live: parseConfig(liveFiles.files, liveFiles.version).config,
        candidate: parsed.config,
        sample,
        mockTools: body.mockTools === true,
      },
      emit,
      { cases: body.cases !== false, replay: body.replay !== false && sample > 0 },
    )
      .catch((error: unknown) => emit({ type: "error", scope: "eval", message: (error as Error).message }))
      .finally(() => writer.close().catch(() => {})),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});

// ---------- API tokens for the CLI ----------

agent.get("/workspaces/:id/tokens", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC",
  )
    .bind(workspaceId, c.get("user").id)
    .all();
  return c.json({ tokens: rows.results });
});

agent.post("/workspaces/:id/tokens", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const name = text(await readJson(c.req), "name", { max: 80 });
  const token = `${TOKEN_PREFIX}${randomToken(24)}`;
  const id = newId("tok");
  await c.env.DB.prepare("INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, c.get("user").id, name, await sha256(token), Date.now())
    .run();
  // The only time the token is shown.
  return c.json({ id, name, token });
});

agent.delete("/workspaces/:id/tokens/:tokenId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND workspace_id = ? AND user_id = ?").bind(c.req.param("tokenId"), workspaceId, c.get("user").id).run();
  return c.json({ ok: true });
});

