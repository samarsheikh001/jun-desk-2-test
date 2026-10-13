// Tool secrets (Worker secrets JUN_SECRET_<NAME>, keys pasted on the Agent page, a customer's own
// keys) go only in request headers, but an API that echoes its request (or puts a key in an error
// message) could return one: never keep or show it.

import { scrubValues } from "./scrub.ts";

/** Replaces the value of every JUN_SECRET_* (6+ characters) in `text` with ••••. */
export function secretScrubber(env: object): (text: string) => string {
  const secrets = Object.entries(env as Record<string, unknown>)
    .filter(([k, v]) => k.startsWith("JUN_SECRET_") && typeof v === "string")
    .map(([, v]) => v as string);
  return (text) => scrubValues(text, secrets);
}

/** The names of the Worker secrets for actions (JUN_SECRET_<NAME> → NAME). */
export function workerSecretNames(env: object): string[] {
  return Object.entries(env as Record<string, unknown>)
    .filter(([k, v]) => k.startsWith("JUN_SECRET_") && typeof v === "string" && v)
    .map(([k]) => k.slice("JUN_SECRET_".length));
}

/**
 * AI-24: the keys actions may use ({secrets.NAME}): the Worker secret JUN_SECRET_<NAME> when set
 * (a developer's choice wins), else the one pasted on the Agent page (the workspace hub's storage).
 */
export async function loadToolSecrets(env: Env, workspaceId: string): Promise<(name: string) => string | undefined> {
  const vars = env as unknown as Record<string, unknown>;
  const fromEnv = (name: string) => (typeof vars[`JUN_SECRET_${name}`] === "string" ? (vars[`JUN_SECRET_${name}`] as string) : undefined);
  let desk: Record<string, string> = {};
  try {
    desk = await env.WORKSPACE_HUB.getByName(workspaceId).actionSecrets();
  } catch (error) {
    console.error("action keys couldn't be loaded:", error);
  }
  return (name) => fromEnv(name) ?? desk[name];
}
