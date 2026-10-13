import { parseSse } from "./sse.ts";
import { LlmError, type GenerateRequest, type LlmErrorCode, type StreamEvent } from "./types.ts";

export const OPENAI_API_BASE = "https://api.openai.com/v1";

/** Builds a Responses API body. Only fields that ChatGPT plan usage also accepts. */
export function buildResponsesBody(request: GenerateRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model ?? model,
    input: request.messages.map((m) => ({ role: m.role, content: m.content })),
    store: false,
    stream: true,
  };
  if (request.instructions) body.instructions = request.instructions;
  return body;
}

interface UpstreamError {
  code?: string;
  type?: string;
  message?: string;
  param?: string;
}

// Error codes from https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
const UPSTREAM_CODES: Record<string, { code: LlmErrorCode; retryable: boolean; message?: string }> = {
  subscription_sharing_usage_limit_exceeded: {
    code: "usage_limit",
    retryable: false,
    message: "ChatGPT plan usage limit reached. Check ChatGPT → Settings → Usage, or switch to an API key.",
  },
  subscription_sharing_user_not_eligible: {
    code: "not_eligible",
    retryable: false,
    message: "This ChatGPT account or workspace isn't eligible for plan usage in third-party apps.",
  },
  subscription_sharing_usage_unavailable: { code: "unavailable", retryable: true },
  subscription_sharing_user_unavailable: { code: "unavailable", retryable: true },
  subscription_sharing_unsupported_capability: { code: "unsupported", retryable: false },
  subscription_sharing_route_not_supported: { code: "unsupported", retryable: false },
  subscription_sharing_invalid_user: {
    code: "reauth_required",
    retryable: false,
    message: "ChatGPT sign-in is no longer valid. Run `jun login chatgpt` again.",
  },
};

export function toLlmError(status: number | undefined, error: UpstreamError | undefined): LlmError {
  const upstreamCode = error?.code ?? error?.type;
  const known = upstreamCode ? UPSTREAM_CODES[upstreamCode] : undefined;
  const detail = error?.message ?? (status ? `HTTP ${status}` : "unknown error");
  const param = error?.param ? ` (param: ${error.param})` : "";

  if (known) {
    return new LlmError(known.message ?? `${detail}${param}`, {
      code: known.code,
      status,
      retryable: known.retryable,
      ...(upstreamCode ? { upstreamCode } : {}),
    });
  }

  const code: LlmErrorCode =
    status === 401 ? "reauth_required"
    : status === 403 ? "not_eligible"
    : status === 429 ? "usage_limit"
    : status !== undefined && status >= 500 ? "unavailable"
    : status !== undefined && status >= 400 ? "bad_request"
    : "unknown";
  return new LlmError(`${detail}${param}`, {
    code,
    status,
    retryable: status === 429 || (status !== undefined && status >= 500),
    ...(upstreamCode ? { upstreamCode } : {}),
  });
}

async function readError(response: Response): Promise<UpstreamError | undefined> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: UpstreamError };
    return json.error ?? { message: text };
  } catch {
    return text ? { message: text.slice(0, 500) } : undefined;
  }
}

export interface StreamResponsesOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch;
}

/**
 * POSTs to the Responses API and yields text deltas. Success only on `response.completed`,
 * as the docs require; a stream that ends without it is an error.
 */
export async function* streamResponses(options: StreamResponsesOptions): AsyncGenerator<StreamEvent> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...options.headers },
    body: JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok || !response.body) {
    throw toLlmError(response.status, await readError(response));
  }

  let text = "";
  for await (const message of parseSse(response.body)) {
    if (message.data === "[DONE]") continue;
    let payload: { type?: string; delta?: string; response?: { id?: string; usage?: unknown; error?: UpstreamError; incomplete_details?: { reason?: string } }; error?: UpstreamError; code?: string; message?: string };
    try {
      payload = JSON.parse(message.data);
    } catch {
      continue;
    }
    const type = payload.type ?? message.event;

    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      text += payload.delta;
      yield { type: "text-delta", text: payload.delta };
    } else if (type === "response.completed") {
      yield {
        type: "done",
        text,
        ...(payload.response?.id ? { responseId: payload.response.id } : {}),
        ...(payload.response?.usage !== undefined ? { usage: payload.response.usage } : {}),
      };
      return;
    } else if (type === "response.failed") {
      throw toLlmError(undefined, payload.response?.error);
    } else if (type === "response.incomplete") {
      const reason = payload.response?.incomplete_details?.reason ?? "unknown reason";
      throw new LlmError(`Response incomplete: ${reason}`, { code: "incomplete" });
    } else if (type === "error") {
      throw toLlmError(undefined, payload.error ?? { code: payload.code, message: payload.message } as UpstreamError);
    }
  }

  throw new LlmError("Stream ended before response.completed", { code: "incomplete", retryable: true });
}
