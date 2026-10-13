import { Hono } from "hono";
import { redact } from "../../shared/debug.ts";
import {
  buildDraft,
  deskFileUrl,
  fallbackNarrative,
  imagesSection,
  isImageType,
  issueFactsText,
  issuePrompt,
  parseImageKeys,
  parseIssueInput,
  parseNarrative,
  parseRepo,
  pickIssueImages,
  withImagesSection,
  type IssueFacts,
  type IssueImage,
  type IssueNarrative,
} from "../../shared/issues.ts";
import type { Attachment, ConversationIssue } from "../../shared/protocol.ts";
import { completeText, createModel, loadAiSettings } from "../ai/providers.ts";
import { requireUser } from "../auth/session.ts";
import type { ConversationRef } from "../conversation.ts";
import { loadDebugContext, loadIssues, loadMessages } from "../lib/conversations.ts";
import { newId } from "../lib/crypto.ts";
import { checkRepo, createIssue, GITHUB_API_DEFAULT, GitHubError, type GitHubClient } from "../lib/github.ts";
import { checkLinear, createLinearIssue, LINEAR_API_DEFAULT, uploadLinearFile, LinearError, type LinearClient, type LinearTeam } from "../lib/linear.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";
import { requireConversation } from "./conversations.ts";

// S-08: issues from a conversation, in GitHub or Linear. An agent clicks "Create issue", the AI
// drafts it (provider-agnostic Markdown), the agent edits and files it. The AI never files issues
// on its own.

/** Model draft budget: past this the agent gets the template instead of waiting. */
const DRAFT_TIMEOUT_MS = 15_000;
/** A reserved client_id whose tracker call never finished (Worker died) can be retried after this. */
const STALE_PENDING_MS = 2 * 60 * 1000;

/**
 * Tracker credentials: a Worker secret (GITHUB_TOKEN, LINEAR_API_KEY) wins; otherwise the one an
 * admin pasted in Settings, kept in the workspace hub's storage (never D1). Never returned.
 */
async function trackerCreds(env: Env, workspaceId: string) {
  const vars = env as unknown as { GITHUB_TOKEN?: string; GITHUB_API_URL?: string; LINEAR_API_KEY?: string; LINEAR_API_URL?: string };
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  const envToken = vars.GITHUB_TOKEN?.trim() || null;
  const envKey = vars.LINEAR_API_KEY?.trim() || null;
  const [savedToken, savedKey] = await Promise.all([envToken ? null : hub.trackerSecret("github"), envKey ? null : hub.trackerSecret("linear")]);
  const source = (fromEnv: string | null, saved: string | null) => (fromEnv ? ("worker" as const) : saved ? ("settings" as const) : null);
  return {
    github: { token: envToken ?? savedToken, source: source(envToken, savedToken), apiUrl: vars.GITHUB_API_URL?.trim() || GITHUB_API_DEFAULT },
    linear: { apiKey: envKey ?? savedKey, source: source(envKey, savedKey), apiUrl: vars.LINEAR_API_URL?.trim() || LINEAR_API_DEFAULT },
  };
}

/** The last 4 characters, for "•••• a1b2" in Settings. */
const hint = (secret: string | null) => (secret && secret.length >= 12 ? secret.slice(-4) : null);

/** A pasted token or key: one line, no spaces, sane length. Null clears it. */
function parseSecret(raw: unknown, label: string): string | null {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new HttpError(400, "invalid_field", `${label} must be text.`);
  const value = raw.trim();
  if (value.length < 8 || value.length > 500 || /\s/.test(value)) throw new HttpError(400, "invalid_field", `That doesn't look like a ${label}. Paste it exactly as shown when you created it.`);
  return value;
}

const platformFetch: typeof fetch = (input, init) => fetch(input, init);
const githubClient = (token: string, apiUrl: string): GitHubClient => ({ token, apiUrl, fetch: platformFetch });
const linearClient = (apiKey: string, apiUrl: string): LinearClient => ({ apiKey, apiUrl, fetch: platformFetch });

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

interface TrackerSettings {
  repo: string | null;
  team: LinearTeam | null;
}

