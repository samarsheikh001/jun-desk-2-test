import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUrl, describeEvents, describeTarget, isIssue, redact, sanitizeContext } from "./debug.ts";

// Built at runtime: a key-shaped literal trips GitHub push protection, which blocked the Deploy button's repo copy.
const FAKE_KEY = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

test("redact masks emails, tokens, keys, secrets and card-like numbers", () => {
  const out = redact(
    `user pat@customer.test failed: Bearer abc.def.ghi token=xyz123 password: hunter2 ${FAKE_KEY} card 4242 4242 4242 4242 jwt eyJhbGciOi.eyJzdWIiOi.SflKxwRJ`,
  );
  assert.doesNotMatch(out, /pat@customer\.test|hunter2|xyz123|4242 4242|sk_live_4eC|eyJhbGciOi/);
  assert.match(out, /\[email\]/);
  assert.match(out, /Bearer \[token\]/);
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /password: \[redacted\]/);
  assert.match(out, /\[key\]/);
  assert.match(out, /\[number\]/);
});

test("cleanUrl keeps paths but drops query values", () => {
  assert.equal(cleanUrl("https://app.acme.dev/billing?invoice=inv_2041&email=pat@x.dev#top", "https://app.acme.dev"), "/billing?invoice=…&email=…");
  assert.equal(cleanUrl("https://api.stripe.com/v1/charges?key=sk_live_x", "https://app.acme.dev"), "https://api.stripe.com/v1/charges?key=…");
  // Relative URLs (or no page origin known) never get an invented origin.
  assert.equal(cleanUrl("/api/billing?id=7"), "/api/billing?id=…");
  assert.equal(cleanUrl("/api/billing", undefined), "/api/billing");
});

test("sanitizeContext re-redacts, drops unknown fields and bad events, caps sizes", () => {
  const ctx = sanitizeContext({
    page: { url: "https://app.acme.dev/billing?token=secret", title: "Billing for pat@customer.test" },
    userAgent: "Mozilla/5.0",
    viewport: { w: 1280, h: 800 },
    language: "en-GB",
    timezone: "Europe/London",
    capturedAt: 1,
    cookies: "should be dropped",
    events: [
      { t: 2, kind: "network", method: "post", url: "https://app.acme.dev/api/billing?email=pat@x.dev", status: 500, durationMs: 231.7, body: "{secret}" },
      { t: 1, kind: "error", message: "Failed for pat@customer.test", source: "app.js:10", stack: "a\nb\nc\nd\ne\nf\ng" },
      { t: 3, kind: "keylogger", message: "nope" },
      "garbage",
    ],
  })!;
  assert.equal(ctx.page.url, "https://app.acme.dev/billing?token=…");
  assert.equal(ctx.page.title, "Billing for [email]");
  assert.equal((ctx as unknown as Record<string, unknown>).cookies, undefined);
  assert.equal(ctx.events.length, 2);
  assert.deepEqual(ctx.events[1], { t: 2, kind: "network", method: "POST", url: "/api/billing?email=…", status: 500, durationMs: 231 });
  assert.equal(ctx.events[0]!.message, "Failed for [email]");
  assert.equal(ctx.events[0]!.stack!.split("\n").length, 5);
  assert.equal(sanitizeContext("nope"), null);
});

test("issues are errors and failed requests; descriptions read well", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/x" },
    timezone: "UTC",
    events: [
      { t: Date.UTC(2026, 9, 4, 14, 2, 11), kind: "network", method: "POST", url: "https://a.dev/api/billing", status: 500, durationMs: 230 },
      { t: Date.UTC(2026, 9, 4, 14, 1, 0), kind: "navigation", url: "https://a.dev/billing" },
      { t: Date.UTC(2026, 9, 4, 14, 3, 0), kind: "network", method: "GET", url: "https://a.dev/api/me", status: 304 },
    ],
  })!;
  assert.deepEqual(ctx.events.map(isIssue), [false, true, false]);
  assert.deepEqual(describeEvents(ctx), [
    "[14:01:00] Visited /billing",
    "[14:02:11] POST /api/billing → HTTP 500 in 230 ms",
    "[14:03:00] GET /api/me → HTTP 304",
  ]);
});

