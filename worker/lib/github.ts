// S-08: the few GitHub REST calls the desk makes. `fetch` is passed in so tests can check the
// exact requests without touching GitHub. The token comes only from the Worker secret
// GITHUB_TOKEN (routes/issues.ts) and is never stored or returned.

export const GITHUB_API_DEFAULT = "https://api.github.com";

export interface GitHubClient {
  token: string;
  /** GITHUB_API_URL (GitHub Enterprise Server, tests), default https://api.github.com. */
  apiUrl: string;
  fetch: typeof fetch;
}

/** GitHub said no; `message` is written for the agent. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call(client: GitHubClient, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await client.fetch(`${client.apiUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${client.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jun-desk",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GitHubError(0, `Couldn't reach GitHub: ${(error as Error).message}`);
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

const path = (repo: string) => `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

/** GitHub's own words, plus validation details for a 422. */
function githubMessage(json: Record<string, unknown>): string {
  const message = typeof json.message === "string" ? json.message : "";
  const details = Array.isArray(json.errors)
    ? json.errors
        .map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? (e as Record<string, unknown>).code ?? "") : ""))
        .filter(Boolean)
        .join("; ")
    : "";
  return [message, details].filter(Boolean).join(": ") || "no details";
}

/** A message for the agent for a failed GitHub call. */
export function describeGitHubError(status: number, json: Record<string, unknown>, repo: string): string {
  const said = githubMessage(json);
  if (status === 401) return `GitHub rejected the token (${said}). Check the GITHUB_TOKEN secret.`;
  if (status === 403) return `GitHub refused (${said}). The token needs Issues: Read and write on ${repo}.`;
  if (status === 404) return `GitHub can't find ${repo} with this token (${said}). Check the repository name, and that the fine-grained token includes this repository.`;
  if (status === 410) return `Issues are turned off for ${repo} (${said}).`;
  if (status === 422) return `GitHub couldn't create the issue (${said}).`;
  return `GitHub returned ${status} (${said}).`;
}

export type RepoCheck =
  | { ok: true; fullName: string; private: boolean; hasIssues: boolean }
  | { ok: false; reason: "bad_token" | "not_found" | "forbidden" | "error"; message: string };

/** "Test connection": can this token see the repo? (GitHub has no way to check write access without writing.) */
export async function checkRepo(client: GitHubClient, repo: string): Promise<RepoCheck> {
  let result: { status: number; json: Record<string, unknown> };
  try {
    result = await call(client, "GET", path(repo));
  } catch (error) {
    return { ok: false, reason: "error", message: (error as Error).message };
  }
  const { status, json } = result;
  if (status === 200) return { ok: true, fullName: String(json.full_name ?? repo), private: json.private === true, hasIssues: json.has_issues !== false };
  const reason = status === 401 ? "bad_token" : status === 404 ? "not_found" : status === 403 ? "forbidden" : "error";
  return { ok: false, reason, message: describeGitHubError(status, json, repo) };
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/** POST /repos/:owner/:repo/issues. Throws GitHubError with a message for the agent. */
export async function createIssue(client: GitHubClient, repo: string, input: { title: string; body: string; labels: string[] }): Promise<CreatedIssue> {
  const { status, json } = await call(client, "POST", `${path(repo)}/issues`, {
    title: input.title,
    body: input.body,
    ...(input.labels.length ? { labels: input.labels } : {}),
  });
  if (status !== 201 && status !== 200) throw new GitHubError(status, describeGitHubError(status, json, repo));
  if (typeof json.number !== "number" || typeof json.html_url !== "string") {
    throw new GitHubError(status, "GitHub's answer had no issue number or link. Is GITHUB_API_URL pointing at the GitHub API?");
  }
  return { number: json.number, url: json.html_url };
}
