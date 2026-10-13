import { SOCKET_PROTOCOL } from "../../shared/protocol.ts";

export type SocketState = "connecting" | "open" | "closed";

/**
 * A WebSocket that reconnects with backoff and keeps itself alive with pings
 * (answered by the Durable Object without waking it). `url()` is re-evaluated on each
 * connect so callers can pass `?since=` for catch-up.
 */
export class LiveSocket<E> {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = false;
  #ping: ReturnType<typeof setInterval> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  readonly #url: () => string;
  readonly #protocols: string[];
  readonly #onEvent: (event: E) => void;
  readonly #onState: (state: SocketState) => void;

  constructor(options: { url: () => string; protocols?: string[]; onEvent: (event: E) => void; onState?: (state: SocketState) => void }) {
    this.#url = options.url;
    this.#protocols = [SOCKET_PROTOCOL, ...(options.protocols ?? [])];
    this.#onEvent = options.onEvent;
    this.#onState = options.onState ?? (() => {});
    this.#connect();
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#onState("connecting");
    const absolute = new URL(this.#url(), window.location.href);
    absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(absolute, this.#protocols);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      this.#onState("open");
      this.#ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try {
        this.#onEvent(JSON.parse(String(e.data)) as E);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      clearInterval(this.#ping);
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#onState("closed");
      if (this.#stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.#attempt++) * (0.75 + Math.random() / 2);
      this.#retry = setTimeout(() => this.#connect(), delay);
    };
  }

  /** Sends if connected; returns whether it was sent. */
  send(data: unknown): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(data));
    return true;
  }

  close(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearInterval(this.#ping);
    this.#ws?.close();
    this.#ws = null;
  }
}