test("S-12 app errors: message masked and capped, code [\\w.-] only, nothing else kept; an issue", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/import" },
    timezone: "UTC",
    events: [
      { t: Date.UTC(2026, 9, 5, 9, 0, 0), kind: "app_error", message: "  Row 42: missing email for pat@customer.test (token=abc123)  ", code: "import.row_invalid", stack: "x", url: "https://a.dev/secret?q=1", status: 500 },
      { t: 2, kind: "app_error", message: "x".repeat(5000), code: "bad code!/<script>" + "y".repeat(100) },
      { t: 3, kind: "app_error", message: "Card 4242 4242 4242 4242 declined", code: FAKE_KEY },
      { t: 4, kind: "app_error", message: "   " },
      { t: 5, kind: "app_error", message: { toString: () => "object" } },
      { t: 6, kind: "app_error", message: "No code", code: 42 },
    ],
  })!;
  assert.equal(ctx.events.length, 4);
  assert.deepEqual(ctx.events.at(-1), { t: Date.UTC(2026, 9, 5, 9, 0, 0), kind: "app_error", message: "Row 42: missing email for [email] (token=[redacted])", code: "import.row_invalid" });
  const long = ctx.events.find((e) => e.t === 2)!;
  assert.equal(long.message!.length, 300);
  assert.match(long.code!, /^[\w.-]{1,60}$/);
  assert.ok(long.code!.startsWith("badcodescript"));
  const card = ctx.events.find((e) => e.t === 3)!;
  assert.match(card.message!, /^Card \[number\] ?declined$/);
  assert.equal(card.code, "key");
  assert.deepEqual(ctx.events.find((e) => e.t === 6), { t: 6, kind: "app_error", message: "No code" });
  assert.ok(ctx.events.every(isIssue));
  assert.equal(describeEvents(ctx).at(-1), "[09:00:00] The app reported an error: Row 42: missing email for [email] (token=[redacted])", "the live AI never sees the code");
  assert.equal(describeEvents(ctx, { codes: true }).at(-1), "[09:00:00] The app reported an error: Row 42: missing email for [email] (token=[redacted]) (code import.row_invalid)");
  assert.equal(describeEvents({ ...ctx, events: [{ t: 0, kind: "app_error", message: "Upload too big" }] })[0], "[00:00:00] The app reported an error: Upload too big");
});

test("S-02 rage clicks: only the safe target fields, masked and capped; text only for buttons and links; an issue", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/settings" },
    timezone: "UTC",
    events: [
      {
        t: Date.UTC(2026, 9, 5, 9, 0, 0),
        kind: "rage_click",
        count: 5,
        target: { tag: "BUTTON", id: "save-pat@customer.test", label: "Save   changes", name: "token=abc123", role: "Button", text: " Save\n changes ", value: "hunter2", html: "<b>x</b>" },
        message: "dropped",
        url: "https://a.dev/secret?q=1",
      },
      // Text of a non-button element is never kept; nor a long label.
      { t: 2, kind: "rage_click", count: 3, target: { tag: "div", text: "Pat Smith, 12 Main Street" } },
      { t: 3, kind: "rage_click", count: 3, target: { tag: "a", text: "x".repeat(41) } },
      { t: 4, kind: "rage_click", count: 3, target: { tag: "span", role: "button", text: "Export 4242 4242 4242 4242" } },
      { t: 5, kind: "rage_click", count: 9999, target: { tag: "a", text: "Billing" } },
      // Unusable targets are dropped.
      { t: 6, kind: "rage_click", count: 3, target: { tag: "<script>" } },
      { t: 7, kind: "rage_click", count: 3 },
    ],
  })!;
  assert.equal(ctx.events.length, 5);
  assert.deepEqual(ctx.events.at(-1), {
    t: Date.UTC(2026, 9, 5, 9, 0, 0),
    kind: "rage_click",
    target: { tag: "button", id: "[email]", label: "Save changes", name: "token=[redacted]", role: "button", text: "Save changes" },
    count: 5,
  });
  assert.deepEqual(ctx.events.find((e) => e.t === 2)!.target, { tag: "div" });
  assert.deepEqual(ctx.events.find((e) => e.t === 3)!.target, { tag: "a" });
  assert.equal(ctx.events.find((e) => e.t === 4)!.target!.text, "Export [number]");
  assert.equal(ctx.events.find((e) => e.t === 5)!.count, 100);
  assert.ok(ctx.events.every(isIssue));
  assert.equal(
    describeEvents(ctx).at(-1),
    '[09:00:00] Clicked button#[email][role=button][name=token=[redacted]] (Save changes) "Save changes" 5 times in quick succession; the page didn\'t change',
  );
  assert.equal(describeTarget({ tag: "a", text: "Billing" }), 'a "Billing"');
});

test("S-13 stuck: page path only, seconds, issue kind; not an issue itself", () => {
  const ctx = sanitizeContext({
    page: { url: "https://a.dev/import?file=pat@customer.test" },
    timezone: "UTC",
    events: [
      { t: Date.UTC(2026, 9, 5, 9, 3, 0), kind: "stuck", url: "/import/pat@customer.test?file=x#top", seconds: 183.6, issue: "network", message: "dropped", target: { tag: "a" } },
      { t: 2, kind: "stuck", url: "https://a.dev/billing", seconds: -5, issue: "navigation" },
      { t: 3, kind: "stuck", seconds: 1e9, issue: "rage_click" },
    ],
  })!;
  assert.equal(ctx.events.length, 3);
  assert.deepEqual(ctx.events.at(-1), { t: Date.UTC(2026, 9, 5, 9, 3, 0), kind: "stuck", url: "/import/[email]", seconds: 183, issue: "network" });
  assert.deepEqual(ctx.events.find((e) => e.t === 2), { t: 2, kind: "stuck", url: "/billing", seconds: 0 });
  assert.equal(ctx.events.find((e) => e.t === 3)!.seconds, 86_400);
  assert.ok(!ctx.events.some(isIssue));
  assert.equal(describeEvents(ctx).at(-1), "[09:03:00] Still on /import/[email] after 3 min since a failed request, with no successful form submit");
});
