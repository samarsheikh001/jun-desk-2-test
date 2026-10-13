// I-14: Web Push with web-standard APIs only (WebCrypto, fetch), no dependencies.
// - Message encryption: RFC 8291 (Web Push) with the aes128gcm content coding of RFC 8188.
// - Sender identity: VAPID, RFC 8292 (an ES256 JWT per push service origin).
// Pure except for `sendPush`, which takes the fetch to use.

import { base64UrlDecode, base64UrlEncode } from "./crypto.ts";

type Bytes = Uint8Array<ArrayBuffer>;
// CryptoKey, CryptoKeyPair and JsonWebKey, spelled so both Workers' and Node's types accept them
// (the unit tests run on Node). JWKs are passed to importKey `as never` for the same reason.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export interface KeyPair { privateKey: Key; publicKey: Key }
export interface Jwk { kty?: string; crv?: string; x?: string; y?: string; d?: string; ext?: boolean; key_ops?: string[] }

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A key's raw bytes (Workers' types widen exportKey's result to include JWK). */
async function rawKey(key: Key): Promise<Bytes> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

/** ECDH shared secret. The algorithm's `public` member is `$public` in Workers' types, `public` at runtime. */
async function ecdh(privateKey: Key, publicKey: Key): Promise<Bytes> {
  const algorithm = { name: "ECDH", public: publicKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, key, length * 8));
}

/** A P-256 public key as the 65-byte uncompressed point (0x04 || x || y), as browsers give `p256dh`. */
export function isP256Point(bytes: Uint8Array): boolean {
  return bytes.length === 65 && bytes[0] === 0x04;
}

/** JWK for a P-256 key from its raw public point (and, for a private key, `d`). */
function p256Jwk(publicPoint: Uint8Array, d?: Uint8Array): Jwk {
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicPoint.slice(1, 33)),
    y: base64UrlEncode(publicPoint.slice(33, 65)),
    ...(d ? { d: base64UrlEncode(d) } : {}),
    ext: true,
  };
}

/** Imports a raw ECDH key pair (65-byte public point + 32-byte private scalar), e.g. RFC test vectors. */
export async function importEcdhKeyPair(publicPoint: Uint8Array, privateScalar: Uint8Array): Promise<KeyPair> {
  const privateKey = await crypto.subtle.importKey("jwk", p256Jwk(publicPoint, privateScalar) as never, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", concat(publicPoint), { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

/** RFC 8291 §3.3/3.4: the content key and nonce for one message. */
async function deriveKeys(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce };
}

const RECORD_SIZE = 4096;

/**
 * Encrypts a push message for one subscription (RFC 8291, one aes128gcm record).
 * `uaPublic` is the subscription's `p256dh` (65 bytes) and `authSecret` its `auth` (16 bytes).
 * `asKeys` and `salt` are random per message; pass them only to reproduce test vectors.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  options: { asKeys?: KeyPair; salt?: Uint8Array } = {},
): Promise<Bytes> {
  if (!isP256Point(uaPublic)) throw new Error("p256dh must be a 65-byte uncompressed P-256 point.");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes.");
  // One record: 86-byte header + plaintext + delimiter + 16-byte tag must fit the record size.
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error("Push payload too large.");
  const asKeys = options.asKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as unknown as KeyPair);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = await rawKey(asKeys.publicKey);
  const uaKey = await crypto.subtle.importKey("raw", concat(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = await ecdh(asKeys.privateKey, uaKey);
  const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02: the padding delimiter of the last (only) record, no padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** The receiving side (what a browser does): used by tests and the e2e mock push service. */
export async function decryptPayload(body: Uint8Array, uaKeys: KeyPair, authSecret: Uint8Array): Promise<Bytes> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const uaPublic = await rawKey(uaKeys.publicKey);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = await ecdh(uaKeys.privateKey, asKey);
  const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("Bad padding delimiter.");
  return padded.slice(0, end);
}

// ---------- VAPID (RFC 8292) ----------

/** The application server's identity key. Generated once, kept in Durable Object storage. */
export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what the browser's `applicationServerKey` is. */
  publicKey: string;
  privateJwk: Jwk;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as unknown as KeyPair;
  const publicKey = base64UrlEncode(await rawKey(pair.publicKey));
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
  return { publicKey, privateJwk };
}

const jsonPart = (value: unknown) => base64UrlEncode(enc.encode(JSON.stringify(value)));

/**
 * The `Authorization: vapid t=<jwt>, k=<public key>` header for one push service origin.
 * `subject` is how the push service can reach the sender: the desk's https URL or a mailto:.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  // At most 24 h; 12 h leaves room for clock skew.
  const claims = { aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const input = `${jsonPart({ typ: "JWT", alg: "ES256" })}.${jsonPart(claims)}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk as never, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is already JOSE's raw r || s.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  return `vapid t=${input}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** Checks a VAPID header against a public key (tests and the e2e mock push service). Returns the claims. */
export async function verifyVapidAuthorization(header: string, publicKey: string): Promise<{ aud: string; exp: number; sub: string }> {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  if (!match) throw new Error("Not a VAPID authorization header.");
  const [, head, body, sig, k] = match as unknown as [string, string, string, string, string];
  if (k !== publicKey) throw new Error("VAPID key mismatch.");
  const parsedHead = JSON.parse(new TextDecoder().decode(base64UrlDecode(head))) as { alg?: string; typ?: string };
  if (parsedHead.alg !== "ES256") throw new Error("VAPID JWT must be ES256.");
  const key = await crypto.subtle.importKey("raw", base64UrlDecode(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlDecode(sig), enc.encode(`${head}.${body}`));
  if (!ok) throw new Error("Bad VAPID signature.");
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as { aud: string; exp: number; sub: string };
}

// ---------- sending ----------

export interface PushTarget {
  endpoint: string;
  /** base64url, from the browser's PushSubscription. */
  p256dh: string;
  auth: string;
}

/** What to do with the subscription after a send. */
export type PushOutcome = "ok" | "gone" | "failed";

export function pushOutcome(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "ok";
  // The subscription expired or was unsubscribed: forget it.
  if (status === 404 || status === 410) return "gone";
  return "failed";
}

/** Encrypts and sends one push message. Never throws for HTTP errors: returns the status (0 = network error). */
export async function sendPush(
  target: PushTarget,
  payload: string,
  vapid: { keys: VapidKeys; subject: string },
  options: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; fetch?: typeof fetch } = {},
): Promise<{ status: number; outcome: PushOutcome }> {
  const body = await encryptPayload(enc.encode(payload), base64UrlDecode(target.p256dh), base64UrlDecode(target.auth));
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, vapid.keys, vapid.subject),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttl ?? 86_400),
    Urgency: options.urgency ?? "high",
  };
  // Topic (RFC 8030): a newer undelivered message with the same topic replaces the older one.
  if (options.topic) headers.Topic = options.topic;
  try {
    const res = await (options.fetch ?? fetch)(target.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return { status: res.status, outcome: pushOutcome(res.status) };
  } catch {
    return { status: 0, outcome: "failed" };
  }
}

/** Topic header values: at most 32 URL-safe base64 characters. */
export async function pushTopic(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return base64UrlEncode(digest).slice(0, 32);
}
