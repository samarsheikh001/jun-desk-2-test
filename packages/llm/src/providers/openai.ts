import { buildResponsesBody, OPENAI_API_BASE, streamResponses } from "../responses.ts";
import type { GenerateRequest, LlmProvider, StreamEvent } from "../types.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-6.1-sol";

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  /** e.g. a Cloudflare AI Gateway URL ending in `/openai`. Defaults to api.openai.com. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** OpenAI via a platform API key. This is the provider for released builds. */
export class OpenAIProvider implements LlmProvider {
  readonly id = "openai";
  readonly #options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAIProvider requires an apiKey");
    this.#options = options;
  }

  stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const { apiKey, model, baseUrl, fetch } = this.#options;
    return streamResponses({
      url: `${baseUrl ?? OPENAI_API_BASE}/responses`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: buildResponsesBody(request, model ?? DEFAULT_OPENAI_MODEL),
      signal: request.signal,
      ...(fetch ? { fetch } : {}),
    });
  }
}
