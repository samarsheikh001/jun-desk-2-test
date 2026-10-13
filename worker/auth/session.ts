import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { HttpError, type AppContext, type AppEnv, type SessionUser } from "../types.ts";

const SESSION_COOKIE = "jun_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const isSecure = (c: AppContext) => new URL(c.req.url).protocol === "https:";

export async function createSession(c: AppContext, userId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now + SESSION_TTL_MS)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function getSessionUser(c: AppContext): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<SessionUser>();
  return row ?? null;
}

export async function destroySession(c: AppContext): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c) });
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getSessionUser(c);
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in first.");
  c.set("user", user);
  await next();
});
