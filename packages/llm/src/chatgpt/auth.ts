import { LlmError } from "../types.ts";
import {
  decodeJwtPayload,
  OAuthError,
  PLAN_USAGE_SCOPE,
  refreshTokens,
  revokeToken,
  toEpochMs,
  UNUSABLE_REFRESH_ERRORS,
  type TokenResponse,
} from "./oauth.ts";

export interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string | undefined;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms; don't refresh before this unless the access token has expired. */
  earliestRefreshAt?: number | undefined;
  scope?: string | undefined;
  email?: string | undefined;
}

/**
 * Everything persisted for one host. `hostId` and `clientId` survive logout:
 * the docs say to reuse the same host id and issued client id for later sign-ins.
 */
export interface ChatGPTCredentials {
  hostId: string;
  clientId?: string | undefined;
  tokens?: ChatGPTTokens | undefined;
}

export interface CredentialStore {
  load(): Promise<ChatGPTCredentials | undefined>;
  save(credentials: ChatGPTCredentials): Promise<void>;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export function tokensFromResponse(response: TokenResponse, previous?: ChatGPTTokens, now = Date.now()): ChatGPTTokens {
  const refreshToken = response.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error("Token response has no refresh_token; was offline_access granted?");

  let email = previous?.email;
  if (response.id_token) {
    const claims = decodeJwtPayload(response.id_token);
    if (typeof claims.email === "string") email = claims.email;
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    idToken: response.id_token ?? previous?.idToken,
    expiresAt: now + (response.expires_in ?? 3600) * 1000,
    earliestRefreshAt: toEpochMs(response.earliest_refresh_at),
    scope: response.scope ?? previous?.scope,
    email,
  };
}

export function hasPlanUsageScope(tokens: ChatGPTTokens): boolean {
  // If the server didn't echo scopes, assume the requested set was granted.
  return tokens.scope === undefined || tokens.scope.split(" ").includes(PLAN_USAGE_SCOPE);
}

/**
 * Hands out valid access tokens, refreshing when needed. Refresh tokens rotate and
 * reusing an old one invalidates the set, so concurrent refreshes are collapsed into one.
 * (In a Worker this must live in a single Durable Object for the same reason.)
 */
export class ChatGPTAuth {
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #refreshing: Promise<ChatGPTTokens> | undefined;

  constructor(store: CredentialStore, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#store = store;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const credentials = await this.#store.load();
    const tokens = credentials?.tokens;
    if (!credentials?.clientId || !tokens) {
      throw new LlmError("Not signed in to ChatGPT. Run `jun login chatgpt`.", { code: "not_signed_in" });
    }
    if (!hasPlanUsageScope(tokens)) {
      throw new LlmError("ChatGPT plan usage wasn't granted at sign-in. Run `jun login chatgpt` and allow it.", {
        code: "reauth_required",
      });
    }

    const now = this.#now();
    const expiring = tokens.expiresAt - EXPIRY_SKEW_MS <= now;
    const refreshAllowed = tokens.earliestRefreshAt === undefined || now >= tokens.earliestRefreshAt || tokens.expiresAt <= now;
    if (!options.forceRefresh && !expiring) return tokens.accessToken;
    if (!refreshAllowed && tokens.expiresAt > now) return tokens.accessToken;

    this.#refreshing ??= this.#refresh(credentials).finally(() => {
      this.#refreshing = undefined;
    });
    return (await this.#refreshing).accessToken;
  }

  async #refresh(credentials: ChatGPTCredentials): Promise<ChatGPTTokens> {
    const { clientId, tokens } = credentials;
    if (!clientId || !tokens) throw new LlmError("Not signed in to ChatGPT.", { code: "not_signed_in" });
    try {
      const response = await refreshTokens({ clientId, refreshToken: tokens.refreshToken }, this.#fetch);
      const next = tokensFromResponse(response, tokens, this.#now());
      await this.#store.save({ ...credentials, tokens: next });
      return next;
    } catch (error) {
      if (error instanceof OAuthError && (UNUSABLE_REFRESH_ERRORS.has(error.error) || error.error === "invalid_client")) {
        await this.#store.save({ ...credentials, tokens: undefined });
        throw new LlmError(`ChatGPT session ended (${error.error}). Run \`jun login chatgpt\` again.`, {
          code: "reauth_required",
          upstreamCode: error.error,
        });
      }
      throw error;
    }
  }

  /** Revokes the refresh token (best effort) and forgets tokens, keeping host and client ids. */
  async logout(): Promise<void> {
    const credentials = await this.#store.load();
    if (!credentials?.tokens) return;
    if (credentials.clientId) {
      await revokeToken({ clientId: credentials.clientId, token: credentials.tokens.refreshToken }, this.#fetch).catch(() => {});
    }
    await this.#store.save({ ...credentials, tokens: undefined });
  }
}