async function loadTrackerSettings(db: D1Database, workspaceId: string): Promise<TrackerSettings> {
  const row = await db
    .prepare("SELECT github_repo, linear_team_id, linear_team_key, linear_team_name FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<{ github_repo: string | null; linear_team_id: string | null; linear_team_key: string | null; linear_team_name: string | null }>();
  return {
    repo: row?.github_repo ?? null,
    team: row?.linear_team_id && row.linear_team_key ? { id: row.linear_team_id, key: row.linear_team_key, name: row.linear_team_name ?? row.linear_team_key } : null,
  };
}

/** What the dashboard may know: never a credential, only whether it's set. */
async function trackerStatus(c: AppContext, workspaceId: string) {
  const { repo, team } = await loadTrackerSettings(c.env.DB, workspaceId);
  const env = await trackerCreds(c.env, workspaceId);
  return {
    github: { repo, tokenSet: env.github.token !== null, tokenSource: env.github.source, tokenHint: env.github.source === "settings" ? hint(env.github.token) : null, configured: repo !== null && env.github.token !== null, ...(env.github.apiUrl !== GITHUB_API_DEFAULT ? { apiUrl: env.github.apiUrl } : {}) },
    linear: { team, keySet: env.linear.apiKey !== null, keySource: env.linear.source, keyHint: env.linear.source === "settings" ? hint(env.linear.apiKey) : null, configured: team !== null && env.linear.apiKey !== null, ...(env.linear.apiUrl !== LINEAR_API_DEFAULT ? { apiUrl: env.linear.apiUrl } : {}) },
  };
}

export const issues = new Hono<AppEnv>();
for (const path of ["/workspaces/:id/trackers", "/workspaces/:id/github", "/workspaces/:id/github/*", "/workspaces/:id/linear", "/workspaces/:id/linear/*", "/conversations/:cid/issue-draft", "/conversations/:cid/issue-images", "/conversations/:cid/issues"]) {
  issues.use(path, requireUser);
}

// ---------- settings ----------

issues.get("/workspaces/:id/trackers", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  return c.json(await trackerStatus(c, workspaceId));
});

issues.put("/workspaces/:id/github", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  let repo: string | null = null;
  if (body.repo !== null && body.repo !== "") {
    repo = parseRepo(body.repo);
    if (!repo) throw new HttpError(400, "invalid_field", "Enter the repository as owner/name, e.g. acme/web-app.");
  }
  await c.env.DB.prepare("UPDATE workspaces SET github_repo = ? WHERE id = ?").bind(repo, workspaceId).run();
  return c.json(await trackerStatus(c, workspaceId));
});

/** Paste (or, with null, remove) a credential in Settings. A Worker secret, if set, still wins. */
for (const [name, path, field, label] of [
  ["github", "/workspaces/:id/github/token", "token", "GitHub token"],
  ["linear", "/workspaces/:id/linear/key", "apiKey", "Linear API key"],
] as const) {
  issues.put(path, async (c) => {
    const workspaceId = c.req.param("id");
    await requireAdmin(c, workspaceId);
    const value = parseSecret((await readJson(c.req))[field], label);
    await c.env.WORKSPACE_HUB.getByName(workspaceId).setTrackerSecret(name, value);
    return c.json(await trackerStatus(c, workspaceId));
  });
}

/** GitHub "Test connection": GET /repos/:owner/:repo with the token. */
issues.post("/workspaces/:id/github/test", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const { repo } = await loadTrackerSettings(c.env.DB, workspaceId);
  const { token, apiUrl } = (await trackerCreds(c.env, workspaceId)).github;
  if (!token) return c.json({ ok: false, reason: "no_token", message: "Add a GitHub token first." });
  if (!repo) return c.json({ ok: false, reason: "no_repo", message: "Save a repository first." });
  const result = await checkRepo(githubClient(token, apiUrl), repo);
  if (!result.ok) return c.json(result);
  if (!result.hasIssues) return c.json({ ok: false, reason: "issues_disabled", message: `Connected, but issues are turned off for ${result.fullName}. Turn them on in the repository's settings.` });
  return c.json({ ok: true, reason: "ok", message: `Connected to ${result.fullName}${result.private ? " (private)" : ""}. Make sure the token has Issues: Read and write; GitHub only checks that when an issue is created.` });
});

issues.put("/workspaces/:id/linear", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const body = await readJson(c.req);
  let team: LinearTeam | null = null;
  if (body.team !== null && body.team !== undefined) {
    const t = (typeof body.team === "object" ? body.team : {}) as Record<string, unknown>;
    const ok = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
    if (!ok(t.id, 100) || !ok(t.name, 200) || typeof t.key !== "string" || !/^[A-Za-z0-9_]{1,10}$/.test(t.key.trim())) {
      throw new HttpError(400, "invalid_field", "Pick a Linear team (run Test connection to load them).");
    }
    team = { id: (t.id as string).trim(), key: t.key.trim().toUpperCase(), name: (t.name as string).trim() };
  }
  await c.env.DB.prepare("UPDATE workspaces SET linear_team_id = ?, linear_team_key = ?, linear_team_name = ? WHERE id = ?")
    .bind(team?.id ?? null, team?.key ?? null, team?.name ?? null, workspaceId)
    .run();
  return c.json(await trackerStatus(c, workspaceId));
});

