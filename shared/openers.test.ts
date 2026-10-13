import assert from "node:assert/strict";
import { test } from "node:test";
import { forLoader, matchesPath, parseOpeners, patternError, patternRegex, storedOpeners } from "./openers.ts";

test("page patterns: exact, under a folder, suffix, everything", () => {
  assert.ok(matchesPath("/pricing", "/pricing"));
  assert.ok(matchesPath("/pricing", "/pricing/"), "a trailing slash on the page doesn't matter");
  assert.ok(matchesPath("/pricing/", "/pricing"));
  assert.ok(!matchesPath("/pricing", "/pricing/teams"));
  assert.ok(!matchesPath("/pricing", "/en/pricing"));
  assert.ok(!matchesPath("/pricing", "/Pricing"), "case-sensitive, like paths");

  assert.ok(matchesPath("/docs/*", "/docs"), "/docs/* includes /docs itself");
  assert.ok(matchesPath("/docs/*", "/docs/"));
  assert.ok(matchesPath("/docs/*", "/docs/api/auth"));
  assert.ok(!matchesPath("/docs/*", "/docsearch"));

  assert.ok(matchesPath("*/billing", "/settings/billing"));
  assert.ok(matchesPath("*/billing", "/billing"));
  assert.ok(!matchesPath("*/billing", "/billing/history"));
  assert.ok(matchesPath("/app/*/settings", "/app/acme/team/settings"));

  assert.ok(matchesPath("*", "/"));
  assert.ok(matchesPath("*", "/anything/at/all"));
  assert.ok(matchesPath("/", "/"));
  assert.ok(!matchesPath("/", "/pricing"));
});

test("page patterns: regex characters are literal", () => {
  assert.equal(patternRegex("/a.b"), "^/a\\.b/?$");
  assert.ok(!matchesPath("/a.b", "/axb"));
  assert.ok(matchesPath("/v1+(beta)", "/v1+(beta)"));
  assert.ok(matchesPath("/docs/**", "/docs/x"), "repeated stars are one star");
  assert.equal(patternRegex("/docs/*"), "^/docs(/.*)?$");
  // The loader runs the regex source as-is.
  for (const p of ["/pricing", "/docs/*", "*/billing", "*", "/", "/a|b", "/[x]"]) assert.doesNotThrow(() => new RegExp(patternRegex(p)));
});

test("page patterns: validation", () => {
  assert.equal(patternError("/pricing"), null);
  assert.equal(patternError("*/billing"), null);
  assert.match(patternError("")!, /Enter a page path/);
  assert.match(patternError("pricing")!, /must start with/);
  assert.match(patternError("https://acme.com/pricing")!, /must start with/);
  assert.match(patternError("/pricing?plan=pro")!, /\?/);
  assert.match(patternError("/pricing#teams")!, /#/);
  assert.match(patternError("/my page")!, /spaces/);
  assert.match(patternError("/prix/é")!, /characters/);
  assert.match(patternError(`/${"a".repeat(200)}`)!, /at most 200/);
});

let n = 0;
const id = () => `op_test${++n}`;

test("opener rules: valid input is normalised, ids kept or made", () => {
  const rules = parseOpeners(
    [
      { id: "op_keepme12", path: " /pricing ", delay: 20, text: "  Comparing   plans? Happy to help. " },
      { path: "/docs/*", delay: 60, text: null, hint: "  help finding the right guide " },
      { id: "op_keepme12", path: "*", delay: 5, hint: "" }, // duplicate id gets a new one
      { id: "bad id", path: "/x", delay: 600, text: "Hi", hint: "ignored with fixed text" },
    ],
    id,
  );
  assert.deepEqual(rules, [
    { id: "op_keepme12", path: "/pricing", delay: 20, text: "Comparing plans? Happy to help." },
    { id: "op_test1", path: "/docs/*", delay: 60, text: null, hint: "help finding the right guide" },
    { id: "op_test2", path: "*", delay: 5, text: null },
    { id: "op_test3", path: "/x", delay: 600, text: "Hi" },
  ]);
  assert.deepEqual(parseOpeners([], id), []);
});

test("opener rules: invalid input says what's wrong", () => {
  const bad = (raw: unknown, message: RegExp) => assert.throws(() => parseOpeners(raw, id), message);
  bad({}, /must be a list/);
  bad(Array.from({ length: 11 }, () => ({ path: "/", delay: 10 })), /At most 10/);
  bad([{ path: "pricing", delay: 10 }], /Opener 1: .*must start with/);
  bad([{ path: "/", delay: 10 }, { path: "/", delay: 4 }], /Opener 2: the delay must be a whole number of seconds from 5 to 600/);
  bad([{ path: "/", delay: 601 }], /from 5 to 600/);
  bad([{ path: "/", delay: 10.5 }], /whole number/);
  bad([{ path: "/", delay: "10" }], /whole number/);
  bad([{ path: "/", delay: 10, text: "   " }], /write a message/);
  bad([{ path: "/", delay: 10, text: 5 }], /must be text/);
  bad([{ path: "/", delay: 10, text: "x".repeat(141) }], /at most 140/);
  bad([{ path: "/", delay: 10, hint: "x".repeat(201) }], /at most 200/);
});

test("opener rules: stored rules are read leniently; the loader gets regex, delay and id only", () => {
  const stored = [{ id: "op_good1234", path: "/pricing", delay: 30, text: null, hint: "plan help" }, { id: "op_bad12345", path: "nope", delay: 30 }, "junk", { path: "/no-id", delay: 30 }];
  const rules = storedOpeners(stored);
  assert.deepEqual(rules.map((r) => r.id), ["op_good1234"]);
  assert.deepEqual(storedOpeners(undefined), []);
  assert.deepEqual(forLoader(rules), [{ id: "op_good1234", match: "^/pricing/?$", delay: 30 }]);
});
