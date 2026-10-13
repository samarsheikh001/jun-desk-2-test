import { Hono } from "hono";
import { requireUser } from "../auth/session.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";

// T-11: the "Get started" checklist after setup. Each step is worked out from what's actually
// set up, so it ticks itself off however the admin did it (wizard, Settings, CLI).

export type OnboardingStep = "account" | "knowledge" | "ai" | "brand" | "install" | "team";

const dismissedKey = (workspaceId: string) => `onboarding_dismissed:${workspaceId}`;

async function requireMember(c: AppContext, workspaceId: string): Promise<void> {
  const row = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
}

export const onboarding = new Hono<AppEnv>();
onboarding.use("/workspaces/:id/onboarding", requireUser);
onboarding.use("/workspaces/:id/onboarding/*", requireUser);

onboarding.get("/workspaces/:id/onboarding", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const db = c.env.DB;
  const [knowledge, ai, inbox, team, dismissed] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM kb_sources WHERE workspace_id = ? AND status = 'ready'").bind(workspaceId).first<{ n: number }>(),
    db.prepare("SELECT enabled FROM ai_settings WHERE workspace_id = ?").bind(workspaceId).first<{ enabled: number }>(),
    db.prepare("SELECT widget_key, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ widget_key: string; settings: string }>(),
    db.prepare(
      "SELECT (SELECT COUNT(*) FROM members WHERE workspace_id = ?1) AS members, (SELECT COUNT(*) FROM invites WHERE workspace_id = ?1) AS invites",
    ).bind(workspaceId).first<{ members: number; invites: number }>(),
    db.prepare("SELECT value FROM settings WHERE key = ?").bind(dismissedKey(workspaceId)).first<{ value: string }>(),
  ]);
  const settings = inbox ? (JSON.parse(inbox.settings) as Record<string, unknown>) : {};
  const done: Record<OnboardingStep, boolean> = {
    account: true,
    knowledge: (knowledge?.n ?? 0) > 0,
    ai: ai?.enabled === 1,
    brand: typeof settings.color === "string" || typeof settings.logoKey === "string" || typeof settings.logoDarkKey === "string" || typeof settings.greeting === "string",
    // Set the first time the loader connects from a site other than the desk itself.
    install: typeof settings.installedAt === "number",
    team: (team?.members ?? 0) > 1 || (team?.invites ?? 0) > 0,
  };
  return c.json({ steps: done, widgetKey: inbox?.widget_key ?? null, installedOn: settings.installedOn ?? null, dismissed: Boolean(dismissed) });
});

onboarding.post("/workspaces/:id/onboarding/dismiss", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = '1'").bind(dismissedKey(workspaceId)).run();
  return c.json({ dismissed: true });
});