/** Linear "Test connection": who the key belongs to, plus the teams for the picker. */
issues.post("/workspaces/:id/linear/test", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const { apiKey, apiUrl } = (await trackerCreds(c.env, workspaceId)).linear;
  if (!apiKey) return c.json({ ok: false, reason: "no_key", message: "Add a Linear API key first.", teams: [] });
  const result = await checkLinear(linearClient(apiKey, apiUrl));
  if (!result.ok) return c.json({ ...result, teams: [] });
  return c.json({ ok: true, reason: "ok", message: `Connected as ${result.viewer}. ${result.teams.length} team${result.teams.length === 1 ? "" : "s"} available.`, teams: result.teams });
});

// ---------- draft ----------

/** Everything the draft is built from, masked. Never the contact's email. */
async function issueFacts(c: AppContext, ref: ConversationRef): Promise<IssueFacts> {
  const [messages, debug, contact] = await Promise.all([
    loadMessages(c.env.DB, ref.conversationId, { includeInternal: true, limit: 80 }),
    loadDebugContext(c.env.DB, ref.conversationId),
    c.env.DB.prepare(
      `SELECT ct.attributes FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.id = ? AND ct.external_id IS NOT NULL AND ct.verified_at IS NOT NULL`,
    )
      .bind(ref.conversationId)
      .first<{ attributes: string }>(),
  ]);
  const transcript: IssueFacts["transcript"] = [];
  for (const m of messages) {
    if (!m.body.trim()) continue;
    // Internal notes go to the model too: the draft is for the team's own engineers and an
    // agent reviews it before filing. (They still never reach the visitor or the support AI.)
    const who =
      m.authorType === "visitor" ? "Customer"
      : m.authorType === "ai" ? "AI"
      : m.authorType === "agent" ? (m.internal ? "Team note" : "Agent")
      : m.internal && m.meta.handoffReason ? "Team note" // the AI's handoff brief
      : null;
    if (who) transcript.push({ who, body: redact(m.body, 2000) });
  }
  // Verified contacts only, and only the account (company, plan): no name or email in an issue.
  let account: IssueFacts["account"] = null;
  if (contact) {
    const attributes = JSON.parse(contact.attributes) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      const key = Object.keys(attributes).find((k) => keys.includes(k.toLowerCase().replace(/[^a-z]/g, "")));
      const value = key === undefined ? undefined : attributes[key];
      return typeof value === "string" || typeof value === "number" ? redact(String(value), 80) : null;
    };
    account = { company: pick("company", "companyname", "organization", "organisation", "org", "account", "accountname"), plan: pick("plan", "planname", "tier") };
  }
  return {
    conversationUrl: `${new URL(c.req.url).origin}/inbox/${ref.conversationId}`,
    transcript,
    environment: debug.context,
    events: [...debug.events].reverse(),
    account,
  };
}

issues.post("/conversations/:cid/issue-draft", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const month = new Date().toISOString().slice(0, 7);
  const [facts, settings, usage] = await Promise.all([
    issueFacts(c, ref),
    loadAiSettings(c.env, ref.workspaceId),
    c.env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(ref.workspaceId, month).first<{ replies: number }>(),
  ]);

  let narrative: IssueNarrative | null = null;
  let notice: string | null = null;
  if (!settings.enabled) notice = "AI is off, so this is a template from the conversation and browser details.";
  else if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) notice = "The monthly AI cap is reached, so this is a template.";
  else {
    try {
      const model = createModel(c.env, ref.workspaceId, settings, "draft");
      const result = await completeText({
        model: model.model,
        ...model.prompt(issuePrompt()),
        messages: [{ role: "user", content: issueFactsText(facts) }],
        maxOutputTokens: 2000,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      });
      narrative = parseNarrative(result.text);
      if (!narrative) notice = "The AI's draft wasn't usable, so this is a template.";
      // Tokens count toward usage; a draft isn't a reply, so it doesn't use up the reply cap.
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 0, ?3, ?4)
           ON CONFLICT (workspace_id, month) DO UPDATE SET input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
        )
          .bind(ref.workspaceId, month, result.totalUsage.inputTokens ?? 0, result.totalUsage.outputTokens ?? 0)
          .run(),
      );
    } catch (error) {
      console.warn("issue draft failed, using the template:", (error as Error).message);
      notice = "The AI couldn't write a draft just now (it failed or took too long), so this is a template.";
    }
  }
  const draft = buildDraft(narrative ?? fallbackNarrative(facts), facts);
  return c.json({ ...draft, source: narrative ? "ai" : "template", notice });
});

