import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { base64UrlDecode, base64UrlEncode, newId } from "../lib/crypto.ts";
import { HttpError, type AppContext } from "../types.ts";

const RP_NAME = "Jun Desk";
const CHALLENGE_COOKIE = "jun_challenge";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengeKind = "setup" | "recover" | "invite" | "add_passkey" | "login";

/**
 * The relying party is the hostname the dashboard is served from. Passkeys only work on
 * the hostname they were created on, so moving to a custom domain means adding new ones.
 */
export function relyingParty(c: AppContext): { rpID: string; origin: string } {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

async function saveChallenge(c: AppContext, kind: ChallengeKind, challenge: string, payload: object): Promise<void> {
  const id = newId("ch");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now),
    c.env.DB.prepare("INSERT INTO auth_challenges (id, challenge, kind, payload, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      challenge,
      kind,
      JSON.stringify(payload),
      now + CHALLENGE_TTL_MS,
    ),
  ]);
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/api",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

/** Loads and deletes (single use) the pending challenge for this browser. */
async function takeChallenge<P>(c: AppContext, kind: ChallengeKind): Promise<{ challenge: string; payload: P }> {
  const id = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api" });
  if (!id) throw new HttpError(400, "no_challenge", "This sign-in step expired. Start again.");
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id = ? AND kind = ? AND expires_at > ? RETURNING challenge, payload",
  )
    .bind(id, kind, Date.now())
    .first<{ challenge: string; payload: string }>();
  if (!row) throw new HttpError(400, "no_challenge", "This sign-in step expired. Start again.");
  return { challenge: row.challenge, payload: JSON.parse(row.payload) as P };
}

export async function startRegistration(
  c: AppContext,
  kind: Exclude<ChallengeKind, "login">,
  user: { id: string; name: string; email: string | null },
  payload: object,
) {
  const { rpID } = relyingParty(c);
  const existing = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ? AND rp_id = ?")
    .bind(user.id, rpID)
    .all<{ id: string; transports: string | null }>();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email ?? user.name,
    userDisplayName: user.name,
    userID: new Uint8Array(new TextEncoder().encode(user.id)),
    attestationType: "none",
    // Discoverable credentials, so sign-in needs no username.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) as string[] } : {}),
    })),
  });
  await saveChallenge(c, kind, options.challenge, { ...payload, userId: user.id });
  return options;
}

/** Verifies a registration and stores the passkey. Returns the challenge payload. */
export async function finishRegistration<P extends { userId: string }>(
  c: AppContext,
  kind: Exclude<ChallengeKind, "login">,
  response: RegistrationResponseJSON,
  beforeInsert: (payload: P) => D1PreparedStatement[] = () => [],
): Promise<P> {
  const { challenge, payload } = await takeChallenge<P>(c, kind);
  const { rpID, origin } = relyingParty(c);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (error) {
    throw new HttpError(400, "passkey_invalid", `Passkey couldn't be verified: ${(error as Error).message}`);
  }
  if (!verification.verified) throw new HttpError(400, "passkey_invalid", "Passkey couldn't be verified.");

  const info = verification.registrationInfo;
  const now = Date.now();
  // Account creation (if any) and the passkey insert commit together.
  await c.env.DB.batch([
    ...beforeInsert(payload),
    c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, rp_id, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      info.credential.id,
      payload.userId,
      base64UrlEncode(info.credential.publicKey),
      info.credential.counter,
      info.credential.transports ? JSON.stringify(info.credential.transports) : null,
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      rpID,
      passkeyName(c.req.header("user-agent")),
      now,
    ),
  ]);
  return payload;
}

export async function startLogin(c: AppContext) {
  const { rpID } = relyingParty(c);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  await saveChallenge(c, "login", options.challenge, {});
  return options;
}

/** Verifies a passkey sign-in and returns the user id. */
export async function finishLogin(c: AppContext, response: AuthenticationResponseJSON): Promise<string> {
  const { challenge } = await takeChallenge(c, "login");
  const { rpID, origin } = relyingParty(c);

  const passkey = await c.env.DB.prepare(
    "SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ? AND rp_id = ?",
  )
    .bind(response.id, rpID)
    .first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!passkey) throw new HttpError(401, "unknown_passkey", "This passkey isn't registered with this Jun Desk.");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: base64UrlDecode(passkey.public_key),
        counter: passkey.counter,
        ...(passkey.transports ? { transports: JSON.parse(passkey.transports) as string[] } : {}),
      },
    });
  } catch (error) {
    throw new HttpError(401, "passkey_invalid", `Sign-in failed: ${(error as Error).message}`);
  }
  if (!verification.verified) throw new HttpError(401, "passkey_invalid", "Sign-in failed.");

  await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, Date.now(), passkey.id)
    .run();
  return passkey.user_id;
}

/** A readable default name like "Chrome on Windows". */
function passkeyName(userAgent: string | undefined): string {
  if (!userAgent) return "Passkey";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /Windows/.test(userAgent) ? "Windows" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Mac OS X/.test(userAgent) ? "macOS" : /Android/.test(userAgent) ? "Android" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
