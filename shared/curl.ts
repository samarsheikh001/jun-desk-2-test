// AI-26: "New action" reads a curl command from the business's API docs into an action, without the
// AI: method, address, query, headers and JSON body. Keys found in it (an Authorization header, an
// x-api-key, -u user:password) never go in the file: they become {secrets.NAME} and the value is kept
// on the desk (the action-secrets store). Keys in the address can't be kept (the desk sends keys in
// headers only), so they're dropped with a note. Pure.

export interface CurlKey {
  /** UPPER_SNAKE_CASE, as in {secrets.NAME}. */
  name: string;
  /** The key itself; null when the command has a stand-in (like $API_KEY or <token>). */
  value: string | null;
}

export interface CurlRequest {
  method: "GET" | "POST";
  /** Without its query. */
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
  keys: CurlKey[];
  /** Things the desk changed or couldn't keep, in plain words. */
  notes: string[];
}

/** Splits a shell command into words: quotes, backslash escapes and line continuations (\ and Windows ^). */
export function shellWords(command: string): string[] {
  const text = command.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ").replace(/`\r?\n/g, " ");
  const out: string[] = [];
  let word = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end < 0 ? text.length : end;
      started = true;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) i++;
        word += text[i];
        i++;
      }
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
}

/** Looks like a curl command (so the rest of the text is read as one). */
export const looksLikeCurl = (text: string): boolean => /^\s*curl(\.exe)?\s/i.test(text);

const KEY_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-token|private-token)$|(^|-)(key|token|secret)$/i;
const KEY_QUERY = /^(api_?key|apikey|key|token|access_token|auth|secret|client_secret|signature|sig)$/i;
/** A stand-in for a key in docs: $API_KEY, ${TOKEN}, <your-token>, YOUR_API_KEY, {{token}}, sk_test_…x. */
const PLACEHOLDER = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]+>|\{\{?[^}]+\}?\}|\[[^\]]+\]|[A-Z_]*YOUR[A-Z_]*|x{4,}|\*{3,}|\.{3})$/i;
const IGNORED = new Set(["-s", "--silent", "-S", "--show-error", "-L", "--location", "-i", "--include", "-v", "--verbose", "--compressed", "-k", "--insecure", "-g", "--globoff", "-f", "--fail", "--fail-with-body", "-#", "--progress-bar"]);
const WITH_VALUE_IGNORED = new Set(["-o", "--output", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "--retry", "-b", "--cookie", "-c", "--cookie-jar"]);

/** NAME for a key from this host: api.acme.com → ACME_API_KEY. */
export function keyName(url: string, kind = "API_KEY"): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // no host: just API_KEY
  }
  const parts = host.split(".").filter((p) => p && !["api", "www", "com", "io", "dev", "app", "co", "net", "org", "ai", "v1", "v2"].includes(p));
  const base = (parts[parts.length - 1] ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^[^A-Z]+/, "");
  return base ? `${base}_${kind}` : kind;
}

/**
 * AI-27: a name for the action a curl command makes, from its path: GET /orders/1042 → look_up_order,
 * POST /orders/{id}/refund → refund_order, POST /tickets → create_ticket.
 */
export function curlActionName(req: Pick<CurlRequest, "method" | "url">): string {
  let path = "";
  try {
    path = new URL(req.url.replace(/\{[^}]*\}/g, "0")).pathname;
  } catch {
    // no path
  }
  const words = path.split("/").map((s) => s.toLowerCase()).filter((s) => /^[a-z][a-z_-]*$/.test(s) && !/^v\d+$/.test(s) && !["api", "rest"].includes(s));
  const one = (w: string) => w.replace(/-/g, "_").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  const last = words[words.length - 1];
  const prev = words[words.length - 2];
  let name: string;
  if (!last) name = req.method === "GET" ? "look_up" : "send_request";
  else if (req.method === "GET") name = `look_up_${one(last)}`;
  else if (prev && !/s$/.test(last)) name = `${last.replace(/-/g, "_")}_${one(prev)}`;
  else name = `create_${one(last)}`;
  return name.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

