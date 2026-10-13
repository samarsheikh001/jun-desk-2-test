import assert from "node:assert/strict";
import { test } from "node:test";
import { systemPrompt } from "../ai/agent.ts";
import { NotSignedInError, parseConfig } from "../ai/config.ts";
import { buildRequest } from "../ai/tools.ts";
import { base64UrlEncode } from "./crypto.ts";
import { IdentityError, signIdentityToken, verifyIdentityToken } from "./identity.ts";

const SECRET = "jis_test_secret_value";
const now = Date.parse("2026-10-05T12:00:00Z");
const exp = Math.floor(now / 1000) + 3600;

test("a valid HS256 identity token verifies, with attributes cleaned", async () => {
  const token = await signIdentityToken(
    { sub: 42, email: "ada@acme.test", name: "Ada", exp, attributes: { plan: "pro", seats: 5, trial: false, nested: { no: 1 }, "bad key": "x" } },
    SECRET,
  );
  assert.deepEqual(await verifyIdentityToken(token, SECRET, now), {
    id: "42",
    email: "ada@acme.test",
    name: "Ada",
    attributes: { plan: "pro", seats: 5, trial: false },
    secrets: {},
    expiresAt: exp * 1000,
  });
});

test("AI-24: a token's secrets claim carries the user's own keys, kept apart from attributes", async () => {
  const token = await signIdentityToken({ sub: "42", exp, attributes: { plan: "pro" }, secrets: { API_TOKEN: "usr_tok_abcdef" } }, SECRET);
  const identity = await verifyIdentityToken(token, SECRET, now);
  assert.deepEqual(identity.secrets, { API_TOKEN: "usr_tok_abcdef" });
  assert.deepEqual(identity.attributes, { plan: "pro" }, "never among the attributes (shown to agents and the AI)");
  const reject = async (secrets: unknown, pattern: RegExp) =>
    assert.rejects(verifyIdentityToken(await signIdentityToken({ sub: "1", exp, secrets }, SECRET), SECRET, now), (e: Error) => e instanceof IdentityError && pattern.test(e.message));
  await reject({ api_token: "x" }, /UPPER_SNAKE_CASE/);
  await reject({ API_TOKEN: 5 }, /non-empty string/);
  await reject(["x"], /object/);
});

test("identity tokens are rejected when forged, expired, unsigned or incomplete", async () => {
  const reject = (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: Error) => e instanceof IdentityError && pattern.test(e.message));
  await reject(verifyIdentityToken(await signIdentityToken({ sub: "1", exp }, "another secret"), SECRET, now), /signature/);
  await reject(verifyIdentityToken(await signIdentityToken({ sub: "1", exp: Math.floor(now / 1000) - 120 }, SECRET), SECRET, now), /expired/);
  await reject(verifyIdentityToken(await signIdentityToken({ sub: "1" }, SECRET), SECRET, now), /exp/);
  await reject(verifyIdentityToken(await signIdentityToken({ exp }, SECRET), SECRET, now), /sub/);
  await reject(verifyIdentityToken(await signIdentityToken({ sub: "1", exp, nbf: exp }, SECRET), SECRET, now), /valid yet/);
  // alg: none, with or without a signature, never passes.
  const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
  await reject(verifyIdentityToken(`${enc({ alg: "none" })}.${enc({ sub: "1", exp })}.`, SECRET, now), /HS256/);
  await reject(verifyIdentityToken("not.a.jwt.at.all", SECRET, now), /Malformed/);
  // A tampered payload breaks the signature.
  const [h, , s] = (await signIdentityToken({ sub: "1", exp }, SECRET)).split(".");
  await reject(verifyIdentityToken(`${h}.${enc({ sub: "admin", exp })}.${s}`, SECRET, now), /signature/);
});

test("tools can use the verified customer, and refuse when nobody is signed in", () => {
  const { config, issues } = parseConfig({
    "AGENTS.md": "x",
    "tools/my_account.yaml": "description: The signed-in customer's account.\nurl: https://api.acme.test/accounts/{user.id}\nquery:\n  plan: '{user.plan}'\n",
    "tools/bad.yaml": "description: d\nurl: https://x.test/{user.}",
  });
  assert.deepEqual(issues.map((i) => i.path), ["tools/bad.yaml"]);
  const spec = config.tools[0]!;
  const user = { id: "u 1", email: "ada@acme.test", name: "Ada", attributes: { plan: "pro" } };
  assert.equal(buildRequest(spec, {}, () => undefined, user).url, "https://api.acme.test/accounts/u%201?plan=pro");
  assert.throws(() => buildRequest(spec, {}, () => undefined, null), NotSignedInError);
});

test("the prompt names a verified customer", () => {
  const prompt = systemPrompt({ workspaceName: "Acme", persona: "", hits: [], customer: { id: "42", name: "Ada", email: "ada@acme.test", attributes: { plan: "pro" } } });
  assert.match(prompt, /The customer is signed in; Acme's website verified who they are \(name: Ada; email: ada@acme\.test; user id: 42; plan: pro\)/);
  assert.doesNotMatch(systemPrompt({ workspaceName: "Acme", persona: "", hits: [] }), /signed in/);
});

test("widget domain restriction: cleaning, matching and the frame CSP", async () => {
  const { frameAncestors, normalizeDomains, originAllowed } = await import("./origins.ts");
  assert.deepEqual(normalizeDomains("https://www.Acme.com/pricing, *.acme.com acme.com:8080 localhost"), { domains: ["www.acme.com", "*.acme.com", "acme.com", "localhost"], invalid: [] });
  assert.deepEqual(normalizeDomains(["acme..com", "not a domain"]).invalid, ["acme..com", "not a domain"]);
  const desk = "https://desk.example.dev";
  const domains = ["acme.com", "*.shop.acme.com"];
  assert.equal(originAllowed("https://acme.com", domains, desk), true);
  assert.equal(originAllowed("https://www.acme.com", domains, desk), false, "exact unless *.");
  assert.equal(originAllowed("https://eu.shop.acme.com", domains, desk), true);
  assert.equal(originAllowed("https://shop.acme.com", domains, desk), true);
  assert.equal(originAllowed("https://acme.com.evil.test", domains, desk), false);
  assert.equal(originAllowed("https://evilacme.com", domains, desk), false);
  assert.equal(originAllowed(desk, domains, desk), true, "the desk's own demo page");
  assert.equal(originAllowed(undefined, domains, desk), false);
  assert.equal(originAllowed(undefined, [], desk), true, "no list: anywhere");
  assert.equal(frameAncestors([]), "frame-ancestors *");
  assert.equal(frameAncestors(["*.acme.com"]), "frame-ancestors 'self' https://*.acme.com:* http://*.acme.com:* https://acme.com:* http://acme.com:*");
});
