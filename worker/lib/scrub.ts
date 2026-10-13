// Pure: masks key values in text (an API that echoes its request back). See tool-secrets.ts.

/** Replaces every one of these values (6+ characters) in `text` with ••••. */
export function scrubValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const value of values) if (value.length >= 6) out = out.split(value).join("••••");
  return out;
}
