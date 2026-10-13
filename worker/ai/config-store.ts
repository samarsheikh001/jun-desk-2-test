import { newId } from "../lib/crypto.ts";
import { defaultFiles, parseConfig, type AgentConfig, type ConfigFiles, type ConfigIssue } from "./config.ts";

// Agent config versions in D1 (AI-18). Git is where teams keep history; the desk keeps
// every saved version too, so dashboard edits and `jun push` never silently overwrite each other.

export interface ConfigVersion {
  version: number;
  message: string;
  source: "dashboard" | "cli";
  createdBy: string | null;
  createdAt: number;
}

export interface StoredConfig {
  /** null = never saved: the built-in default (built from the old Settings guidance). */
  version: number | null;
  files: ConfigFiles;
}

export async function loadConfigFiles(env: Env, workspaceId: string, version?: number): Promise<StoredConfig> {
  const row = await env.DB.prepare(
    version === undefined
      ? "SELECT version, files FROM agent_configs WHERE workspace_id = ? ORDER BY version DESC LIMIT 1"
      : "SELECT version, files FROM agent_configs WHERE workspace_id = ? AND version = ?",
  )
    .bind(...(version === undefined ? [workspaceId] : [workspaceId, version]))
    .first<{ version: number; files: string }>();
  if (row) return { version: row.version, files: JSON.parse(row.files) as ConfigFiles };
  const legacy = await env.DB.prepare("SELECT instructions FROM ai_settings WHERE workspace_id = ?").bind(workspaceId).first<{ instructions: string }>();
  return { version: null, files: defaultFiles(legacy?.instructions ?? "") };
}

/** The live config. Files that fail validation are left out (they were rejected on save anyway). */
export async function loadAgentConfig(env: Env, workspaceId: string): Promise<AgentConfig> {
  const stored = await loadConfigFiles(env, workspaceId);
  return parseConfig(stored.files, stored.version).config;
}

export class ConfigConflictError extends Error {
  constructor(readonly current: number | null) {
    super(`The config changed since you loaded it (now version ${current ?? "default"}). Pull the latest first, or save with force.`);
  }
}

/**
 * Saves a new version. `base` is the version the edit started from; if someone saved in
 * between, it's a conflict unless `force`. Returns validation issues instead of saving.
 */
export async function saveConfig(
  env: Env,
  workspaceId: string,
  input: { files: ConfigFiles; base: number | null; force?: boolean; message: string; source: ConfigVersion["source"]; userId: string },
): Promise<{ version: number; issues: [] } | { version: null; issues: ConfigIssue[] }> {
  const { issues } = parseConfig(input.files);
  if (issues.length) return { version: null, issues };
  const current = await env.DB.prepare(
    "SELECT MAX(version) AS v, MAX(CASE WHEN source = 'dashboard' THEN version END) AS d FROM agent_configs WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<{ v: number | null; d: number | null }>();
  const latest = current?.v ?? null;
  // Dashboard saves must start from the latest version (two people editing in the browser).
  // CLI pushes come from git, which is their source of truth: they only conflict with
  // dashboard edits made since the pusher's last pull, which would otherwise be lost.
  const conflict = input.source === "dashboard" ? latest !== input.base : current?.d != null && current.d > (input.base ?? 0);
  if (!input.force && conflict) throw new ConfigConflictError(latest);
  const version = (latest ?? 0) + 1;
  // UNIQUE (workspace_id, version) turns a race between two saves into an error, not a lost update.
  await env.DB.prepare(
    "INSERT INTO agent_configs (id, workspace_id, version, files, message, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId("cfg"), workspaceId, version, JSON.stringify(input.files), input.message.slice(0, 500), input.source, input.userId, Date.now())
    .run();
  return { version, issues: [] };
}

export async function listVersions(env: Env, workspaceId: string, limit = 50): Promise<ConfigVersion[]> {
  const rows = await env.DB.prepare(
    `SELECT c.version, c.message, c.source, u.name AS createdBy, c.created_at AS createdAt
     FROM agent_configs c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.workspace_id = ? ORDER BY c.version DESC LIMIT ?`,
  )
    .bind(workspaceId, limit)
    .all<ConfigVersion>();
  return rows.results;
}
