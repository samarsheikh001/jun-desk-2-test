import { buildResponsesBody, OPENAI_API_BASE, streamResponses } from "../responses.ts";
import { LlmError, type GenerateRequest, type LlmProvider, type StreamEvent } from "../types.ts";
/** Anything that hands out access tokens: ChatGPTAuth, or a proxy to wherever refresh happens. */
export interface ChatGPTTokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
}

export const DEFAULT_CHATGPT_MODEL = "gpt-6.1-sol";

/**
 * Runs requests on the signed-in user's ChatGPT plan ("Sign in with ChatGPT").
 *
 * DEVELOPMENT ONLY. OpenAI allows plan usage for open-source, locally hosted apps,
 * spent on the signed-in user's own requests. A deployed desk answering website
 * visitors is "remotely hosted" and needs OpenAI's approval, so release builds use
 * OpenAIProvider with an API key instead. See docs/research/06-chatgpt-login.md.
 */
export class ChatGPTProvider implements LlmProvider {
  readonly id = "chatgpt";
  readonly #auth: ChatGPTTokenSource;
  readonly #model: string;
  readonly #fetch: typeof fetch | undefined;

  constructor(auth: ChatGPTTokenSource, options: { model?: string; fetch?: typeof fetch } = {}) {
    this.#auth = auth;
    this.#model = options.model ?? DEFAULT_CHATGPT_MODEL;
    this.#fetch = options.fetch;
  }

  async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const body = buildResponsesBody(request, this.#model);
    let forceRefresh = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.#auth.getAccessToken({ forceRefresh });
      try {
        yield* streamResponses({
          url: `${OPENAI_API_BASE}/responses`,
          headers: { Authorization: `Bearer ${accessToken}` },
          body,
          signal: request.signal,
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
        });
        return;
      } catch (error) {
        // A plain 401 may just be a stale access token: refresh once and retry.
        const retryable401 =
          error instanceof LlmError && error.status === 401 && error.upstreamCode !== "subscription_sharing_invalid_user";
        if (attempt === 0 && retryable401) {
          forceRefresh = true;
          continue;
        }
        throw error;
      }
    }
  }

  /** Models the signed-in account can use (`visibility == "list"`). */
  async listModels(): Promise<{ slug: string; displayName: string }[]> {
    const accessToken = await this.#auth.getAccessToken();
    const response = await (this.#fetch ?? fetch)(`${OPENAI_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new LlmError(`Listing models failed: HTTP ${response.status}`, { code: "bad_request", status: response.status });
    type ModelEntry = { id?: string; slug?: string; display_name?: string; visibility?: string };
    // Plan-usage tokens get `{ models: [...] }`; the standard API shape is `{ data: [...] }`.
    const json = (await response.json()) as { models?: ModelEntry[]; data?: ModelEntry[] };
    return (json.models ?? json.data ?? [])
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .map((m) => {
        const slug = m.slug ?? m.id ?? "";
        return { slug, displayName: m.display_name ?? slug };
      })
      .filter((m) => m.slug !== "");
  }
}
