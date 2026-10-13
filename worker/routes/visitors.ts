import { Hono } from "hono";
import { requireUser } from "../auth/session.ts";
import { newId, randomToken } from "../lib/crypto.ts";
import { notifyConversationChanged } from "../lib/realtime.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// M6: identity verification settings (V-03), contacts (V-05) and agent-started chats (V-07).

const INVITE_TTL_MS = 30 * 60 * 1000;

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

export const visitors = new Hono<AppEnv>();
visitors.use("/workspaces/:id/identity", requireUser);
visitors.use("/workspaces/:id/visitors/*", requireUser);
visitors.use("/workspaces/:id/contacts/*", requireUser);
visitors.use("/workspaces/:id/inbox/logo", requireUser);
visitors.use("/workspaces/:id/inbox/logo-dark", requireUser);

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_LOGO_BYTES = 512 * 1024;

async function inboxSettings(c: AppContext, workspaceId: string): Promise<{ id: string; settings: Record<string, unknown> }> {
  const row = await c.env.DB.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>();
  if (!row) throw new HttpError(404, "not_found", "No widget inbox.");
  return { id: row.id, settings: JSON.parse(row.settings) as Record<string, unknown> };
}

// W-04: upload the widget logo (raw body, X-Jun-Upload: 1). PNG, JPEG, WebP or GIF; SVG isn't
// accepted because it can carry scripts. W-21: the same for the logo used on dark surfaces.
const LOGOS = { logo: { setting: "logoKey", prefix: "logo_" }, "logo-dark": { setting: "logoDarkKey", prefix: "logodark_" } } as const;

for (const [path, { setting, prefix }] of Object.entries(LOGOS)) {
  visitors.post(`/workspaces/:id/inbox/${path}`, async (c) => {
    const workspaceId = c.req.param("id");
    await requireAdmin(c, workspaceId);
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_TYPES.has(type)) throw new HttpError(400, "invalid_file", "Use a PNG, JPEG, WebP or GIF image.");
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_LOGO_BYTES) throw new HttpError(400, "too_large", "Logos are limited to 512 KB.");
    const inbox = await inboxSettings(c, workspaceId);
    const key = `${prefix}${randomToken(12)}`;
    await c.env.FILES.put(key, body, { httpMetadata: { contentType: type } });
    const old = inbox.settings[setting];
    inbox.settings[setting] = key;
    await c.env.DB.prepare("UPDATE inboxes SET settings = ? WHERE id = ?").bind(JSON.stringify(inbox.settings), inbox.id).run();
    if (typeof old === "string") c.executionCtx.waitUntil(c.env.FILES.delete(old));
    return c.json({ settings: inbox.settings });
  });

  visitors.delete(`/workspaces/:id/inbox/${path}`, async (c) => {
    const workspaceId = c.req.param("id");
    await requireAdmin(c, workspaceId);
    const inbox = await inboxSettings(c, workspaceId);
    const old = inbox.settings[setting];
    delete inbox.settings[setting];
    await c.env.DB.prepare("UPDATE inboxes SET settings = ? WHERE id = ?").bind(JSON.stringify(inbox.settings), inbox.id).run();
    if (typeof old === "string") c.executionCtx.waitUntil(c.env.FILES.delete(old));
    return c.json({ settings: inbox.settings });
  });
}

// The identity secret is shown to admins so they can put it in their backend. Rotating it
// revokes every identity token signed with the old one.
visitors.get("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const row = await c.env.DB.prepare("SELECT identity_secret FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ identity_secret: string | null }>();
  return c.json({ secret: row?.identity_secret ?? null });
});

visitors.post("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const secret = `jis_${randomToken(32)}`;
  await c.env.DB.prepare("UPDATE inboxes SET identity_secret = ? WHERE workspace_id = ?").bind(secret, workspaceId).run();
  return c.json({ secret });
});

