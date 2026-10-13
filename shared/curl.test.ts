import { test } from "node:test";
import assert from "node:assert/strict";
import { curlActionName, keyName, looksLikeCurl, parseCurl, shellWords } from "./curl.ts";

test("shellWords: quotes, escapes and line continuations", () => {
  assert.deepEqual(shellWords(`curl -H 'A: b c' \\\n  "https://x.io/a?q=1" -d "{\\"a\\":1}"`), ["curl", "-H", "A: b c", "https://x.io/a?q=1", "-d", '{"a":1}']);
  assert.deepEqual(shellWords("curl ^\r\n  https://x.io"), ["curl", "https://x.io"]);
});

test("a GET with a bearer key: the key leaves the file and is kept by name", () => {
  const r = parseCurl(`curl https://api.acme.com/v1/orders/1042?expand=items -H "Authorization: Bearer sk_live_abc123456" -H "Accept: application/json"`);
  assert.equal(r.method, "GET");
  assert.equal(r.url, "https://api.acme.com/v1/orders/1042");
  assert.deepEqual(r.query, { expand: "items" });
  assert.deepEqual(r.headers, { Authorization: "Bearer {secrets.ACME_API_KEY}" });
  assert.deepEqual(r.keys, [{ name: "ACME_API_KEY", value: "sk_live_abc123456" }]);
});

test("a POST with a JSON body, an x-api-key stand-in and {placeholders} in the address", () => {
  const r = parseCurl(`curl -X POST 'https://api.shop.io/orders/{order_id}/refund' -H 'x-api-key: $SHOP_KEY' -H 'Content-Type: application/json' --data-raw '{"amount": 10, "reason": "late"}'`);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.shop.io/orders/{order_id}/refund");
  assert.deepEqual(r.headers, { "x-api-key": "{secrets.SHOP_KEY}" });
  assert.deepEqual(r.keys, [{ name: "SHOP_KEY", value: null }]);
  assert.deepEqual(r.body, { amount: 10, reason: "late" });
});

test("data makes a POST; PUT becomes POST with a note; keys in the query are dropped with a note", () => {
  assert.equal(parseCurl("curl https://a.io/x -d a=1&b=two+words").method, "POST");
  assert.deepEqual(parseCurl("curl https://a.io/x -d 'a=1&b=two+words'").body, { a: "1", b: "two words" });
  const put = parseCurl("curl -X PUT https://a.io/x?api_key=123&limit=5");
  assert.equal(put.method, "POST");
  assert.deepEqual(put.query, { limit: "5" });
  assert.equal(put.notes.length, 2);
  assert.deepEqual(parseCurl("curl -G https://a.io/s -d q=mug").query, { q: "mug" });
});

test("-u becomes a Basic header with its own key", () => {
  const r = parseCurl("curl -u sk_test_123: https://api.stripe.com/v1/customers");
  assert.deepEqual(r.headers, { Authorization: "Basic {secrets.STRIPE_BASIC_AUTH}" });
  assert.equal(r.keys[0]!.value, btoa("sk_test_123:"));
});

test("not a curl command, or no address", () => {
  assert.throws(() => parseCurl("wget https://a.io"), /curl/);
  assert.throws(() => parseCurl("curl -s"), /address/);
  assert.ok(looksLikeCurl("  curl https://a.io"));
  assert.ok(!looksLikeCurl("GET /orders/{id}"));
  assert.equal(keyName("https://api.acme.com/x"), "ACME_API_KEY");
  assert.equal(keyName("nope"), "API_KEY");
});

test("AI-27: an action's name from its curl command", () => {
  assert.equal(curlActionName({ method: "GET", url: "https://api.acme.com/v1/orders/1042" }), "look_up_order");
  assert.equal(curlActionName({ method: "POST", url: "https://api.acme.com/orders/{id}/refund" }), "refund_order");
  assert.equal(curlActionName({ method: "POST", url: "https://api.acme.com/tickets" }), "create_ticket");
  assert.equal(curlActionName({ method: "GET", url: "https://api.acme.com/categories" }), "look_up_category");
  assert.equal(curlActionName({ method: "GET", url: "https://api.acme.com/" }), "look_up");
});
