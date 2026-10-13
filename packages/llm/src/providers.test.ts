import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatGPTAuth, type ChatGPTCredentials, type CredentialStore } from "./chatgpt/auth.ts";
import { ChatGPTProvider } from "./chatgpt/provider.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { collect, json, mockFetch, sseResponse } from "./test-helpers.ts";
import { LlmError } from "./types.ts";

const NOW = 1_800_000_000_000;
const store = (): CredentialStore => {
  let value: ChatGPTCredentials | undefined = {
    hostId: "h",
    clientId: "c",
    tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 3_600_000 },
  };
  return { load: async () => value && structuredClone(value), save: async (c) => void (value = structuredClone(c)) };
};

const completedStream = [
  { type: "response.created" },
  { type: "response.output_text.delta", delta: "Hel" },
  { type: "response.output_text.delta", delta: "lo" },
  { type: "response.completed", response: { id: "resp_1", usage: { output_tokens: 2 } } },
];

test("ChatGPT provider sends a plan-compatible body and streams text", async () => {
  const { fetch, requests } = mockFetch([() => sseResponse(completedStream)]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { now: () => NOW }), { fetch, model: "m1" });

  const events = await collect(provider.stream({ instructions: "Be brief.", messages: [{ role: "user", content: "Hi" }] }));
  assert.deepEqual(events, [
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
    { type: "done", text: "Hello", responseId: "resp_1", usage: { output_tokens: 2 } },
  ]);

  const req = requests[0];
  assert.equal(req?.url, "https://api.openai.com/v1/responses");
  assert.equal((req?.init?.headers as Record<string, string>).Authorization, "Bearer at-1");
  const body = JSON.parse(String(req?.init?.body));
  assert.deepEqual(body, {
    model: "m1",
    input: [{ role: "user", content: "Hi" }],
    store: false,
    stream: true,
    instructions: "Be brief.",
  });
  for (const forbidden of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"]) {
    assert.ok(!(forbidden in body), `${forbidden} must not be sent`);
  }
});

test("ChatGPT provider refreshes once on a plain 401 and retries", async () => {
  const { fetch, requests } = mockFetch([
    () => json({ error: { message: "expired" } }, 401),
    () => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
    () => sseResponse(completedStream),
  ]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { fetch, now: () => NOW }), { fetch });
  const events = await collect(provider.stream({ messages: [{ role: "user", content: "Hi" }] }));

  assert.equal(events.at(-1)?.type, "done");
  assert.equal((requests[2]?.init?.headers as Record<string, string>).Authorization, "Bearer at-2");
});

test("usage limit maps to a clear, non-retryable error", async () => {
  const { fetch } = mockFetch([
    () => json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }, 429),
  ]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { now: () => NOW }), { fetch });
  await assert.rejects(collect(provider.stream({ messages: [{ role: "user", content: "Hi" }] })), (e: unknown) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.code, "usage_limit");
    assert.equal(e.retryable, false);
    assert.match(e.message, /Settings → Usage/);
    return true;
  });
});

test("response.failed inside the stream becomes an LlmError", async () => {
  const { fetch } = mockFetch([
    () =>
      sseResponse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable", message: "busy" } } },
      ]),
  ]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { now: () => NOW }), { fetch });
  await assert.rejects(collect(provider.stream({ messages: [{ role: "user", content: "Hi" }] })), (e: unknown) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.code, "unavailable");
    assert.equal(e.retryable, true);
    return true;
  });
});

test("a stream without response.completed is not treated as success", async () => {
  const { fetch } = mockFetch([() => sseResponse([{ type: "response.output_text.delta", delta: "Hi" }])]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { now: () => NOW }), { fetch });
  await assert.rejects(collect(provider.stream({ messages: [{ role: "user", content: "Hi" }] })), /response.completed/);
});

test("OpenAI API-key provider uses the same request shape with the key and optional base URL", async () => {
  const { fetch, requests } = mockFetch([() => sseResponse(completedStream)]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", baseUrl: "https://gateway.example/openai", fetch });
  const events = await collect(provider.stream({ messages: [{ role: "user", content: "Hi" }] }));

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(requests[0]?.url, "https://gateway.example/openai/responses");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, "Bearer sk-test");
});

test("listModels reads the plan-usage `models` shape and hides non-list models", async () => {
  const { fetch } = mockFetch([
    () =>
      json({
        models: [
          { slug: "gpt-a", display_name: "GPT-A", visibility: "list" },
          { slug: "internal", display_name: "Internal", visibility: "hide" },
        ],
      }),
  ]);
  const provider = new ChatGPTProvider(new ChatGPTAuth(store(), { now: () => NOW }), { fetch });
  assert.deepEqual(await provider.listModels(), [{ slug: "gpt-a", displayName: "GPT-A" }]);
});
