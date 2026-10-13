import type { Context } from "hono";

export type Role = "owner" | "admin" | "agent";

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
}

export interface AppEnv {
  Bindings: Env;
  Variables: { user: SessionUser };
}

export type AppContext = Context<AppEnv>;

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | 502;
  readonly code: string;
  constructor(status: HttpError["status"], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
