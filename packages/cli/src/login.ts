import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { chatgptOAuth as oauth, tokensFromResponse, type CredentialStore } from "@jun/llm";

/** Port used in OpenAI's examples; any free port works, only the port may vary. */
const PREFERRED_PORT = 1455;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed too, so the user can open it by hand.
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${title}</h1><p>${body}</p></body>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface LoginResult {
  email: string | undefined;
  registered: boolean;
}

/**
 * Sign in with ChatGPT using the loopback flow from
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
export async function loginWithChatGPT(
  store: CredentialStore,
  options: { openBrowser?: boolean; log?: (line: string) => void } = {},
): Promise<LoginResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const existing = await store.load();
  // The host id must be stable for this machine and saved before the first sign-in.
  const hostId = existing ? oauth.normalizeHostId(existing.hostId) : oauth.newHostId();
  if (!existing || hostId !== existing.hostId) await store.save({ ...existing, hostId });

  const state = oauth.randomToken();
  const nonce = oauth.randomToken();
  const codeVerifier = oauth.randomToken(48);
  const codeChallenge = await oauth.pkceChallenge(codeVerifier);

  type Callback = { code: string; clientId: string | undefined };
  let settle!: { resolve: (v: Callback) => void; reject: (e: Error) => void };
  const callback = new Promise<Callback>((resolve, reject) => {
    settle = { resolve, reject };
  });

  // Shared by the loopback listener and the paste fallback. A request with the wrong state
  // (stale tab, stray request) is ignored rather than aborting the sign-in.
  const handleCallback = (params: URLSearchParams): { ok: true } | { ok: false; message: string } => {
    if (params.get("state") !== state) {
      return { ok: false, message: "This callback is from a different sign-in attempt (state mismatch). Use the link printed most recently." };
    }
    const error = params.get("error");
    if (error) {
      const message = `${error}${params.get("error_description") ? `: ${params.get("error_description")}` : ""}`;
      settle.reject(new Error(message));
      return { ok: false, message };
    }
    const code = params.get("code");
    if (!code) return { ok: false, message: "No authorization code in the callback." };
    settle.resolve({ code, clientId: params.get("client_id") ?? undefined });
    return { ok: true };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== oauth.CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const result = handleCallback(url.searchParams);
    const html = result.ok
      ? page("Signed in to Jun Desk", "You can close this tab and go back to the terminal.")
      : page("Sign-in failed", escapeHtml(result.message));
    res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  });

  // Fallback when the browser can't reach the loopback listener (e.g. "127.0.0.1 refused to
  // connect"): the user pastes the URL from the address bar into the terminal.
  const prompt = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  prompt?.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let params: URLSearchParams;
    try {
      params = new URL(text).searchParams;
    } catch {
      log("That doesn't look like a URL. Paste the full address from the browser's address bar.");
      return;
    }
    const result = handleCallback(params);
    if (!result.ok) log(result.message);
  });

  // Start the listener before building the URL, as the docs require.
  let port: number;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);
  }
  const redirectUri = `http://127.0.0.1:${port}${oauth.CALLBACK_PATH}`;

  const authorizeUrl = oauth.buildAuthorizeUrl({
    clientId: existing?.clientId,
    hostId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
    idTokenHint: existing?.tokens?.idToken,
  });

  log("Opening your browser to sign in with ChatGPT. If it doesn't open, visit:");
  log(authorizeUrl);
  if (prompt) {
    log("");
    log("If the browser ends on \"127.0.0.1 refused to connect\", copy the URL from its address bar and paste it here.");
  }
  if (options.openBrowser !== false) openBrowser(authorizeUrl);

  const timeout = setTimeout(() => settle.reject(new Error("Timed out waiting for sign-in (10 minutes).")), LOGIN_TIMEOUT_MS);
  try {
    const { code, clientId: issuedClientId } = await callback;
    // First registration returns the issued client id in the callback; save that, not dynamic_agent_client.
    const clientId = issuedClientId ?? existing?.clientId;
    if (!clientId || clientId === oauth.REGISTRATION_CLIENT_ID) {
      throw new Error("The callback didn't include an issued client_id.");
    }
    // Save the issued client id right away so a failed exchange doesn't lose the registration.
    if (clientId !== existing?.clientId) await store.save({ ...(await store.load()), hostId, clientId });

    const response = await oauth.exchangeCode({ clientId, code, codeVerifier, redirectUri });
    if (!response.id_token) throw new Error("Token response has no id_token.");
    await oauth.verifyIdToken(response.id_token, { clientId, nonce });

    const tokens = tokensFromResponse(response);
    await store.save({ hostId, clientId, tokens });
    return { email: tokens.email, registered: !existing?.clientId };
  } finally {
    clearTimeout(timeout);
    prompt?.close();
    server.close();
  }
}
