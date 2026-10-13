import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { effectiveModels, InvalidModelsError, isUnknownModelError, modelFor, parseJobModels, readJobModels, withFallback, type ModelSettings } from "./models.ts";

const settings = (over: Partial<ModelSettings> = {}): ModelSettings => ({ provider: "chatgpt", model: null, models: {}, ...over });

test("every job uses the workspace model by default", () => {
  assert.deepEqual(modelFor(settings(), "nudge"), { modelId: "gpt-6-luna", fallback: null });
  assert.deepEqual(modelFor(settings({ model: "gpt-6.1-sol" }), "answer"), { modelId: "gpt-6.1-sol", fallback: null });
  assert.equal(new Set(Object.values(effectiveModels(settings({ provider: "workers-ai" })))).size, 1);
});

test("an override applies to its job only, with the workspace model as fallback", () => {
  const s = settings({ model: "gpt-6.1-sol", models: { nudge: "gpt-6-luna", topics: "gpt-6.1-sol" } });
  assert.deepEqual(modelFor(s, "nudge"), { modelId: "gpt-6-luna", fallback: "gpt-6.1-sol" });
  // Same as the workspace model: nothing to fall back to.
  assert.deepEqual(modelFor(s, "topics"), { modelId: "gpt-6.1-sol", fallback: null });
  assert.equal(effectiveModels(s).answer, "gpt-6.1-sol");
  assert.equal(effectiveModels(s).nudge, "gpt-6-luna");
});

test("model overrides are validated", () => {
  assert.deepEqual(parseJobModels({ nudge: " gpt-6-luna ", brief: "", topics: null, draft: "@cf/meta/llama-3.1-8b-instruct" }), {
    nudge: "gpt-6-luna",
    draft: "@cf/meta/llama-3.1-8b-instruct",
  });
  assert.deepEqual(parseJobModels(undefined), {});
  assert.throws(() => parseJobModels({ triage: "x" }), InvalidModelsError);
  assert.throws(() => parseJobModels({ nudge: "has space" }), InvalidModelsError);
  assert.throws(() => parseJobModels({ nudge: "x".repeat(101) }), InvalidModelsError);
  assert.throws(() => parseJobModels({ nudge: 5 }), InvalidModelsError);
  assert.throws(() => parseJobModels(["nudge"]), InvalidModelsError);
  assert.throws(() => parseJobModels("gpt"), InvalidModelsError);
  // Stored JSON that no longer parses is ignored, never fatal.
  assert.deepEqual(readJobModels('{"nudge":"ok-model","old":"x"}'), {});
  assert.deepEqual(readJobModels("not json"), {});
  assert.deepEqual(readJobModels('{"brief":"gpt-6-luna"}'), { brief: "gpt-6-luna" });
});

const apiError = (status: number, body: string) =>
  new APICallError({ message: "Bad Request", url: "https://example.test", requestBodyValues: {}, statusCode: status, responseBody: body, isRetryable: false });

test("unknown-model errors are recognised across providers", () => {
  assert.ok(isUnknownModelError(apiError(400, `{"detail":"The 'does-not-exist-model' model is not supported when using Codex with a ChatGPT account."}`)));
  assert.ok(isUnknownModelError(apiError(404, `{"error":{"message":"The model \`x\` does not exist or you do not have access to it.","code":"model_not_found"}}`)));
  assert.ok(isUnknownModelError(new Error("AiError: No such model @cf/nope or task")));
  assert.ok(!isUnknownModelError(apiError(429, `{"detail":"Rate limit reached"}`)));
  assert.ok(!isUnknownModelError(new Error("fetch failed")));
  assert.ok(!isUnknownModelError("model is not supported"));
});

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } };
type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;
const replying = (modelId: string, text: string) =>
  new MockLanguageModelV4({
    modelId,
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          const parts: StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ];
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
const failing = (error: unknown) =>
  new MockLanguageModelV4({
    modelId: "typo-model",
    doStream: async () => {
      throw error;
    },
  });

async function complete(model: ReturnType<typeof withFallback>): Promise<string> {
  let failure: unknown;
  const result = streamText({ model, prompt: "hi", maxRetries: 0, onError: ({ error }) => void (failure ??= error) });
  // As completeText: the stream's error, not the "no output" that follows it.
  try {
    const text = await result.text;
    if (failure) throw failure;
    return text;
  } catch (error) {
    throw failure ?? error;
  }
}

test("an override the provider rejects falls back to the workspace model once", async () => {
  const fallback = replying("gpt-6-luna", "from the workspace model");
  const fellBack: string[] = [];
  const model = withFallback(failing(apiError(400, `{"detail":"The 'typo-model' model is not supported when using Codex with a ChatGPT account."}`)), () => fallback, {
    job: "nudge",
    modelId: "typo-model",
    fallbackId: "gpt-6-luna",
    onFallback: () => fellBack.push("nudge"),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await complete(model), "from the workspace model");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(fellBack, ["nudge"]);
  assert.equal(fallback.doStreamCalls.length, 1);
});

test("other errors are not retried on the workspace model", async () => {
  const fallback = replying("gpt-6-luna", "unused");
  const model = withFallback(failing(apiError(429, `{"detail":"Rate limit reached"}`)), () => fallback, { job: "brief", modelId: "typo-model", fallbackId: "gpt-6-luna" });
  await assert.rejects(complete(model), (e: unknown) => APICallError.isInstance(e) && e.statusCode === 429);
  assert.equal(fallback.doStreamCalls.length, 0);
});

test("a working override is used as is", async () => {
  const fallback = replying("gpt-6-luna", "unused");
  const model = withFallback(replying("small-model", "from the override"), () => fallback, { job: "topics", modelId: "small-model", fallbackId: "gpt-6-luna" });
  assert.equal(await complete(model), "from the override");
  assert.equal(fallback.doStreamCalls.length, 0);
});

test("Agent page editing defaults to the large model on ChatGPT and OpenAI, unless the admin picks one", () => {
  assert.deepEqual(modelFor(settings(), "editor"), { modelId: "gpt-6-astra", fallback: "gpt-6-luna" });
  assert.deepEqual(modelFor(settings({ provider: "openai" }), "editor"), { modelId: "gpt-6-astra", fallback: "gpt-6.1-sol" });
  assert.deepEqual(modelFor(settings({ models: { editor: "gpt-6-sol" } }), "editor"), { modelId: "gpt-6-sol", fallback: "gpt-6-luna" });
  assert.equal(modelFor(settings({ provider: "workers-ai" }), "editor").fallback, null);
  assert.equal(effectiveModels(settings()).answer, "gpt-6-luna");
  assert.equal(effectiveModels(settings()).editor, "gpt-6-astra");
});
