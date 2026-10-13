// Shared helpers for tests. Not exported from the package.

export function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

export function sseEvents(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stub that answers from a queue of handlers and records every request. */
export function mockFetch(handlers: ((req: RecordedRequest) => Response | Promise<Response>)[]) {
  const requests: RecordedRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), init };
    requests.push(req);
    const handler = handlers.shift();
    if (!handler) throw new Error(`Unexpected fetch: ${req.url}`);
    return handler(req);
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const sseResponse = (events: Record<string, unknown>[]) =>
  new Response(sseStream([sseEvents(events)]), { status: 200, headers: { "Content-Type": "text/event-stream" } });

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
