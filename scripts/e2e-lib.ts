// Shared helpers for the e2e scripts: a software passkey authenticator, a cookie-keeping
// HTTP client, a WebSocket helper and a tiny step runner.

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

export const BASE = process.env.BASE_URL ?? "http://localhost:5173";
export const ORIGIN = new URL(BASE).origin;
export const RP_ID = new URL(BASE).hostname;
export const SETUP_TOKEN = process.env.SETUP_TOKEN ?? /^SETUP_TOKEN=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
if (!SETUP_TOKEN) throw new Error("No SETUP_TOKEN in env or .dev.vars");

// ---------- tiny CBOR encoder (enough for attestation objects and COSE keys) ----------
function cborHead(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  throw new Error("CBOR length too large for this encoder");
}
function cbor(value: unknown): number[] {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = [...new TextEncoder().encode(value)];
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  if (value instanceof Map) {
    const out = cborHead(5, value.size);
    for (const [k, v] of value) out.push(...cbor(k), ...cbor(v));
    return out;
  }
  throw new Error(`Unsupported CBOR value: ${String(value)}`);
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** Raw (r||s) ECDSA signature → ASN.1 DER, which WebAuthn expects. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class SoftAuthenticator {
  credentials = new Map<string, { key: webcrypto.CryptoKeyPair; userHandle: string; counter: number }>();

  async create(options: { challenge: string; user: { id: string }; rp: { id?: string } }) {
    const key = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
    const jwk = await webcrypto.subtle.exportKey("jwk", key.publicKey);
    const credId = webcrypto.getRandomValues(new Uint8Array(16));
    const coseKey = new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]);
    const authData = concat(
      sha256(options.rp.id ?? RP_ID),
      new Uint8Array([0x45]), // UP | UV | AT
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, credId.length]),
      credId,
      new Uint8Array(cbor(coseKey)),
    );
    const attestationObject = new Uint8Array(cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN, crossOrigin: false });
    const id = b64url(credId);
    this.credentials.set(id, { key, userHandle: options.user.id, counter: 0 });
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  async get(options: { challenge: string; rpId?: string }, credentialId?: string) {
    const id = credentialId ?? [...this.credentials.keys()][0]!;
    const cred = this.credentials.get(id)!;
    cred.counter++;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, cred.counter);
    const authData = concat(sha256(options.rpId ?? RP_ID), new Uint8Array([0x05]), counter);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.key.privateKey, concat(authData, sha256(clientDataJSON))));
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(raw)),
        userHandle: cred.userHandle,
      },
    };
  }
}

// ---------- a browser-ish client with a cookie jar ----------
/**
 * The model provider the suites' real-AI steps use: the CLI's ChatGPT login by default
 * (`npm run jun -- login chatgpt` once), so test runs don't spend the Workers AI daily free
 * allocation the live desk relies on. `E2E_AI_PROVIDER=workers-ai` switches back.
 */
export const AI_PROVIDER = process.env.E2E_AI_PROVIDER ?? "chatgpt";
const connectedWorkspaces = new Set<string>();

/** Hands the test server a short-lived access token from `~/.jun/chatgpt.json` (never the refresh token). */
async function connectTestChatGPT(client: Client, workspaceId: string): Promise<void> {
  if (connectedWorkspaces.has(workspaceId)) return;
  const { FileCredentialStore } = await import("../packages/cli/src/store.ts");
  const { ChatGPTAuth } = await import("../packages/llm/src/index.ts");
  const store = new FileCredentialStore();
  const auth = new ChatGPTAuth(store);
  let creds = await store.load();
  if (!creds?.tokens) throw new Error("E2E uses your ChatGPT login: run `npm run jun -- login chatgpt` first (or set E2E_AI_PROVIDER=workers-ai).");
  // A run takes several minutes: start with at least 30 left. Refresh tokens rotate and reusing
  // one ends the session, so runs in parallel (other worktrees) take turns via a lock directory.
  if (creds.tokens.expiresAt - Date.now() < 30 * 60_000) {
    const { mkdir, rmdir, stat } = await import("node:fs/promises");
    const lock = `${store.path}.lock`;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch {
        // A lock older than a minute was left by a crashed run.
        const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => Date.now()));
        if (age > 60_000) await rmdir(lock).catch(() => {});
        else await new Promise((r) => setTimeout(r, 500));
      }
    }
    try {
      creds = await store.load();
      if (creds!.tokens!.expiresAt - Date.now() < 30 * 60_000) {
        await auth.getAccessToken({ forceRefresh: true });
        creds = await store.load();
      }
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }
  const res = await client.call(`/workspaces/${workspaceId}/ai/chatgpt/access-token`, {
    body: { accessToken: creds!.tokens!.accessToken, expiresAt: creds!.tokens!.expiresAt, clientId: creds!.clientId },
  });
  assert.equal(res.status, 200, `connecting the test desk to ChatGPT: ${JSON.stringify(res.json)}`);
  connectedWorkspaces.add(workspaceId);
}

