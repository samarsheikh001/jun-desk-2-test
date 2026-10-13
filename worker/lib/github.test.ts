import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRepo, createIssue, GitHubError, type GitHubClient } from "./github.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records the request and answers like GitHub would. */
function fakeGitHub(status: number, json: unknown): { client: GitHubClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { client: { token: "github_pat_TEST", apiUrl: "https://api.github.com/", fetch: fetchFn }, seen };
}

// Trimmed from a real `POST /repos/{owner}/{repo}/issues` 201 response.
const CREATED = {
  id: 1,
  node_id: "MDU6SXNzdWUx",
  url: "https://api.github.com/repos/acme/web-app/issues/1347",
  repository_url: "https://api.github.com/repos/acme/web-app",
  html_url: "https://github.com/acme/web-app/issues/1347",
  number: 1347,
  state: "open",
  title: "Invoice payment fails with HTTP 500",
  body: "## Summary …",
  user: { login: "octocat", id: 1 },
  labels: [{ id: 208045946, name: "bug", color: "f29513", default: true }],
  created_at: "2026-10-05T14:02:11Z",
};

test("createIssue sends the documented request and returns the number and link", async () => {
  const { client, seen } = fakeGitHub(201, CREATED);
  const issue = await createIssue(client, "acme/web-app", { title: "Invoice payment fails with HTTP 500", body: "## Summary …", labels: ["bug"] });
  assert.deepEqual(issue, { number: 1347, url: "https://github.com/acme/web-app/issues/1347" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://api.github.com/repos/acme/web-app/issues");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.headers.authorization, "Bearer github_pat_TEST");
  assert.equal(seen[0]!.headers.accept, "application/vnd.github+json");
  assert.equal(seen[0]!.headers["x-github-api-version"], "2022-11-28");
  assert.equal(seen[0]!.headers["user-agent"], "jun-desk");
  assert.equal(seen[0]!.headers["content-type"], "application/json");
  assert.deepEqual(seen[0]!.body, { title: "Invoice payment fails with HTTP 500", body: "## Summary …", labels: ["bug"] });

  // No labels: the field is left out (GitHub would otherwise need push access).
  const second = fakeGitHub(201, CREATED);
  await createIssue(second.client, "acme/web-app", { title: "t", body: "b", labels: [] });
  assert.deepEqual(second.seen[0]!.body, { title: "t", body: "b" });
});

test("createIssue maps GitHub's errors to messages an agent can act on", async () => {
  const cases: [number, unknown, RegExp][] = [
    [401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, /rejected the token \(Bad credentials\).*GITHUB_TOKEN/],
    [403, { message: "Resource not accessible by personal access token" }, /Resource not accessible.*Issues: Read and write on acme\/web-app/],
    [404, { message: "Not Found" }, /can't find acme\/web-app/],
    [410, { message: "Issues are disabled for this repo" }, /turned off/],
    [422, { message: "Validation Failed", errors: [{ resource: "Issue", code: "custom", field: "title", message: "title is too long (maximum is 256 characters)" }] }, /Validation Failed: title is too long/],
  ];
  for (const [status, json, expected] of cases) {
    const { client } = fakeGitHub(status, json);
    await assert.rejects(createIssue(client, "acme/web-app", { title: "t", body: "b", labels: [] }), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      return true;
    });
  }
  // An echo server (or a wrong GITHUB_API_URL) answers 200 without an issue.
  const echo = fakeGitHub(200, { method: "POST", url: "https://httpbin.org/anything" });
  await assert.rejects(createIssue(echo.client, "acme/web-app", { title: "t", body: "b", labels: [] }), /no issue number/);
  // Network failure.
  const down: GitHubClient = { token: "x", apiUrl: "https://api.github.com", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
  await assert.rejects(createIssue(down, "acme/web-app", { title: "t", body: "b", labels: [] }), (e: unknown) => e instanceof GitHubError && e.status === 0 && /Couldn't reach GitHub/.test(e.message));
});

test("checkRepo: ok, bad token, not found, forbidden", async () => {
  const ok = fakeGitHub(200, { full_name: "acme/web-app", private: true, has_issues: true });
  assert.deepEqual(await checkRepo(ok.client, "acme/web-app"), { ok: true, fullName: "acme/web-app", private: true, hasIssues: true });
  assert.equal(ok.seen[0]!.url, "https://api.github.com/repos/acme/web-app");
  assert.equal(ok.seen[0]!.method, "GET");
  assert.equal(ok.seen[0]!.body, undefined);
  assert.equal(ok.seen[0]!.headers["content-type"], undefined);

  const noIssues = await checkRepo(fakeGitHub(200, { full_name: "acme/web-app", has_issues: false }).client, "acme/web-app");
  assert.deepEqual(noIssues, { ok: true, fullName: "acme/web-app", private: false, hasIssues: false });
  const results = await Promise.all([
    checkRepo(fakeGitHub(401, { message: "Bad credentials" }).client, "acme/web-app"),
    checkRepo(fakeGitHub(404, { message: "Not Found" }).client, "acme/web-app"),
    checkRepo(fakeGitHub(403, { message: "API rate limit exceeded" }).client, "acme/web-app"),
  ]);
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.reason)), ["bad_token", "not_found", "forbidden"]);
  assert.match(results[2]!.ok ? "" : results[2]!.message, /API rate limit exceeded/);
});
