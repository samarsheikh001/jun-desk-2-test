import { MAX_SECRET_VALUE, SECRET_NAME } from "../../shared/action-setup.ts";
import { base64UrlDecode, base64UrlEncode } from "./crypto.ts";

// V-03: the host app proves who its signed-in user is with a short-lived JWT signed with
// the workspace's identity secret (HS256). Only HS256 is accepted: never "none", never a
// key from the token. Rotating the secret revokes every token signed with the old one.

export interface VerifiedIdentity {
  /** The host app's user id (`sub`). */
  id: string;
  email: string | null;
  name: string | null;
  /** Custom attributes (`attributes` claim): plan, company, MRR… Strings, numbers, booleans. */
  attributes: Record<string, string | number | boolean>;
  /**
   * AI-24: the user's own keys for the host app's API (`secrets` claim: { "API_TOKEN": "…" }), for
   * actions' {user.secrets.NAME} headers. Kept apart from attributes: never stored on the contact,
   * shown to agents or put in the AI's prompt.
   */
  secrets: Record<string, string>;
  expiresAt: number;
}

export class IdentityError extends Error {}

const CLOCK_SKEW_S = 60;
const MAX_ATTRIBUTES = 50;
const MAX_USER_SECRETS = 10;

function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new IdentityError("Malformed identity token.");
}

function cleanAttributes(raw: unknown): VerifiedIdentity["attributes"] {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new IdentityError("attributes must be an object.");
  const out: VerifiedIdentity["attributes"] = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_ATTRIBUTES)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function cleanSecrets(raw: unknown): VerifiedIdentity["secrets"] {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new IdentityError("secrets must be an object of NAME → string.");
  const out: VerifiedIdentity["secrets"] = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SECRET_NAME.test(key)) throw new IdentityError(`secrets: ${key} isn't a valid name (UPPER_SNAKE_CASE, like API_TOKEN).`);
    if (typeof value !== "string" || !value || value.length > MAX_SECRET_VALUE) throw new IdentityError(`secrets: ${key} must be a non-empty string of at most ${MAX_SECRET_VALUE} characters.`);
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_USER_SECRETS) throw new IdentityError(`secrets: at most ${MAX_USER_SECRETS} keys.`);
  return out;
}

const optionalString = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

export async function verifyIdentityToken(token: string, secret: string, now = Date.now()): Promise<VerifiedIdentity> {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new IdentityError("Malformed identity token.");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  if (header.alg !== "HS256") throw new IdentityError("Identity tokens must be signed with HS256.");
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(s);
  } catch {
    throw new IdentityError("Malformed identity token.");
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw new IdentityError("Identity token signature doesn't match. Was it signed with this desk's identity secret?");

  const claims = decodeJson(p);
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== "number") throw new IdentityError("Identity tokens need an exp (expiry) claim.");
  if (claims.exp + CLOCK_SKEW_S < nowS) throw new IdentityError("Identity token has expired.");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) throw new IdentityError("Identity token isn't valid yet.");
  const id = typeof claims.sub === "string" || typeof claims.sub === "number" ? String(claims.sub).trim().slice(0, 200) : "";
  if (!id) throw new IdentityError("Identity tokens need a sub (user id) claim.");
  return {
    id,
    email: optionalString(claims.email, 320),
    name: optionalString(claims.name, 200),
    attributes: cleanAttributes(claims.attributes),
    secrets: cleanSecrets(claims.secrets),
    expiresAt: claims.exp * 1000,
  };
}

/** Signs an identity token. The desk only needs this for tests and docs examples. */
export async function signIdentityToken(claims: Record<string, unknown>, secret: string): Promise<string> {
  const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const head = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(head)));
  return `${head}.${base64UrlEncode(sig)}`;
}
