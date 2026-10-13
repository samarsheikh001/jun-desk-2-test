import assert from "node:assert/strict";
import { test } from "node:test";
import { base64UrlDecode, base64UrlEncode } from "./crypto.ts";
import {
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  importEcdhKeyPair,
  pushOutcome,
  pushTopic,
  sendPush,
  vapidAuthorization,
  verifyVapidAuthorization,
  type KeyPair,
} from "./webpush.ts";

// RFC 8291 Appendix A (whitespace removed).
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  // Section 5: header (86 octets) + ciphertext.
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
    "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const d = base64UrlDecode;

test("RFC 8291 Appendix A: encryption reproduces the test vector exactly", async () => {
  const asKeys = await importEcdhKeyPair(d(RFC.asPublic), d(RFC.asPrivate));
  const body = await encryptPayload(d(RFC.plaintext), d(RFC.uaPublic), d(RFC.auth), { asKeys, salt: d(RFC.salt) });
  assert.equal(body.length, 86 + 41 + 1 + 16); // header + plaintext + delimiter + tag
  assert.equal(base64UrlEncode(body), RFC.result);
});

test("RFC 8291 Appendix A: the user agent decrypts the test vector", async () => {
  const uaKeys = await importEcdhKeyPair(d(RFC.uaPublic), d(RFC.uaPrivate));
  const plain = await decryptPayload(d(RFC.result), uaKeys, d(RFC.auth));
  assert.equal(new TextDecoder().decode(plain), "When I grow up, I want to be a watermelon");
});

test("random keys and salt: round trip; wrong auth secret fails; bad inputs are rejected", async () => {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as unknown as KeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const message = JSON.stringify({ title: "Ana replied", body: "Héllo 👋" });
  const a = await encryptPayload(new TextEncoder().encode(message), uaPublic, auth);
  const b = await encryptPayload(new TextEncoder().encode(message), uaPublic, auth);
  assert.notEqual(base64UrlEncode(a), base64UrlEncode(b), "fresh salt and key per message");
  assert.equal(new TextDecoder().decode(await decryptPayload(a, ua, auth)), message);
  await assert.rejects(decryptPayload(a, ua, crypto.getRandomValues(new Uint8Array(16))));
  await assert.rejects(encryptPayload(new Uint8Array(1), uaPublic.slice(1), auth), /p256dh/);
  await assert.rejects(encryptPayload(new Uint8Array(1), uaPublic, auth.slice(1)), /auth/);
  await assert.rejects(encryptPayload(new Uint8Array(4000), uaPublic, auth), /too large/);
});

test("VAPID: ES256 JWT for the push service origin, signature verifies with the public key", async () => {
  const keys = await generateVapidKeys();
  assert.equal(d(keys.publicKey).length, 65);
  assert.equal(d(keys.publicKey)[0], 4);
  assert.equal(keys.privateJwk.crv, "P-256");
  const now = Date.parse("2026-10-06T10:00:00Z");
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, "https://desk.acme.test", now);
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const jwt = /t=([^,]+)/.exec(header)![1]!;
  const [head, , sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(d(head!))), { typ: "JWT", alg: "ES256" });
  assert.equal(d(sig!).length, 64, "raw r || s, not DER");
  const claims = await verifyVapidAuthorization(header, keys.publicKey);
  assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://desk.acme.test" });
  // Independent check with a plain WebCrypto import of the public key.
  const key = await crypto.subtle.importKey("raw", d(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, d(sig!), new TextEncoder().encode(jwt.split(".").slice(0, 2).join("."))));
  // Another key, or a tampered token, fails.
  await assert.rejects(verifyVapidAuthorization(header, (await generateVapidKeys()).publicKey), /mismatch/);
  const other = await generateVapidKeys();
  await assert.rejects(verifyVapidAuthorization(header.replace(/k=.*$/, `k=${other.publicKey}`), other.publicKey), /signature/);
});

test("sendPush: headers, encrypted body, outcomes per status", async () => {
  const keys = await generateVapidKeys();
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as unknown as KeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const target = { endpoint: "https://push.example.test/sub/1", p256dh: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: base64UrlEncode(auth) };
  const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
  let status = 201;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body as Uint8Array) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;

  const topic = await pushTopic("cv_123");
  assert.match(topic, /^[\w-]{32}$/);
  const result = await sendPush(target, '{"title":"hi"}', { keys, subject: "https://desk.acme.test" }, { fetch: fakeFetch, topic });
  assert.deepEqual(result, { status: 201, outcome: "ok" });
  const req = seen[0]!;
  assert.equal(req.url, target.endpoint);
  assert.equal(req.headers.get("content-encoding"), "aes128gcm");
  assert.equal(req.headers.get("ttl"), "86400");
  assert.equal(req.headers.get("urgency"), "high");
  assert.equal(req.headers.get("topic"), topic);
  assert.equal((await verifyVapidAuthorization(req.headers.get("authorization")!, keys.publicKey)).aud, "https://push.example.test");
  assert.equal(new TextDecoder().decode(await decryptPayload(req.body, ua, auth)), '{"title":"hi"}');

  status = 410;
  assert.equal((await sendPush(target, "x", { keys, subject: "mailto:a@b.test" }, { fetch: fakeFetch })).outcome, "gone");
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendPush(target, "x", { keys, subject: "mailto:a@b.test" }, { fetch: failing }), { status: 0, outcome: "failed" });
  assert.equal(pushOutcome(404), "gone");
  assert.equal(pushOutcome(429), "failed");
  assert.equal(pushOutcome(500), "failed");
  assert.equal(pushOutcome(200), "ok");
});
