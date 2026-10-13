// "Sign in with ChatGPT" for open-source, locally hosted apps.
// Protocol: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// Endpoints match https://auth.openai.com/.well-known/openid-configuration
//
// Web-standard APIs only (fetch, crypto.subtle) so this runs on Node and Workers.

export const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
export const REVOKE_URL = `${AUTH_ISSUER}/api/accounts/oauth/revoke`;
export const JWKS_URL = `${AUTH_ISSUER}/.well-known/jwks.json`;

/** Placeholder client id used only for the first (dynamic registration) sign-in. */
export const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Jun Desk";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/auth/callback";

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A new host id in the `urn:uuid:` form shown in OpenAI's docs (a bare UUID is rejected). */
export function newHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

/** Upgrades a bare UUID host id (saved by earlier versions, never accepted) to `urn:uuid:` form. */
export function normalizeHostId(hostId: string): string {
  return UUID_PATTERN.test(hostId) ? `urn:uuid:${hostId}` : hostId;
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export interface AuthorizeParams {
  /** Issued client id from a previous sign-in; omit on first registration. */
  clientId?: string | undefined;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string | undefined;
  idTokenHint?: string | undefined;
}

export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(AUTHORIZE_URL);
  const q = url.searchParams;
  const registering = !params.clientId;
  q.set("client_id", params.clientId ?? REGISTRATION_CLIENT_ID);
  // agent_name_hint goes only on the initial dynamic-registration request.
  if (registering) q.set("agent_name_hint", AGENT_NAME);
  q.set("ext_agent_host_id", params.hostId);
  q.set("response_type", "code");
  q.set("redirect_uri", params.redirectUri);
  q.set("scope", SCOPES);
  q.set("resource", RESOURCE);
  q.set("state", params.state);
  q.set("nonce", params.nonce);
  q.set("code_challenge_method", "S256");
  q.set("code_challenge", params.codeChallenge);
  if (!registering && params.idTokenHint) q.set("id_token_hint", params.idTokenHint);
  else if (!registering && params.loginHint) q.set("login_hint", params.loginHint);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
}

export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string | undefined, status: number) {
    super(description ? `${error}: ${description}` : error);
    this.name = "OAuthError";
    this.error = error;
    this.status = status;
  }
}

/** Refresh errors that mean the stored tokens are dead and the user must sign in again. */
export const UNUSABLE_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

async function postForm(url: string, form: Record<string, string>, doFetch: typeof fetch): Promise<Response> {
  return doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
}

async function tokenRequest(form: Record<string, string>, doFetch: typeof fetch): Promise<TokenResponse> {
  const response = await postForm(TOKEN_URL, form, doFetch);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error body
  }
  if (!response.ok || typeof json.access_token !== "string") {
    const error = typeof json.error === "string" ? json.error : `http_${response.status}`;
    const description = typeof json.error_description === "string" ? json.error_description : text.slice(0, 300) || undefined;
    throw new OAuthError(error, description, response.status);
  }
  return json as unknown as TokenResponse;
}

export function exchangeCode(
  params: { clientId: string; code: string; codeVerifier: string; redirectUri: string },
  doFetch: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      resource: RESOURCE,
    },
    doFetch,
  );
}

export function refreshTokens(
  params: { clientId: string; refreshToken: string },
  doFetch: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: params.clientId,
      refresh_token: params.refreshToken,
      resource: RESOURCE,
    },
    doFetch,
  );
}

export async function revokeToken(
  params: { clientId: string; token: string; tokenTypeHint?: "refresh_token" | "access_token" },
  doFetch: typeof fetch = fetch,
): Promise<void> {
  await postForm(
    REVOKE_URL,
    {
      client_id: params.clientId,
      token: params.token,
      token_type_hint: params.tokenTypeHint ?? "refresh_token",
    },
    doFetch,
  );
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("Malformed JWT");
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

/** The RSA public-key fields we use from a JWKS entry. */
interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

export interface VerifyIdTokenOptions {
  clientId: string;
  nonce: string;
  jwks?: { keys: Jwk[] };
  now?: number;
  fetch?: typeof fetch;
}

/**
 * Verifies an ID token as the docs require: RS256 signature against OpenAI's JWKS,
 * issuer, audience (issued client id), expiry, and the nonce saved for this attempt.
 */
export async function verifyIdToken(idToken: string, options: VerifyIdTokenOptions): Promise<Record<string, unknown>> {
  const [headerPart, payloadPart, signaturePart] = idToken.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new Error("Malformed ID token");

  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unexpected ID token alg: ${header.alg}`);

  const jwks = options.jwks ?? ((await (await (options.fetch ?? fetch)(JWKS_URL)).json()) as { keys: Jwk[] });
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? (jwks.keys.length === 1 ? jwks.keys[0] : undefined);
  if (!jwk) throw new Error(`No JWKS key matches ID token kid ${header.kid}`);

  // importKey's JWK overload isn't typed without DOM types, and this file must compile
  // for both Node and Workers, so call it through a narrow signature.
  const importJwk = crypto.subtle.importKey.bind(crypto.subtle) as unknown as (
    format: "jwk",
    key: { kty?: string; n?: string; e?: string },
    algorithm: { name: string; hash: string },
    extractable: boolean,
    usages: string[],
  ) => Promise<Parameters<typeof crypto.subtle.verify>[1]>;
  const key = await importJwk("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("ID token signature is invalid");

  const claims = decodeJwtPayload(idToken);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const aud = claims.aud;
  if (claims.iss !== AUTH_ISSUER) throw new Error(`Unexpected ID token issuer: ${String(claims.iss)}`);
  if (!(aud === options.clientId || (Array.isArray(aud) && aud.includes(options.clientId)))) {
    throw new Error("ID token audience doesn't match the issued client id");
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds - 60) throw new Error("ID token has expired");
  if (claims.nonce !== options.nonce) throw new Error("ID token nonce doesn't match this sign-in attempt");
  return claims;
}

/** `earliest_refresh_at` may arrive as Unix seconds, milliseconds or an ISO string. */
export function toEpochMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
