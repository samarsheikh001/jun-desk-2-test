import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinear, createLinearIssue, LinearError, uploadLinearFile, type LinearClient } from "./linear.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { query: string; variables?: Record<string, unknown> };
}

/** A fetch that records the request and answers like Linear would. */
function fakeLinear(status: number, json: unknown): { client: LinearClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { client: { apiKey: "lin_api_TEST", apiUrl: "https://api.linear.app/graphql", fetch: fetchFn }, seen };
}

// Shaped like a real issueCreate response.
const CREATED = {
  data: {
    issueCreate: {
      success: true,
      issue: { id: "9cfb482a-81e3-4154-b5b9-2c805e70a02d", identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42/invoice-payment-fails", title: "Invoice payment fails" },
    },
  },
};

test("createLinearIssue sends the documented mutation with the key as-is (no Bearer)", async () => {
  const { client, seen } = fakeLinear(200, CREATED);
  const issue = await createLinearIssue(client, { teamId: "team-uuid", title: "Invoice payment fails", description: "## Summary\n…" });
  assert.deepEqual(issue, CREATED.data.issueCreate.issue);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://api.linear.app/graphql");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.headers.authorization, "lin_api_TEST");
  assert.doesNotMatch(seen[0]!.headers.authorization!, /bearer/i);
  assert.equal(seen[0]!.headers["content-type"], "application/json");
  assert.equal(seen[0]!.body.query, "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }");
  assert.deepEqual(seen[0]!.body.variables, { input: { teamId: "team-uuid", title: "Invoice payment fails", description: "## Summary\n…" } });
});

test("createLinearIssue: GraphQL errors, success false, bad key, network", async () => {
  // Linear answers validation problems with HTTP 200 (or 400) and an `errors` array.
  const invalid = fakeLinear(200, {
    errors: [{ message: "Argument Validation Error", extensions: { code: "INVALID_INPUT", userPresentableMessage: "teamId must be a UUID." } }],
    data: null,
  });
  await assert.rejects(createLinearIssue(invalid.client, { teamId: "x", title: "t", description: "d" }), (e: unknown) => e instanceof LinearError && /teamId must be a UUID/.test(e.message) && !e.authFailed);

  const notCreated = fakeLinear(200, { data: { issueCreate: { success: false, issue: null } } });
  await assert.rejects(createLinearIssue(notCreated.client, { teamId: "x", title: "t", description: "d" }), /success: false/);

  for (const [status, json] of [
    [400, { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" } }] }],
    [401, {}],
  ] as const) {
    const { client } = fakeLinear(status, json);
    await assert.rejects(createLinearIssue(client, { teamId: "x", title: "t", description: "d" }), (e: unknown) => e instanceof LinearError && e.authFailed && /rejected the API key.*LINEAR_API_KEY/.test(e.message));
  }

  const down: LinearClient = { apiKey: "x", apiUrl: "https://api.linear.app/graphql", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
  await assert.rejects(createLinearIssue(down, { teamId: "x", title: "t", description: "d" }), /Couldn't reach Linear/);
});

test("checkLinear loads the viewer and the teams", async () => {
  const { client, seen } = fakeLinear(200, {
    data: { viewer: { name: "Nina" }, teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "SUP", name: "Support" }] } },
  });
  assert.deepEqual(await checkLinear(client), { ok: true, viewer: "Nina", teams: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "SUP", name: "Support" }] });
  assert.equal(seen[0]!.body.query, "query { viewer { name } teams { nodes { id key name } } }");
  assert.equal(seen[0]!.body.variables, undefined);
  const bad = await checkLinear(fakeLinear(401, {}).client);
  assert.deepEqual(bad.ok ? null : bad.reason, "bad_key");
  const broken = await checkLinear(fakeLinear(500, {}).client);
  assert.deepEqual(broken.ok ? null : [broken.reason, broken.message], ["error", "Linear returned 500."]);
});

// ---------- S-14: fileUpload ----------

interface Raw {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers the GraphQL call with `graphql`, the PUT with `putStatus`; records both. */
function fakeUpload(graphqlJson: unknown, putStatus = 200): { client: LinearClient; seen: Raw[] } {
  const seen: Raw[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ url: String(input), method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: method === "PUT" ? init?.body : JSON.parse(String(init?.body)) });
    if (method === "PUT") return new Response(null, { status: putStatus });
    return new Response(JSON.stringify(graphqlJson), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { client: { apiKey: "lin_api_TEST", apiUrl: "https://api.linear.app/graphql", fetch: fetchFn }, seen };
}

const UPLOAD = {
  data: {
    fileUpload: {
      success: true,
      uploadFile: {
        uploadUrl: "https://storage.googleapis.com/linear-uploads/abc?X-Goog-Signature=sig",
        assetUrl: "https://uploads.linear.app/ws/abc/screenshot.png",
        headers: [
          { key: "x-goog-content-length-range", value: "4,4" },
          { key: "Content-Disposition", value: 'attachment; filename="screenshot.png"' },
        ],
      },
    },
  },
};

test("uploadLinearFile: fileUpload mutation, then a PUT with exactly Linear's headers (never the API key)", async () => {
  const { client, seen } = fakeUpload(UPLOAD);
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const assetUrl = await uploadLinearFile(client, { name: "screenshot.png", type: "image/png", bytes });
  assert.equal(assetUrl, "https://uploads.linear.app/ws/abc/screenshot.png");
  assert.equal(seen.length, 2);
  const [gql, put] = seen as [Raw, Raw];
  assert.equal(gql.url, "https://api.linear.app/graphql");
  assert.equal(gql.headers.authorization, "lin_api_TEST");
  assert.deepEqual(gql.body, {
    query:
      "mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
    variables: { contentType: "image/png", filename: "screenshot.png", size: 4 },
  });
  assert.equal(put.url, UPLOAD.data.fileUpload.uploadFile.uploadUrl);
  assert.equal(put.method, "PUT");
  assert.deepEqual(put.headers, {
    "content-type": "image/png",
    "cache-control": "public, max-age=31536000",
    "x-goog-content-length-range": "4,4",
    "content-disposition": 'attachment; filename="screenshot.png"',
  });
  assert.equal(put.body, bytes);
});

test("uploadLinearFile: success false, a refused PUT and GraphQL errors throw LinearError", async () => {
  const file = { name: "a.png", type: "image/png", bytes: new ArrayBuffer(1) };
  await assert.rejects(uploadLinearFile(fakeUpload({ data: { fileUpload: { success: false, uploadFile: null } } }).client, file), (e: unknown) => e instanceof LinearError && /success: false/.test(e.message));
  const refused = fakeUpload(UPLOAD, 403);
  await assert.rejects(uploadLinearFile(refused.client, file), (e: unknown) => e instanceof LinearError && e.status === 403 && /refused the upload/.test(e.message));
  await assert.rejects(uploadLinearFile(fakeUpload({ errors: [{ message: "File too large" }], data: null }).client, file), /File too large/);
});
