import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { TEMPLATE } from "./template.ts";

// `jun` commands for a deployed desk: login, init, pull, push, eval (support agent as code).

export interface DeskLogin {
  url: string;
  token: string;
  workspaceId: string;
  workspaceName: string;
  user: string;
}

/** Version the folder was last pulled/pushed at, so push can spot dashboard edits made since. */
export const VERSION_FILE = ".jun-version";

function loginPath(): string {
  return process.env.JUN_HOME ? join(process.env.JUN_HOME, "desk.json") : join(homedir(), ".jun", "desk.json");
}

export async function loadLogin(): Promise<DeskLogin> {
  if (process.env.JUN_DESK_URL && process.env.JUN_DESK_TOKEN) {
    // CI: no login file needed.
    const who = await whoami(process.env.JUN_DESK_URL, process.env.JUN_DESK_TOKEN);
    return who;
  }
  try {
    return JSON.parse(await readFile(loginPath(), "utf8")) as DeskLogin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Not logged in to a desk. Run `jun login https://your-desk.example.com` (or set JUN_DESK_URL and JUN_DESK_TOKEN).");
    throw error;
  }
}

async function api<T>(login: Pick<DeskLogin, "url" | "token">, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${login.url}/api${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${login.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { code: string; message: string; issues?: Issue[]; current?: number | null } };
  if (!response.ok) throw new DeskError(response.status, json.error?.code ?? "error", json.error?.message ?? `HTTP ${response.status}`, json.error);
  return json;
}

interface Issue {
  path: string;
  message: string;
}

export class DeskError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: { issues?: Issue[]; current?: number | null } | undefined;

  constructor(status: number, code: string, message: string, detail?: { issues?: Issue[]; current?: number | null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function whoami(url: string, token: string): Promise<DeskLogin> {
  const base = url.replace(/\/+$/, "");
  const me = await api<{ user: { name: string }; workspace: { id: string; name: string } }>({ url: base, token }, "/cli/whoami");
  return { url: base, token, workspaceId: me.workspace.id, workspaceName: me.workspace.name, user: me.user.name };
}

export async function login(url: string, token: string): Promise<DeskLogin> {
  if (!/^https?:\/\//.test(url)) throw new Error("Usage: jun login https://your-desk.example.com");
  if (!token.startsWith("jun_")) throw new Error("That doesn't look like an API token (they start with jun_). Create one in Settings → API tokens.");
  const result = await whoami(url, token);
  const path = loginPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
  await rename(temp, path);
  return result;
}

const CONFIG_PATH = /^(AGENTS\.md|README\.md|website-actions\.yaml|skills\/[^/]+\/SKILL\.md|tools\/[^/]+\.ya?ml|evals\/[^/]+\.ya?ml|widgets\/[^/]+\.widget)$/;

/** Reads the config files under `dir` (paths with forward slashes). Other files are skipped. */
export async function readFolder(dir: string): Promise<{ files: Record<string, string>; skipped: string[] }> {
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const path = relative(dir, full).split(sep).join("/");
        if (CONFIG_PATH.test(path)) files[path] = await readFile(full, "utf8");
        else skipped.push(path);
      }
    }
  }
  await walk(dir);
  return { files, skipped };
}

async function readVersion(dir: string): Promise<number | null> {
  try {
    const n = Number((await readFile(join(dir, VERSION_FILE), "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const writeVersion = (dir: string, version: number | null) => (version === null ? Promise.resolve() : writeFile(join(dir, VERSION_FILE), `${version}\n`));

function printIssues(issues: Issue[]): void {
  for (const issue of issues) console.error(`  ✘ ${issue.path || "(config)"}: ${issue.message}`);
}

export async function init(dir: string): Promise<void> {
  const existing = await readdir(dir).catch(() => []);
  if (existing.length) throw new Error(`${dir} isn't empty. Use \`jun pull ${dir}\` to download your desk's config instead.`);
  for (const [path, text] of Object.entries(TEMPLATE)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  console.log(`Created ${dir}/ with ${Object.keys(TEMPLATE).length} files:`);
  for (const path of Object.keys(TEMPLATE)) console.log(`  ${path}`);
  console.log(`\nNext: edit them, then \`jun eval ${dir}\` and \`jun push ${dir}\`.`);
}

export async function pull(dir: string): Promise<void> {
  const desk = await loadLogin();
  const config = await api<{ version: number | null; files: Record<string, string> }>(desk, `/workspaces/${desk.workspaceId}/agent`);
  // Remove config files that no longer exist on the desk; leave anything else alone.
  const { files: local } = await readFolder(dir).catch(() => ({ files: {} as Record<string, string> }));
  for (const path of Object.keys(local)) if (!(path in config.files)) await rm(join(dir, path));
  for (const [path, text] of Object.entries(config.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await writeVersion(dir, config.version);
  console.log(`Pulled ${Object.keys(config.files).length} files (${config.version === null ? "built-in default config" : `version ${config.version}`}) from ${desk.workspaceName} into ${dir}/.`);
}

export async function push(dir: string, options: { message?: string; force?: boolean }): Promise<void> {
  const desk = await loadLogin();
  const { files, skipped } = await readFolder(dir);
  if (!files["AGENTS.md"]) throw new Error(`${dir}/AGENTS.md not found. Run \`jun init ${dir}\` or \`jun pull ${dir}\` first.`);
  for (const path of skipped) console.warn(`  (skipped ${path}: not a config file)`);
  try {
    const result = await api<{ version: number; summary: { skills: string[]; tools: string[]; evals: number } }>(desk, `/workspaces/${desk.workspaceId}/agent`, {
      method: "PUT",
      body: { files, base: await readVersion(dir), force: Boolean(options.force), message: options.message ?? "" },
    });
    await writeVersion(dir, result.version);
    const s = result.summary;
    console.log(`Pushed version ${result.version} to ${desk.workspaceName}: ${s.skills.length} procedures, ${s.tools.length} tools, ${s.evals} eval cases. It's live now.`);
  } catch (error) {
    if (error instanceof DeskError && error.code === "invalid_config") {
      console.error("Not pushed: the config has errors.");
      printIssues(error.detail?.issues ?? []);
      process.exitCode = 1;
      return;
    }
    if (error instanceof DeskError && error.code === "conflict") {
      throw new Error(`Someone edited the agent in the dashboard since your last pull (desk is at version ${error.detail?.current}). Run \`jun pull ${dir}\`, merge with git, then push again — or \`jun push --force\` to overwrite.`);
    }
    throw error;
  }
}

interface ReplyView {
  outcome: string;
  reply: string;
  tools: string[];
}

type EvalEvent =
  | { type: "start"; liveVersion: number | null; cases: number; conversations: number }
  | { type: "case"; file: string; name: string; pass: boolean; failures: string[]; result: ReplyView }
  | { type: "replay"; conversationId: string; question: string; verdict: "same" | "changed"; why: string; live: ReplyView; candidate: ReplyView }
  | { type: "error"; scope: string; message: string }
  | { type: "done"; cases: { passed: number; failed: number }; replay: { same: number; changed: number; errors: number } };

const clip = (text: string, n = 280) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const tools = (v: ReplyView) => (v.tools.length ? ` [${v.tools.join(", ")}]` : "");

export async function evaluate(dir: string, options: { sample?: number; mockTools?: boolean; cases?: boolean; replay?: boolean; json?: boolean; failOnChange?: boolean }): Promise<void> {
  const desk = await loadLogin();
  const { files } = await readFolder(dir);
  if (!files["AGENTS.md"]) throw new Error(`${dir}/AGENTS.md not found.`);
  const response = await fetch(`${desk.url}/api/workspaces/${desk.workspaceId}/agent/eval`, {
    method: "POST",
    headers: { authorization: `Bearer ${desk.token}`, "content-type": "application/json" },
    body: JSON.stringify({ files, sample: options.sample, mockTools: options.mockTools, cases: options.cases, replay: options.replay }),
  });
  if (!response.ok || !response.body) {
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string; issues?: Issue[] } };
    console.error(`Eval didn't run: ${json.error?.message ?? `HTTP ${response.status}`}`);
    printIssues(json.error?.issues ?? []);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  let buffer = "";
  const decoder = new TextDecoder();
  const handle = (event: EvalEvent) => {
    if (options.json) {
      console.log(JSON.stringify(event));
    } else if (event.type === "start") {
      console.log(`Evaluating ${dir}/ against ${desk.workspaceName} (live: ${event.liveVersion === null ? "default config" : `version ${event.liveVersion}`})`);
      console.log(`${event.cases} test case${event.cases === 1 ? "" : "s"}, ${event.conversations} recent conversation${event.conversations === 1 ? "" : "s"} to replay\n`);
    } else if (event.type === "case") {
      console.log(`${event.pass ? "✔" : "✘"} ${event.file} › ${event.name}`);
      for (const f of event.failures) console.log(`    ${f}`);
      if (!event.pass) console.log(`    reply (${event.result.outcome})${tools(event.result)}: ${clip(event.result.reply)}`);
    } else if (event.type === "replay") {
      if (event.verdict === "same") {
        console.log(`= ${clip(event.question, 80)}`);
      } else {
        console.log(`\n≠ ${clip(event.question, 120)}   (${event.why})`);
        console.log(`    live (${event.live.outcome})${tools(event.live)}: ${clip(event.live.reply)}`);
        console.log(`    new  (${event.candidate.outcome})${tools(event.candidate)}: ${clip(event.candidate.reply)}\n`);
      }
    } else if (event.type === "error") {
      console.log(`! ${event.scope}: ${event.message}`);
    } else if (event.type === "done") {
      const c = event.cases;
      const r = event.replay;
      console.log(`\nCases: ${c.passed} passed, ${c.failed} failed.  Replay: ${r.changed} changed, ${r.same} unchanged${r.errors ? `, ${r.errors} errors` : ""}.`);
      if (c.failed || (options.failOnChange && r.changed)) failed = true;
    }
    if (event.type === "error") failed = true;
  };
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as EvalEvent);
  }
  if (buffer.trim()) handle(JSON.parse(buffer) as EvalEvent);
  if (failed) process.exitCode = 1;
}