// ---------- S-14: screenshots ----------

/**
 * The conversation's attachments (images and other files: pickIssueImages rejects the
 * others by type), oldest first, with the stored file metadata. Both the
 * visitor's and the agents', on public messages and internal notes: the issue goes to the
 * team's own engineers and an agent picks each one before filing (never shown to visitors).
 */
async function conversationFiles(db: D1Database, ref: ConversationRef): Promise<IssueImage[]> {
  const rows = await db
    .prepare("SELECT author_type, internal, attachments, created_at FROM messages WHERE conversation_id = ? AND attachments != '[]' ORDER BY seq")
    .bind(ref.conversationId)
    .all<{ author_type: string; internal: number; attachments: string; created_at: number }>();
  const attached = rows.results.flatMap((r) =>
    (JSON.parse(r.attachments) as Attachment[]).map((a) => ({ key: String(a.key), from: r.author_type === "visitor" ? ("visitor" as const) : ("agent" as const), internal: r.internal === 1, createdAt: r.created_at })),
  );
  if (!attached.length) return [];
  // Type and size from the files table (same workspace), not from the message JSON.
  const keys = [...new Set(attached.map((a) => a.key))];
  const files = new Map<string, Attachment>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const found = await db
      .prepare(`SELECT key, name, type, size FROM files WHERE workspace_id = ? AND key IN (${chunk.map(() => "?").join(",")})`)
      .bind(ref.workspaceId, ...chunk)
      .all<Attachment>();
    for (const f of found.results) files.set(f.key, f);
  }
  const seen = new Set<string>();
  const out: IssueImage[] = [];
  for (const a of attached) {
    const file = files.get(a.key);
    if (!file || seen.has(a.key)) continue;
    seen.add(a.key);
    out.push({ key: file.key, name: file.name, type: file.type, size: file.size, from: a.from, internal: a.internal, createdAt: a.createdAt });
  }
  return out;
}

/**
 * The dialog's image list, plus whether the GitHub repo is private (GitHub has no upload API,
 * so images are links to the desk's file URLs: ticked by default only for a private repo).
 * `githubPrivate` is null when GitHub isn't set up or the check failed.
 */
issues.get("/conversations/:cid/issue-images", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const [files, settings, creds] = await Promise.all([conversationFiles(c.env.DB, ref), loadTrackerSettings(c.env.DB, ref.workspaceId), trackerCreds(c.env, ref.workspaceId)]);
  const images = files.filter((f) => isImageType(f.type));
  let githubPrivate: boolean | null = null;
  if (images.length && settings.repo && creds.github.token) {
    const check = await checkRepo(githubClient(creds.github.token, creds.github.apiUrl), settings.repo);
    githubPrivate = check.ok ? check.private : null;
  }
  return c.json({ images, githubPrivate });
});

// ---------- file ----------

issues.get("/conversations/:cid/issues", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  return c.json({ issues: await loadIssues(c.env.DB, ref.conversationId) });
});

interface Filed {
  externalId: string;
  key: string;
  url: string;
}