visitors.delete("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.DB.prepare("UPDATE inboxes SET identity_secret = NULL WHERE workspace_id = ?").bind(workspaceId).run();
  return c.json({ secret: null });
});

// V-07: an agent's opening message to a live visitor. Shown on their page; if they reply,
// the conversation starts with it and is assigned to this agent.
visitors.post("/workspaces/:id/visitors/:sid/invite", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = text(await readJson(c.req), "body", { max: 1000 });
  const user = c.get("user");
  const id = newId("inv");
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO visitor_invites (id, workspace_id, session_id, user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, c.req.param("sid"), user.id, body, now, now + INVITE_TTL_MS)
    .run();
  const workspace = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  const delivered = await c.env.WORKSPACE_HUB.getByName(workspaceId).invite(c.req.param("sid"), { id, body, from: `${user.name} from ${workspace?.name ?? "support"}` });
  if (!delivered) throw new HttpError(410, "visitor_left", "This visitor has left the site.");
  return c.json({ id });
});

// I-08: the contact's other conversations, for the sidebar.
visitors.get("/workspaces/:id/contacts/:contactId/conversations", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    `SELECT id, status, last_message_at AS lastMessageAt, last_message_preview AS preview, created_at AS createdAt
     FROM conversations WHERE contact_id = ? AND workspace_id = ? ORDER BY last_message_at DESC LIMIT 50`,
  )
    .bind(c.req.param("contactId"), workspaceId)
    .all();
  return c.json({ conversations: rows.results });
});

// I-08: agents can name anonymous visitors ("this is Sam from Acme"). Verified contacts come
// from the customer's own app, so their name and email can't be changed here.
visitors.patch("/workspaces/:id/contacts/:contactId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const contact = await c.env.DB.prepare("SELECT id, verified_at FROM contacts WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("contactId"), workspaceId)
    .first<{ id: string; verified_at: number | null }>();
  if (!contact) throw new HttpError(404, "not_found", "Contact not found.");
  if (contact.verified_at !== null) throw new HttpError(409, "verified", "This customer's details come from your app (identity verification), so they can't be edited here.");
  const body = await readJson(c.req);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) || null : undefined;
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 320) || null : undefined;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_field", "That doesn't look like an email address.");
  await c.env.DB.prepare("UPDATE contacts SET name = CASE WHEN ?1 THEN ?2 ELSE name END, email = CASE WHEN ?3 THEN ?4 ELSE email END WHERE id = ?5")
    .bind(name !== undefined ? 1 : 0, name ?? null, email !== undefined ? 1 : 0, email ?? null, contact.id)
    .run();
  // Inbox lists show the contact's name: refresh this contact's conversations everywhere.
  const convs = await c.env.DB.prepare("SELECT id FROM conversations WHERE contact_id = ? LIMIT 50").bind(contact.id).all<{ id: string }>();
  c.executionCtx.waitUntil(Promise.all(convs.results.map((r) => notifyConversationChanged(c.env, { conversationId: r.id, workspaceId }))));
  return c.json({ ok: true });
});

// V-05: who a contact is, as the host app told us (agents only).
visitors.get("/workspaces/:id/contacts/:contactId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const row = await c.env.DB.prepare(
    "SELECT id, name, email, external_id, verified_at, attributes, created_at, last_seen_at FROM contacts WHERE id = ? AND workspace_id = ?",
  )
    .bind(c.req.param("contactId"), workspaceId)
    .first<{ id: string; name: string | null; email: string | null; external_id: string | null; verified_at: number | null; attributes: string; created_at: number; last_seen_at: number }>();
  if (!row) throw new HttpError(404, "not_found", "Contact not found.");
  return c.json({
    contact: {
      id: row.id,
      name: row.name,
      email: row.email,
      externalId: row.external_id,
      verified: row.verified_at !== null,
      verifiedAt: row.verified_at,
      attributes: JSON.parse(row.attributes) as Record<string, string | number | boolean>,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    },
  });
});
