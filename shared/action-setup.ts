// AI-24: whether an action (tools/<name>.yaml) can work yet. One that can't is never offered to
// the AI (it could only fail, and the AI guessed wrong with placeholders: it once called the
// starter's lookup with a widget's name), and the Agent page says what's missing. Pure; used by the
// Worker (runAgent) and the dashboard.

/** {secrets.NAME}: a key the business pasted on the Agent page or set as a Worker secret. */
const SECRET_REF = /\{secrets\.([A-Z][A-Z0-9_]*)\}/g;
/** {user.secrets.NAME}: a key of the signed-in customer's own, from their identity token. */
const USER_SECRET_REF = /\{user\.secrets\.([A-Z][A-Z0-9_]*)\}/g;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Values longer than this are refused (a key, not a document). */
export const MAX_SECRET_VALUE = 4096;
/** Keys a workspace keeps on the Agent page, at most. */
export const MAX_DESK_SECRETS = 50;

/** Descriptions the Agent page once wrote into a new action, meaning "not written yet". */
const STARTER_DESCRIPTIONS = new Set(["What this returns and when the AI should use it."]);

const names = (texts: string[], ref: RegExp) => [...new Set(texts.flatMap((t) => [...t.matchAll(ref)].map((m) => m[1]!)))];

/** The workspace keys these texts use ({secrets.NAME}), each once. */
export const secretRefs = (texts: string[]): string[] => names(texts, SECRET_REF);
/** The customer's own keys these texts use ({user.secrets.NAME}), each once. */
export const userSecretRefs = (texts: string[]): string[] => names(texts, USER_SECRET_REF);

/** An address on a reserved example domain (example.com and friends, RFC 2606), which can't be the real API. */
export function exampleHost(url: string): string | null {
  try {
    const host = new URL(url.replace(/\{[^}]*\}/g, "x")).hostname.toLowerCase();
    return /(^|\.)example\.(com|org|net)$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export interface ActionSetupInput {
  description: string;
  url: string;
  headers: Record<string, string>;
}

/** What keeps this action from working, in plain words; [] when it's ready. */
export function actionSetupProblems(action: ActionSetupInput, isSet: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of secretRefs(Object.values(action.headers))) {
    if (!isSet(name)) out.push(`The key ${name} isn't added yet.`);
  }
  const host = action.url ? exampleHost(action.url) : null;
  if (host) out.push(`Its address is still an example (${host}).`);
  if (STARTER_DESCRIPTIONS.has(action.description.trim())) out.push("Its description is still the starter text, so the AI can't tell when to use it.");
  return out;
}
