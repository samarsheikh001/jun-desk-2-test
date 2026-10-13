import { ApiError, api } from "../api.ts";

// D-62: the Agent page's AI editors read the model's answer here, as it streams. The Worker passes
// the provider's own event stream through untouched (worker/ai/edit-stream.ts, header x-jun-format),
// so reading it costs the Worker no CPU: OpenAI's Responses events (ChatGPT, an API key) or Workers
// AI's chat chunks. Once it ends, the tokens it used are reported for the month's usage.

/** Server-Sent Events from a byte stream: each message's `event` and joined `data` lines. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | undefined; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const line = (text: string) => {
    if (text === "") {
      const done = data.length ? { event, data: data.join("\n") } : null;
      event = undefined;
      data = [];
      return done;
    }
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const text of done ? [...lines, ""] : lines) {
      const message = line(text);
      if (message) yield message;
    }
    if (done) return;
  }
}

/** A provider's error in plain words. */
const errorText = (error: { code?: string; message?: string } | undefined) => error?.message || error?.code || "unknown error";

export interface StreamedAnswer {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

type ResponsesEvent = {
  type?: string;
  delta?: string;
  response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } };
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
};

type WorkersAiChunk = {
  response?: unknown;
  choices?: { delta?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** POSTs to an editor endpoint and reads its answer, calling `onText` with the whole text so far. */
export async function streamAnswer(base: string, path: string, body: unknown, onText: (text: string) => void, signal?: AbortSignal): Promise<StreamedAnswer> {
  const response = await fetch(`/api${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    const raw = await response.text();
    let json: { error?: { code: string; message: string } } = {};
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      // Cloudflare's own error page
    }
    if (json.error) throw new ApiError(json.error.code, json.error.message, response.status, json.error);
    if (response.status === 503 && /\b1102\b|exceeded/i.test(raw)) throw new ApiError("cpu_limit", "Cloudflare stopped this request: your desk ran over its plan's CPU time limit. Try again; if it keeps happening, the Cloudflare account needs the Workers Paid plan.", 503);
    throw new ApiError("http_error", `Request failed (${response.status})`, response.status);
  }
  const format = response.headers.get("x-jun-format") === "workers-ai" ? "workers-ai" : "responses";
  let text = "";
  let usage: StreamedAnswer["usage"] = null;
  let completed = format === "workers-ai";
  for await (const message of events(response.body)) {
    if (message.data === "[DONE]") continue;
    let event: ResponsesEvent & WorkersAiChunk;
    try {
      event = JSON.parse(message.data) as ResponsesEvent & WorkersAiChunk;
    } catch {
      continue;
    }
    if (format === "workers-ai") {
      // Chat-style chunks, sometimes with a legacy `response` copy of the same text: take one.
      const delta = Array.isArray(event.choices) && event.choices.length ? event.choices[0]?.delta?.content : event.response;
      if (typeof delta === "string" && delta) {
        text += delta;
        onText(text);
      }
      if (event.usage) usage = { inputTokens: event.usage.prompt_tokens ?? 0, outputTokens: event.usage.completion_tokens ?? 0 };
      continue;
    }
    const type = event.type ?? message.event;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      onText(text);
    } else if (type === "response.completed") {
      completed = true;
      const u = event.response?.usage;
      if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    } else if (type === "response.failed") {
      throw new ApiError("ai_failed", `The AI couldn't make the change: ${errorText(event.response?.error)}`);
    } else if (type === "response.incomplete") {
      throw new ApiError("ai_failed", `The AI's answer was cut short (${event.response?.incomplete_details?.reason ?? "unknown reason"}). Try asking for a smaller change.`);
    } else if (type === "error") {
      throw new ApiError("ai_failed", `The AI couldn't make the change: ${errorText(event.error ?? { code: event.code, message: event.message })}`);
    }
  }
  if (!completed) throw new ApiError("ai_failed", "The AI's answer stopped before it finished. Try again.");
  if (usage) void api(`${base}/usage`, { body: usage }).catch(() => undefined);
  return { text, usage };
}