/** Reads a curl command. Throws an Error with a plain reason when it can't. */
export function parseCurl(command: string): CurlRequest {
  const words = shellWords(command.trim());
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0]!)) throw new Error("That isn't a curl command (it should start with curl).");
  let method: string | null = null;
  let url = "";
  let user: string | null = null;
  let get = false;
  const headers: [string, string][] = [];
  const data: string[] = [];
  let json = false;
  const notes: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const next = () => {
      const v = words[++i];
      if (v === undefined) throw new Error(`${w} needs a value.`);
      return v;
    };
    // --flag=value
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(w);
    const flag = eq ? eq[1]! : w;
    const value = () => (eq ? eq[2]! : next());
    if (flag === "-X" || flag === "--request") method = value().toUpperCase();
    else if (/^-X[A-Z]+$/.test(w)) method = w.slice(2);
    else if (flag === "-H" || flag === "--header") {
      const h = value();
      const at = h.indexOf(":");
      if (at > 0) headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(flag)) data.push(value());
    else if (flag === "--json") {
      data.push(value());
      json = true;
    } else if (flag === "-u" || flag === "--user") user = value();
    else if (flag === "-G" || flag === "--get") get = true;
    else if (flag === "--url") url = value();
    else if (flag === "-F" || flag === "--form") throw new Error("File uploads (-F) aren't supported yet.");
    else if (WITH_VALUE_IGNORED.has(flag)) {
      if (!eq) i++;
    } else if (IGNORED.has(flag)) continue;
    else if (w.startsWith("-")) notes.push(`Left out ${w}.`);
    else if (!url) url = w;
  }
  if (!url) throw new Error("There's no address in it.");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // {placeholders} in the docs' address survive URL parsing.
  const braces: string[] = [];
  url = url.replace(/\{[^{}\s]*\}/g, (m) => `jun${braces.push(m) - 1}brace`);
  const restore = (s: string) => s.replace(/jun(\d+)brace/g, (_, n: string) => braces[Number(n)] ?? "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`The address isn't valid: ${url}`);
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
    notes.push("Changed the address to https.");
  }

  const keys: CurlKey[] = [];
  const addKey = (value: string, kind?: string): string => {
    const stand = PLACEHOLDER.test(value.trim());
    let name = keyName(parsed.href, kind);
    for (let n = 2; keys.some((k) => k.name === name); n++) name = `${keyName(parsed.href, kind)}_${n}`;
    // A stand-in named like a key ($ACME_TOKEN) keeps its name.
    const named = /^\$\{?([A-Z][A-Z0-9_]*)\}?$/.exec(value.trim());
    if (named && !keys.some((k) => k.name === named[1])) name = named[1]!;
    keys.push({ name, value: stand ? null : value.trim() });
    return `{secrets.${name}}`;
  };

  const outHeaders: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (["content-length", "host", "user-agent", "accept-encoding", "cookie"].includes(lower)) continue;
    if (lower === "content-type" && /json/i.test(value)) {
      json = true;
      continue; // the desk sends JSON bodies with this header already
    }
    if (lower === "accept" && /json/i.test(value)) continue;
    if (KEY_HEADER.test(name)) {
      const scheme = /^(Bearer|Basic|Token|Bot|ApiKey|Key)\s+(.+)$/i.exec(value);
      outHeaders[name] = scheme ? `${scheme[1]} ${addKey(scheme[2]!)}` : addKey(value);
    } else outHeaders[name] = value;
  }
  if (user !== null) {
    outHeaders.Authorization = `Basic ${addKey(user.includes("$") || PLACEHOLDER.test(user) ? user : btoa(user.includes(":") ? user : `${user}:`), "BASIC_AUTH")}`;
    notes.push("Turned -u into an Authorization header.");
  }

  const query: Record<string, string> = {};
  for (const [k, v] of parsed.searchParams) {
    if (KEY_QUERY.test(k)) notes.push(`Left out ?${k}=…: it looks like a key, and the desk sends keys only in headers. Ask your developer whether the API takes it as a header.`);
    else query[k] = restore(v);
  }
  parsed.search = "";

  let body: unknown;
  const raw = data.join("&");
  if (get && raw) {
    for (const pair of raw.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  } else if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      if (json) throw new Error("The request body isn't valid JSON.");
      // A form body (a=1&b=2) becomes JSON fields.
      body = Object.fromEntries(raw.split("&").filter(Boolean).map((p) => p.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " "))) as [string, string]));
      notes.push("Sent the form fields as JSON (the desk sends JSON bodies). Check your API accepts that.");
    }
  }

  let m = (method ?? (raw && !get ? "POST" : "GET")) as string;
  if (m !== "GET" && m !== "POST") {
    notes.push(`The desk makes GET and POST requests only, so this ${m} became a POST.`);
    m = "POST";
  }
  if (m === "GET" && body !== undefined) {
    notes.push("A GET can't send a body, so it became a POST.");
    m = "POST";
  }
  return { method: m as "GET" | "POST", url: restore(parsed.href.replace(/\?$/, "")), query, headers: outHeaders, ...(body !== undefined ? { body } : {}), keys, notes };
}
