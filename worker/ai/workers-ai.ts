/**
 * Workers AI streams many chat models in two shapes at once: OpenAI-style
 * `choices[0].delta` plus legacy top-level `response` / `tool_calls` copies.
 * `workers-ai-provider` (4.0) reads both, so text and tool-call arguments arrive
 * twice ("II am am", broken JSON). This wraps the binding so streamed chunks that
 * have `choices` drop the legacy copies. Everything else passes through.
 */
export function dedupedAi<T extends { run: (...args: never[]) => Promise<unknown> }>(ai: T): T {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const out = await (target.run as (...a: unknown[]) => Promise<unknown>)(...args);
        return out instanceof ReadableStream ? out.pipeThrough(dedupeSse()) : out;
      };
    },
  });
}

/** Rewrites an SSE byte stream, dropping `response`/`tool_calls` from chunks that have `choices`. */
export function dedupeSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const rewrite = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trim();
    if (!data.startsWith("{")) return line;
    try {
      const chunk = JSON.parse(data) as Record<string, unknown>;
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return line;
      delete chunk.response;
      delete chunk.tool_calls;
      return `data: ${JSON.stringify(chunk)}`;
    } catch {
      return line;
    }
  };
  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length) controller.enqueue(encoder.encode(lines.map(rewrite).join("\n") + "\n"));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}
