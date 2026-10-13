import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { finishLogin, finishRegistration, startLogin, startRegistration } from "../auth/passkeys.ts";
import { createSession, destroySession, getSessionUser, requireUser } from "../auth/session.ts";
import { newId, randomToken, safeEqual } from "../lib/crypto.ts";
import { email, object, readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";

const MIN_SETUP_TOKEN_LENGTH = 16;

async function isSetupComplete(c: AppContext): Promise<boolean> {
  const row = await c.env.DB.prepare("SELECT 1 FROM settings WHERE key = 'setup_completed'").first();
  return row !== null;
}

async function checkSetupToken(c: AppContext, provided: string): Promise<void> {
  const expected = c.env.SETUP_TOKEN;
  if (!expected || expected.length < MIN_SETUP_TOKEN_LENGTH) {
    throw new HttpError(500, "setup_token_missing", `SETUP_TOKEN isn't configured (needs ${MIN_SETUP_TOKEN_LENGTH}+ characters). Set it as a Worker secret.`);
  }
  if (!(await safeEqual(provided, expected))) throw new HttpError(403, "bad_setup_token", "That setup token is wrong.");
}

export const auth = new Hono<AppEnv>();

auth.get("/setup/status", async (c) => c.json({ setupComplete: await isSetupComplete(c) }));

// First run: create the workspace and owner account, secured by SETUP_TOKEN.
auth.post("/setup/options", async (c) => {
  if (await isSetupComplete(c)) throw new HttpError(409, "setup_done", "Setup is already complete. Sign in instead.");
  const body = await readJson(c.req);
  await checkSetupToken(c, text(body, "token", { max: 500 }));
  const user = { id: newId("usr"), name: text(body, "name", { max: 100 }), email: email(body) };
  const workspace = { id: newId("ws"), name: text(body, "workspaceName", { max: 100 }) };
  return c.json(await startRegistration(c, "setup", user, { user, workspace }));
});

auth.post("/setup/verify", async (c) => {
  const body = await readJson(c.req);
  type Payload = { userId: string; user: { id: string; name: string; email: string }; workspace: { id: string; name: string } };
  const now = Date.now();
  const payload = await finishRegistration<Payload>(c, "setup", object<RegistrationResponseJSON>(body, "response"), (p) => [
    // Primary-key conflict here aborts the whole batch if two setups race.
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('setup_completed', ?)").bind(String(now)),
    c.env.DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").bind(p.workspace.id, p.workspace.name, now),
    c.env.DB.prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(p.user.id, p.user.name, p.user.email, now),
    c.env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(p.workspace.id, p.user.id, now),
    // The website widget inbox; its public key goes in the embed snippet.
    c.env.DB.prepare("INSERT INTO inboxes (id, workspace_id, name, widget_key, created_at) VALUES (?, ?, 'Website', ?, ?)").bind(
      newId("inb"),
      p.workspace.id,
      `wk_${randomToken(12)}`,
      now,
    ),
  ]);
  await createSession(c, payload.userId);
  return c.json({ ok: true });
});

// Lost every passkey? The setup token lets the owner register a new one.
auth.post("/recover/options", async (c) => {
  if (!(await isSetupComplete(c))) throw new HttpError(409, "setup_needed", "Finish setup first.");
  const body = await readJson(c.req);
  await checkSetupToken(c, text(body, "token", { max: 500 }));
  const owner = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.role = 'owner' ORDER BY m.created_at LIMIT 1`,
  ).first<{ id: string; name: string; email: string | null }>();
  if (!owner) throw new HttpError(404, "no_owner", "No owner account found.");
  return c.json(await startRegistration(c, "recover", owner, {}));
});

auth.post("/recover/verify", async (c) => {
  const body = await readJson(c.req);
  const { userId } = await finishRegistration(c, "recover", object<RegistrationResponseJSON>(body, "response"));
  await createSession(c, userId);
  return c.json({ ok: true });
});

auth.post("/auth/login/options", async (c) => c.json(await startLogin(c)));

auth.post("/auth/login/verify", async (c) => {
  const body = await readJson(c.req);
  const userId = await finishLogin(c, object<AuthenticationResponseJSON>(body, "response"));
  await createSession(c, userId);
  return c.json({ ok: true });
});

auth.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null, setupComplete: await isSetupComplete(c) });
  const memberships = await c.env.DB.prepare(
    `SELECT w.id AS workspaceId, w.name AS workspaceName, m.role FROM members m
     JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at`,
  )
    .bind(user.id)
    .all();
  return c.json({ user, memberships: memberships.results, setupComplete: true });
});

// Managing your own passkeys.
auth.get("/passkeys", requireUser, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ passkeys: rows.results });
});

auth.post("/passkeys/options", requireUser, async (c) => c.json(await startRegistration(c, "add_passkey", c.get("user"), {})));

auth.post("/passkeys/verify", requireUser, async (c) => {
  const body = await readJson(c.req);
  const { userId } = await finishRegistration(c, "add_passkey", object<RegistrationResponseJSON>(body, "response"));
  if (userId !== c.get("user").id) throw new HttpError(403, "forbidden", "That passkey was started by another account.");
  return c.json({ ok: true });
});

auth.delete("/passkeys/:id", requireUser, async (c) => {
  const userId = c.get("user").id;
  const { count } = (await c.env.DB.prepare("SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?").bind(userId).first<{ count: number }>())!;
  if (count <= 1) throw new HttpError(409, "last_passkey", "You can't remove your only passkey. Add another one first.");
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(c.req.param("id"), userId).run();
  return c.json({ ok: true });
});
