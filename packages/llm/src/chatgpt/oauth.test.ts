import assert from "node:assert/strict";
import { test } from "node:test";
import { mockFetch, json } from "../test-helpers.ts";
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  exchangeCode,
  newHostId,
  normalizeHostId,
  OAuthError,
  pkceChallenge,
  refreshTokens,
  toEpochMs,
  verifyIdToken,
} from "./oauth.ts";

test("PKCE S256 matches the RFC 7636 test vector", async () => {
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("host ids use the urn:uuid form; bare UUIDs are upgraded", () => {
  assert.match(newHostId(), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(
    normalizeHostId("3f1c2b7e-9a4d-4c1e-8f2a-1b2c3d4e5f60"),
    "urn:uuid:3f1c2b7e-9a4d-4c1e-8f2a-1b2c3d4e5f60",
  );
  assert.equal(normalizeHostId("urn:uuid:abc"), "urn:uuid:abc");
});

const base = {
  hostId: "host-1",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  state: "st",
  nonce: "no",
  codeChallenge: "cc",
};

test("first sign-in registers with dynamic_agent_client and agent_name_hint", () => {
  const q = new URL(buildAuthorizeUrl(base)).searchParams;
  assert.equal(q.get("client_id"), "dynamic_agent_client");
  assert.equal(q.get("agent_name_hint"), "Jun Desk");
  assert.equal(q.get("ext_agent_host_id"), "host-1");
  assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(q.get("resource"), "https://api.openai.com/v1");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
});

test("later sign-ins reuse the issued client id without agent_name_hint", () => {
  const q = new URL(buildAuthorizeUrl({ ...base, clientId: "issued-123", idTokenHint: "old.id.token" })).searchParams;
  assert.equal(q.get("client_id"), "issued-123");
  assert.equal(q.get("agent_name_hint"), null);
  assert.equal(q.get("id_token_hint"), "old.id.token");
});

test("code exchange posts the documented form fields", async () => {
  const { fetch, requests } = mockFetch([() => json({ access_token: "at", refresh_token: "rt", expires_in: 3600 })]);
  await exchangeCode({ clientId: "c", code: "code", codeVerifier: "v", redirectUri: base.redirectUri }, fetch);
  const form = new URLSearchParams(String(requests[0]?.init?.body));
  assert.equal(requests[0]?.url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.deepEqual(Object.fromEntries(form), {
    grant_type: "authorization_code",
    client_id: "c",
    code: "code",
    code_verifier: "v",
    redirect_uri: base.redirectUri,
    resource: "https://api.openai.com/v1",
  });
});

test("token errors surface the OAuth error code", async () => {
  const { fetch } = mockFetch([() => json({ error: "refresh_token_reused", error_description: "nope" }, 400)]);
  await assert.rejects(refreshTokens({ clientId: "c", refreshToken: "r" }, fetch), (error: unknown) => {
    assert.ok(error instanceof OAuthError);
    assert.equal(error.error, "refresh_token_reused");
    return true;
  });
});

test("earliest_refresh_at accepts seconds, ms and ISO strings", () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs("2026-10-04T00:00:00Z"), Date.parse("2026-10-04T00:00:00Z"));
  assert.equal(toEpochMs(undefined), undefined);
});

async function signedIdToken(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc({ alg: "RS256", kid: "k1" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return { token: `${input}.${base64UrlEncode(new Uint8Array(sig))}`, jwks: { keys: [jwk] } };
}

const now = Date.parse("2026-10-04T12:00:00Z");
const goodClaims = { iss: "https://auth.openai.com", aud: "client-1", exp: now / 1000 + 600, nonce: "n1", email: "dev@example.com" };

test("verifies a correctly signed ID token", async () => {
  const { token, jwks } = await signedIdToken(goodClaims);
  const claims = await verifyIdToken(token, { clientId: "client-1", nonce: "n1", jwks, now });
  assert.equal(claims.email, "dev@example.com");
});

test("rejects wrong nonce, audience, issuer, expiry and tampering", async () => {
  const { token, jwks } = await signedIdToken(goodClaims);
  await assert.rejects(verifyIdToken(token, { clientId: "client-1", nonce: "other", jwks, now }), /nonce/);
  await assert.rejects(verifyIdToken(token, { clientId: "client-2", nonce: "n1", jwks, now }), /audience/);
  await assert.rejects(verifyIdToken(token, { clientId: "client-1", nonce: "n1", jwks, now: now + 3_600_000 }), /expired/);

  const bad = await signedIdToken({ ...goodClaims, iss: "https://evil.example" });
  await assert.rejects(verifyIdToken(bad.token, { clientId: "client-1", nonce: "n1", jwks: bad.jwks, now }), /issuer/);

  const [h, , s] = token.split(".");
  const forged = `${h}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...goodClaims, email: "x" })))}.${s}`;
  await assert.rejects(verifyIdToken(forged, { clientId: "client-1", nonce: "n1", jwks, now }), /signature/);
});
