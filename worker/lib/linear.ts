// S-08: the two Linear GraphQL calls the desk makes. `fetch` is passed in so tests can check
// the exact requests without touching Linear. The key comes only from the Worker secret
// LINEAR_API_KEY (routes/issues.ts) and is never stored or returned.

export const LINEAR_API_DEFAULT = "https://api.linear.app/graphql";

export interface LinearClient {
  /** A Linear personal API key. Sent as-is: personal keys don't take "Bearer". */
  apiKey: string;
  /** LINEAR_API_URL (tests), default https://api.linear.app/graphql. */
  apiUrl: string;
  fetch: typeof fetch;
}

/** Linear said no; `message` is written for the agent. */
export class LinearError extends Error {
  readonly status: number;
  readonly authFailed: boolean;
  constructor(status: number, message: string, authFailed = false) {
    super(message);
    this.status = status;
    this.authFailed = authFailed;
  }
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

const BAD_KEY = "Linear rejected the API key. Check the LINEAR_API_KEY secret (a personal API key from Linear → Settings → Security & access).";

/** One GraphQL request. Throws LinearError for HTTP failures and GraphQL `errors` (Linear answers those with 200 or 400). */
async function graphql<T>(client: LinearClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await client.fetch(client.apiUrl, {
      method: "POST",
      headers: { Authorization: client.apiKey, "Content-Type": "application/json", "User-Agent": "jun-desk" },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new LinearError(0, `Couldn't reach Linear: ${(error as Error).message}`);
  }
  const json = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message?: string; extensions?: { code?: string; type?: string; userPresentableMessage?: string } }[] };
  const errors = Array.isArray(json.errors) ? json.errors : [];
  const auth = response.status === 401 || errors.some((e) => /AUTHENTICATION|UNAUTHENTICATED/i.test(`${e.extensions?.code ?? ""} ${e.extensions?.type ?? ""}`) || /authenticat/i.test(e.message ?? ""));
  if (auth) throw new LinearError(response.status, BAD_KEY, true);
  if (errors.length) {
    const said = errors.map((e) => e.extensions?.userPresentableMessage || e.message).filter(Boolean).join("; ") || "no details";
    throw new LinearError(response.status, `Linear couldn't do that (${said}).`);
  }
  if (!response.ok || !json.data) throw new LinearError(response.status, `Linear returned ${response.status}.`);
  return json.data;
}

export type LinearCheck =
  | { ok: true; viewer: string; teams: LinearTeam[] }
  | { ok: false; reason: "bad_key" | "error"; message: string };

/** "Test connection": who the key belongs to, and the teams it can file into. */
export async function checkLinear(client: LinearClient): Promise<LinearCheck> {
  try {
    const data = await graphql<{ viewer: { name: string }; teams: { nodes: LinearTeam[] } }>(client, "query { viewer { name } teams { nodes { id key name } } }");
    return { ok: true, viewer: data.viewer.name, teams: data.teams.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name })) };
  } catch (error) {
    const e = error as LinearError;
    return { ok: false, reason: e.authFailed ? "bad_key" : "error", message: e.message };
  }
}

export interface CreatedLinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
}

const CREATE = "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }";

// S-14: screenshots go to Linear's own storage, so they're private to the Linear workspace.
// Documented flow (https://linear.app/developers/how-to-upload-a-file-to-linear, the
// `fileUpload` mutation in Linear's schema): ask for an upload URL, PUT the bytes there from the
// server (Linear's CSP blocks browser uploads) with Content-Type, Cache-Control and every header
// Linear returned, then reference `assetUrl` as a Markdown image in the description.
const FILE_UPLOAD =
  "mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }";

/** Uploads one file to Linear's storage and returns its asset URL. Throws LinearError. The API key never goes to the upload URL. */
export async function uploadLinearFile(client: LinearClient, file: { name: string; type: string; bytes: ArrayBuffer }): Promise<string> {
  const data = await graphql<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } | null }>(client, FILE_UPLOAD, {
    contentType: file.type,
    filename: file.name,
    size: file.bytes.byteLength,
  });
  const upload = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !upload || typeof upload.uploadUrl !== "string" || typeof upload.assetUrl !== "string") {
    throw new LinearError(200, "Linear didn't accept the upload (success: false).");
  }
  const headers = new Headers({ "Content-Type": file.type, "Cache-Control": "public, max-age=31536000" });
  for (const h of Array.isArray(upload.headers) ? upload.headers : []) {
    if (h && typeof h.key === "string" && typeof h.value === "string") headers.set(h.key, h.value);
  }
  let response: Response;
  try {
    response = await client.fetch(upload.uploadUrl, { method: "PUT", headers, body: file.bytes, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new LinearError(0, `Couldn't upload to Linear: ${(error as Error).message}`);
  }
  await response.body?.cancel();
  if (!response.ok) throw new LinearError(response.status, `Linear's storage refused the upload (${response.status}).`);
  return upload.assetUrl;
}

/** issueCreate. `description` is Markdown (Linear renders it). Throws LinearError with a message for the agent. */
export async function createLinearIssue(client: LinearClient, input: { teamId: string; title: string; description: string }): Promise<CreatedLinearIssue> {
  const data = await graphql<{ issueCreate: { success: boolean; issue: CreatedLinearIssue | null } }>(client, CREATE, {
    input: { teamId: input.teamId, title: input.title, description: input.description },
  });
  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue) throw new LinearError(200, "Linear didn't create the issue (success: false).");
  return { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title };
}
