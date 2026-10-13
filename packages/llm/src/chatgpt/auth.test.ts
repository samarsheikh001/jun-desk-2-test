import assert from "node:assert/strict";
import { test } from "node:test";
import { json, mockFetch } from "../test-helpers.ts";
import { LlmError } from "../types.ts";
import { ChatGPTAuth, type ChatGPTCredentials, type CredentialStore } from "./auth.ts";

class MemoryStore implements CredentialStore {
  value: ChatGPTCredentials | undefined;
  saves = 0;
  constructor(value?: ChatGPTCredentials) {
    this.value = value;
  }
  async load() {
    return this.value && structuredClone(this.value);
  }
  async save(c: ChatGPTCredentials) {
    this.saves++;
    this.value = structuredClone(c);
  }
}

const NOW = 1_800_000_000_000;
const creds = (tokens: Partial<NonNullable<ChatGPTCredentials["tokens"]>> = {}): ChatGPTCredentials => ({
  hostId: "h",
  clientId: "c",
  tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 30 * 60_000, ...tokens },
});

test("returns the stored token while it's fresh", async () => {
  const { fetch, requests } = mockFetch([]);
  const auth = new ChatGPTAuth(new MemoryStore(creds()), { fetch, now: () => NOW });
  assert.equal(await auth.getAccessToken(), "at-1");
  assert.equal(requests.length, 0);
});

test("refreshes near expiry and saves the rotated refresh token", async () => {
  const store = new MemoryStore(creds({ expiresAt: NOW + 10_000 }));
  const { fetch, requests } = mockFetch([() => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 })]);
  const auth = new ChatGPTAuth(store, { fetch, now: () => NOW });

  assert.equal(await auth.getAccessToken(), "at-2");
  assert.equal(new URLSearchParams(String(requests[0]?.init?.body)).get("refresh_token"), "rt-1");
  assert.equal(store.value?.tokens?.refreshToken, "rt-2");
  assert.equal(store.value?.tokens?.expiresAt, NOW + 3_600_000);
});

test("concurrent callers share one refresh (rotation-safe)", async () => {
  const store = new MemoryStore(creds({ expiresAt: NOW - 1 }));
  const { fetch, requests } = mockFetch([() => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 })]);
  const auth = new ChatGPTAuth(store, { fetch, now: () => NOW });

  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ["at-2", "at-2", "at-2"]);
  assert.equal(requests.length, 1);
});

test("respects earliest_refresh_at while the token is still valid", async () => {
  const { fetch, requests } = mockFetch([]);
  const store = new MemoryStore(creds({ expiresAt: NOW + 10_000, earliestRefreshAt: NOW + 5_000 }));
  const auth = new ChatGPTAuth(store, { fetch, now: () => NOW });
  assert.equal(await auth.getAccessToken({ forceRefresh: true }), "at-1");
  assert.equal(requests.length, 0);
});

test("unusable refresh token clears tokens but keeps host and client ids", async () => {
  const store = new MemoryStore(creds({ expiresAt: NOW - 1 }));
  const { fetch } = mockFetch([() => json({ error: "refresh_token_reused" }, 400)]);
  const auth = new ChatGPTAuth(store, { fetch, now: () => NOW });

  await assert.rejects(auth.getAccessToken(), (e: unknown) => e instanceof LlmError && e.code === "reauth_required");
  assert.deepEqual(store.value, { hostId: "h", clientId: "c", tokens: undefined });
});

test("missing plan-usage scope asks the user to sign in again", async () => {
  const auth = new ChatGPTAuth(new MemoryStore(creds({ scope: "openid profile email offline_access" })), { now: () => NOW });
  await assert.rejects(auth.getAccessToken(), (e: unknown) => e instanceof LlmError && e.code === "reauth_required");
});

test("not signed in", async () => {
  const auth = new ChatGPTAuth(new MemoryStore({ hostId: "h" }));
  await assert.rejects(auth.getAccessToken(), (e: unknown) => e instanceof LlmError && e.code === "not_signed_in");
});

test("logout revokes the refresh token and forgets tokens", async () => {
  const store = new MemoryStore(creds());
  const { fetch, requests } = mockFetch([() => new Response(null, { status: 200 })]);
  await new ChatGPTAuth(store, { fetch }).logout();
  assert.equal(requests[0]?.url, "https://auth.openai.com/api/accounts/oauth/revoke");
  assert.equal(new URLSearchParams(String(requests[0]?.init?.body)).get("token"), "rt-1");
  assert.equal(store.value?.tokens, undefined);
  assert.equal(store.value?.clientId, "c");
});
