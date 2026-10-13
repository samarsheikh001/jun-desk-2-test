import { Hono } from "hono";
import { parseNotificationPrefs, readNotificationPrefs } from "../../shared/notifications.ts";
import { requireUser } from "../auth/session.ts";
import { base64UrlDecode, newId, sha256 } from "../lib/crypto.ts";
import { readJson } from "../lib/validate.ts";
import { isP256Point } from "../lib/webpush.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { requireMember } from "./conversations.ts";

/** A teammate's browsers and phones; more than this is almost certainly stale. */
const MAX_DEVICES = 20;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Push services are https. Plain http is accepted only for a loopback endpoint while the desk
 * itself runs on localhost (the e2e tests' mock push service).
 */
function checkEndpoint(c: AppContext, value: unknown): string {
  if (typeof value !== "string" || value.length > 1000) throw new HttpError(400, "invalid_field", "endpoint must be a push service URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_field", "endpoint must be a push service URL.");
  }
  const devDesk = LOOPBACK.has(new URL(c.req.url).hostname);
  if (url.protocol === "https:" || (devDesk && url.protocol === "http:" && LOOPBACK.has(url.hostname))) return url.href;
  throw new HttpError(400, "invalid_field", "endpoint must be an https URL.");
}

function checkKey(value: unknown, field: string, valid: (bytes: Uint8Array) => boolean): string {
  if (typeof value === "string" && value.length < 200 && /^[\w-]+=*$/.test(value)) {
    try {
      const bytes = base64UrlDecode(value.replace(/=+$/, ""));
      if (valid(bytes)) return value.replace(/=+$/, "");
    } catch {
      // fall through
    }
  }
  throw new HttpError(400, "invalid_field", `keys.${field} isn't a valid push subscription key.`);
}

interface DeviceRow { id: string; endpoint: string; user_agent: string | null; created_at: number; last_success_at: number | null; failures: number }

/** What the dashboard sees of a device: never the encryption keys, and the endpoint only as a hash (to spot "this device"). */
async function device(row: DeviceRow) {
  return {
    id: row.id,
    service: new URL(row.endpoint).host,
    endpointHash: await sha256(row.endpoint),
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    failures: row.failures,
  };
}

/** I-14: per-user notification settings and Web Push devices. Everything here is about the signed-in user only. */
export const notifications = new Hono<AppEnv>();
notifications.use("/workspaces/:id/push/*", requireUser);
notifications.use("/workspaces/:id/notifications", requireUser);

notifications.get("/workspaces/:id/notifications", async (c) => {
  const workspaceId = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT notification_prefs FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ notification_prefs: string }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return c.json({ prefs: readNotificationPrefs(row.notification_prefs) });
});

notifications.put("/workspaces/:id/notifications", async (c) => {
  const workspaceId = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT notification_prefs FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ notification_prefs: string }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  let prefs;
  try {
    prefs = parseNotificationPrefs(await readJson(c.req), readNotificationPrefs(row.notification_prefs));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  await c.env.DB.prepare("UPDATE members SET notification_prefs = ? WHERE workspace_id = ? AND user_id = ?").bind(JSON.stringify(prefs), workspaceId, c.get("user").id).run();
  return c.json({ prefs });
});

// The VAPID public key browsers subscribe with (the private key stays in the workspace hub).
notifications.get("/workspaces/:id/push/key", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const publicKey = await c.env.WORKSPACE_HUB.getByName(workspaceId).vapidPublicKey(new URL(c.req.url).origin);
  return c.json({ publicKey });
});

notifications.get("/workspaces/:id/push/subscriptions", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const rows = await c.env.DB.prepare(
    "SELECT id, endpoint, user_agent, created_at, last_success_at, failures FROM push_subscriptions WHERE workspace_id = ? AND user_id = ? ORDER BY created_at",
  )
    .bind(workspaceId, c.get("user").id)
    .all<DeviceRow>();
  return c.json({ devices: await Promise.all(rows.results.map(device)) });
});

// Registers this browser (a PushSubscription's JSON). The same endpoint again updates it, and
// moves it to whoever is signed in now (one browser profile, one person getting its pushes).
notifications.post("/workspaces/:id/push/subscriptions", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const body = await readJson(c.req);
  const endpoint = checkEndpoint(c, body.endpoint);
  const keys = (body.keys && typeof body.keys === "object" ? body.keys : {}) as Record<string, unknown>;
  const p256dh = checkKey(keys.p256dh, "p256dh", isP256Point);
  const auth = checkKey(keys.auth, "auth", (b) => b.length === 16);
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 300) || null;
  const userId = c.get("user").id;

  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE workspace_id = ? AND user_id = ? AND endpoint != ?")
    .bind(workspaceId, userId, endpoint)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_DEVICES) throw new HttpError(400, "too_many_devices", `You have ${MAX_DEVICES} devices with notifications on. Remove some first.`);

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, workspace_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, workspace_id = excluded.workspace_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failures = 0`,
  )
    .bind(newId("psub"), userId, workspaceId, endpoint, p256dh, auth, userAgent, Date.now())
    .run();
  const row = await c.env.DB.prepare("SELECT id, endpoint, user_agent, created_at, last_success_at, failures FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first<DeviceRow>();
  return c.json({ device: await device(row!) });
});

notifications.delete("/workspaces/:id/push/subscriptions/:sid", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const result = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ? AND workspace_id = ? AND user_id = ?")
    .bind(c.req.param("sid"), workspaceId, c.get("user").id)
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, "not_found", "No such device.");
  return c.json({ ok: true });
});

// "Send a test notification" to one of your own devices.
notifications.post("/workspaces/:id/push/test", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const body = await readJson(c.req);
  if (typeof body.subscriptionId !== "string") throw new HttpError(400, "invalid_field", "subscriptionId is required.");
  const result = await c.env.WORKSPACE_HUB.getByName(workspaceId).testPush(workspaceId, c.get("user").id, body.subscriptionId);
  if (!result) throw new HttpError(404, "not_found", "No such device.");
  if (result.outcome === "gone") throw new HttpError(410, "subscription_gone", "This device's subscription has expired. Turn notifications on again.");
  if (result.outcome !== "ok") throw new HttpError(502, "push_failed", `The push service didn't accept it (${result.status || "no response"}). Try again in a minute.`);
  return c.json({ ok: true });
});
