import { newId, randomToken, sha256 } from "./crypto.ts";
import type { VerifiedIdentity } from "./identity.ts";

// Contacts and the browsers that act for them. A browser holds a random visitor token
// (stored here only as a hash); one contact can have many (an identified user on two devices).

export interface VisitorContact {
  contactId: string;
  externalId: string | null;
}

export async function findVisitor(db: D1Database, workspaceId: string, token: string): Promise<VisitorContact | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.external_id FROM visitor_tokens t JOIN contacts c ON c.id = t.contact_id
       WHERE t.token_hash = ? AND c.workspace_id = ?`,
    )
    .bind(await sha256(token), workspaceId)
    .first<{ id: string; external_id: string | null }>();
  return row ? { contactId: row.id, externalId: row.external_id } : null;
}

export async function issueToken(db: D1Database, contactId: string): Promise<string> {
  const token = randomToken();
  await db.prepare("INSERT INTO visitor_tokens (token_hash, contact_id, created_at) VALUES (?, ?, ?)").bind(await sha256(token), contactId, Date.now()).run();
  return token;
}

/** A new anonymous contact and its first browser token. */
export async function createVisitor(db: D1Database, workspaceId: string): Promise<{ token: string; contactId: string }> {
  const contactId = newId("ct");
  const now = Date.now();
  await db.prepare("INSERT INTO contacts (id, workspace_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(contactId, workspaceId, now, now).run();
  return { token: await issueToken(db, contactId), contactId };
}

function profileUpdate(db: D1Database, contactId: string, identity: VerifiedIdentity) {
  const now = Date.now();
  // Verified attributes replace the previous ones: the host app is the source of truth.
  return db
    .prepare("UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), attributes = ?, verified_at = ?, last_seen_at = ? WHERE id = ?")
    .bind(identity.name, identity.email, JSON.stringify(identity.attributes), now, now, contactId);
}

/** The contact for a verified user, created if new. */
export async function upsertIdentified(db: D1Database, workspaceId: string, identity: VerifiedIdentity): Promise<string> {
  const existing = await db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND external_id = ?").bind(workspaceId, identity.id).first<{ id: string }>();
  if (existing) {
    await profileUpdate(db, existing.id, identity).run();
    return existing.id;
  }
  const contactId = newId("ct");
  const now = Date.now();
  try {
    await db
      .prepare("INSERT INTO contacts (id, workspace_id, external_id, name, email, attributes, verified_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(contactId, workspaceId, identity.id, identity.name, identity.email, JSON.stringify(identity.attributes), now, now, now)
      .run();
    return contactId;
  } catch (error) {
    // Two tabs identifying at once: the other insert won.
    const winner = await db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND external_id = ?").bind(workspaceId, identity.id).first<{ id: string }>();
    if (winner) return winner.id;
    throw error;
  }
}

export interface IdentifyResult {
  contactId: string;
  /** The browser's token for that contact: the same one, or a new one when the browser changed user. */
  token: string;
  /** Conversations moved from the anonymous visitor (V-04). */
  movedConversations: string[];
}

/**
 * V-04: a browser says (with a verified JWT) that its user is `identity`.
 * - Anonymous visitor: its conversations and tokens merge into the user's contact
 *   (or it simply becomes that contact if the user is new).
 * - Already this user: profile refresh.
 * - Another identified user (shared computer), or no token: a fresh token for this user.
 *   Identified contacts never merge, so one user can't inherit another's history.
 */
export async function identify(db: D1Database, workspaceId: string, identity: VerifiedIdentity, currentToken: string | null): Promise<IdentifyResult> {
  const current = currentToken ? await findVisitor(db, workspaceId, currentToken) : null;

  if (current?.externalId === identity.id) {
    await profileUpdate(db, current.contactId, identity).run();
    return { contactId: current.contactId, token: currentToken!, movedConversations: [] };
  }

  if (current && current.externalId === null) {
    const existing = await db.prepare("SELECT id FROM contacts WHERE workspace_id = ? AND external_id = ?").bind(workspaceId, identity.id).first<{ id: string }>();
    if (!existing) {
      // First time we see this user: the anonymous contact becomes them.
      await db.batch([
        db.prepare("UPDATE contacts SET external_id = ? WHERE id = ?").bind(identity.id, current.contactId),
        profileUpdate(db, current.contactId, identity),
      ]);
      return { contactId: current.contactId, token: currentToken!, movedConversations: [] };
    }
    const moved = await db.prepare("SELECT id FROM conversations WHERE contact_id = ?").bind(current.contactId).all<{ id: string }>();
    await db.batch([
      db.prepare("UPDATE conversations SET contact_id = ? WHERE contact_id = ?").bind(existing.id, current.contactId),
      db.prepare("UPDATE visitor_tokens SET contact_id = ? WHERE contact_id = ?").bind(existing.id, current.contactId),
      db.prepare("DELETE FROM contacts WHERE id = ?").bind(current.contactId),
      profileUpdate(db, existing.id, identity),
    ]);
    return { contactId: existing.id, token: currentToken!, movedConversations: moved.results.map((r) => r.id) };
  }

  const contactId = await upsertIdentified(db, workspaceId, identity);
  return { contactId, token: await issueToken(db, contactId), movedConversations: [] };
}