export class Client {
  cookies = new Map<string, string>();

  async call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    // Switching a workspace to ChatGPT first connects it to the CLI's login.
    const aiPath = /^\/workspaces\/([^/]+)\/ai$/.exec(path);
    if (aiPath && init.method === "PUT" && (init.body as { provider?: string } | undefined)?.provider === "chatgpt") await connectTestChatGPT(this, aiPath[1]!);
    const headers: Record<string, string> = { Origin: ORIGIN, ...init.headers };
    if (init.body instanceof Uint8Array) headers["X-Jun-Upload"] ??= "1";
    if (init.body !== undefined && !(init.body instanceof Uint8Array)) headers["Content-Type"] ??= "application/json";
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? null : typeof init.body === "string" || init.body instanceof Uint8Array ? (init.body as string | Uint8Array<ArrayBuffer>) : JSON.stringify(init.body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, json };
  }

  async register(prefix: string, auth: SoftAuthenticator, body: Record<string, unknown> = {}) {
    const options = await this.call(`${prefix}/options`, { body });
    assert.equal(options.status, 200, `${prefix}/options: ${JSON.stringify(options.json)}`);
    const response = await auth.create(options.json as any);
    return this.call(`${prefix}/verify`, { body: { response } });
  }

  async login(auth: SoftAuthenticator, credentialId?: string) {
    const options = await this.call("/auth/login/options", { body: {} });
    assert.equal(options.status, 200);
    const response = await auth.get(options.json as any, credentialId);
    return this.call("/auth/login/verify", { body: { response } });
  }
}


export function cookieHeader(client: Client): string {
  return [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** A WebSocket that buffers events so tests can await the next matching one. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly events: any[] = [];
  #waiters: { match: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number }>;

  constructor(path: string, options: { protocols?: string[]; headers?: Record<string, string> } = {}) {
    const url = new URL(path, BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Node's WebSocket (undici) accepts headers, which browsers can't send: used for the cookie.
    this.ws = new WebSocket(url, { protocols: ["jun", ...(options.protocols ?? [])], headers: { Origin: ORIGIN, ...options.headers } } as any);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error(`WebSocket ${path} failed to open`)));
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", (e) => resolve({ code: e.code })));
    // Like the widget and the dashboard: the hub treats a socket with no ping for 75 s as gone.
    const ping = setInterval(() => this.ws.readyState === WebSocket.OPEN && this.ws.send("ping"), 30_000);
    ping.unref();
    this.ws.addEventListener("close", () => clearInterval(ping));
    this.ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      const event = JSON.parse(String(e.data));
      const waiter = this.#waiters.find((w) => w.match(event));
      if (waiter) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      } else {
        this.events.push(event);
      }
    });
  }

  /** Resolves with the first (buffered or future) event matching `match`. */
  next(match: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const index = this.events.findIndex(match);
    if (index !== -1) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for a socket event")), timeoutMs);
      this.#waiters.push({ match, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  /** Asserts no matching event arrives within `ms`. */
  async none(match: (e: any) => boolean, ms = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.events.some(match)) throw new Error(`Unexpected socket event: ${JSON.stringify(this.events.find(match))}`);
  }

  send(event: unknown): void {
    this.ws.send(JSON.stringify(event));
  }

  close(): void {
    this.ws.close();
  }
}

let passed = 0;
export async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`✔ ${name}`);
}
export const summary = () => console.log(`\n${passed} steps passed`);
