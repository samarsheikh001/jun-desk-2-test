import { HttpError } from "../types.ts";

export async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_body", "Expected a JSON object.");
}

export function text(body: Record<string, unknown>, field: string, options: { max?: number; optional?: boolean } = {}): string {
  const value = body[field];
  if ((value === undefined || value === null || value === "") && options.optional) return "";
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "invalid_field", `\`${field}\` is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > (options.max ?? 200)) throw new HttpError(400, "invalid_field", `\`${field}\` is too long.`);
  return trimmed;
}

export function email(body: Record<string, unknown>, field = "email"): string {
  const value = text(body, field, { max: 320 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, "invalid_field", "Enter a valid email address.");
  return value.toLowerCase();
}

export function object<T>(body: Record<string, unknown>, field: string): T {
  const value = body[field];
  if (!value || typeof value !== "object") throw new HttpError(400, "invalid_field", `\`${field}\` is required.`);
  return value as T;
}
