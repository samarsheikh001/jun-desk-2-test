export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  model?: string;
  /** System-level guidance. Sent as `instructions`; ChatGPT plan usage rejects system-role messages. */
  instructions?: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "done"; text: string; responseId?: string; usage?: unknown };

export interface LlmProvider {
  readonly id: string;
  stream(request: GenerateRequest): AsyncGenerator<StreamEvent>;
}

export type LlmErrorCode =
  | "not_signed_in"
  | "reauth_required"
  | "usage_limit"
  | "not_eligible"
  | "unsupported"
  | "unavailable"
  | "incomplete"
  | "bad_request"
  | "unknown";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Raw error code from the upstream API, e.g. `subscription_sharing_usage_limit_exceeded`. */
  readonly upstreamCode: string | undefined;

  constructor(
    message: string,
    options: { code: LlmErrorCode; status?: number; retryable?: boolean; upstreamCode?: string },
  ) {
    super(message);
    this.name = "LlmError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.upstreamCode = options.upstreamCode;
  }
}