issues.post("/conversations/:cid/issues", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const body = await readJson(c.req);
  const provider = body.provider;
  if (provider !== "github" && provider !== "linear") throw new HttpError(400, "invalid_field", "provider must be github or linear.");
  let input: ReturnType<typeof parseIssueInput>;
  try {
    input = parseIssueInput(body);
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  if (body.clientId !== undefined && (typeof body.clientId !== "string" || !body.clientId || body.clientId.length > 100)) {
    throw new HttpError(400, "invalid_field", "clientId must be a short string.");
  }
  const clientId = (body.clientId as string | undefined) ?? crypto.randomUUID();
  // S-14: only images attached to this conversation's messages (checked before anything else).
  let images: IssueImage[] = [];
  try {
    const keys = parseImageKeys(body.images);
    if (keys.length) images = pickIssueImages(keys, await conversationFiles(c.env.DB, ref));
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  let imagesFailed = 0;

  // Where it goes, and how to file it there.
  const settings = await loadTrackerSettings(c.env.DB, ref.workspaceId);
  const env = await trackerCreds(c.env, ref.workspaceId);
  let target: string;
  let file: () => Promise<Filed>;
  if (provider === "github") {
    const { repo } = settings;
    const { token, apiUrl } = env.github;
    if (!repo || !token) {
      throw new HttpError(409, "github_not_configured", !repo ? "No GitHub repository is set. An admin can add one in Settings → Issue trackers." : "No GitHub token is set. An admin can add one in Settings → Issue trackers.");
    }
    target = repo;
    file = async () => {
      // No upload API: links to the desk's own (unguessable) file URLs. The dialog warns on public repos.
      const origin = new URL(c.req.url).origin;
      const section = imagesSection(images.map((i) => ({ name: i.name, url: deskFileUrl(origin, i.key) })));
      const created = await createIssue(githubClient(token, apiUrl), repo, { ...input, body: withImagesSection(input.body, section) });
      return { externalId: String(created.number), key: `${repo}#${created.number}`, url: created.url };
    };
  } else {
    const { team } = settings;
    const { apiKey, apiUrl } = env.linear;
    if (!team || !apiKey) {
      throw new HttpError(409, "linear_not_configured", !team ? "No Linear team is set. An admin can pick one in Settings → Issue trackers." : "No Linear API key is set. An admin can add one in Settings → Issue trackers.");
    }
    target = team.key;
    file = async () => {
      // Same Markdown body (Linear renders it). Labels are GitHub-only for now.
      // Screenshots are uploaded to Linear's storage first; one that fails is left out, not fatal.
      const client = linearClient(apiKey, apiUrl);
      const uploaded: { name: string; url: string }[] = [];
      for (const image of images) {
        try {
          const object = await c.env.FILES.get(image.key);
          if (!object) throw new Error("not in R2");
          uploaded.push({ name: image.name, url: await uploadLinearFile(client, { name: image.name, type: image.type, bytes: await object.arrayBuffer() }) });
        } catch (error) {
          console.warn("linear image upload failed:", (error as Error).message);
          imagesFailed++;
        }
      }
      const description = withImagesSection(input.body, imagesSection(uploaded));
      const created = await createLinearIssue(client, { teamId: team.id, title: input.title, description });
      return { externalId: created.id, key: created.identifier, url: created.url };
    };
  }

  // Idempotency: one issue per clientId. Reserve it before calling the tracker so a retry (or
  // a double click) never files twice.
  type Row = { id: string; url: string | null; created_at: number };
  const existing = await c.env.DB.prepare("SELECT id, url, created_at FROM conversation_issues WHERE conversation_id = ? AND client_id = ?")
    .bind(ref.conversationId, clientId)
    .first<Row>();
  if (existing?.url) return c.json({ issue: (await loadIssues(c.env.DB, ref.conversationId)).find((i) => i.id === existing.id) });
  if (existing && Date.now() - existing.created_at < STALE_PENDING_MS) throw new HttpError(409, "issue_in_progress", "This issue is being created already.");
  if (existing) await c.env.DB.prepare("DELETE FROM conversation_issues WHERE id = ? AND url IS NULL").bind(existing.id).run();

  const id = newId("iss");
  const now = Date.now();
  const reserved = await c.env.DB.prepare(
    `INSERT INTO conversation_issues (id, conversation_id, workspace_id, provider, target, title, client_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id, client_id) DO NOTHING`,
  )
    .bind(id, ref.conversationId, ref.workspaceId, provider, target, input.title, clientId, c.get("user").id, now)
    .run();
  if (reserved.meta.changes === 0) throw new HttpError(409, "issue_in_progress", "This issue is being created already.");

  let filed: Filed;
  try {
    filed = await file();
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM conversation_issues WHERE id = ?").bind(id).run();
    if (error instanceof GitHubError) throw new HttpError(502, "github_error", error.message);
    if (error instanceof LinearError) throw new HttpError(502, "linear_error", error.message);
    throw error;
  }
  await c.env.DB.prepare("UPDATE conversation_issues SET external_id = ?, key = ?, url = ? WHERE id = ?").bind(filed.externalId, filed.key, filed.url, id).run();
  const issue: ConversationIssue = { id, provider, target, ...filed, title: input.title, createdBy: c.get("user").id, createdAt: now };
  // An internal note in the timeline (live for agents, never for the visitor or the AI).
  await c.env.CONVERSATION.getByName(ref.conversationId).addNote(ref, `Issue created: ${filed.key} — ${input.title}`, `issue:${id}`, { issue });
  return c.json({
    issue,
    imagesAttached: images.length - imagesFailed,
    imagesFailed,
    ...(imagesFailed ? { notice: imagesFailed === 1 ? "1 image couldn't be attached." : `${imagesFailed} images couldn't be attached.` } : {}),
  });
});
