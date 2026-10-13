// Widget domain restriction: which websites may embed the widget. The key is public, so
// without this anyone could put your chat on their site or fake visitors on your live list.
// Browsers set Origin (and enforce frame-ancestors) themselves, so a page can't lie about it.
// An empty list means any website (the default, handy while trying things out).

const DOMAIN = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Cleans what an admin typed: "https://www.Acme.com/pricing, *.acme.com" → ["www.acme.com", "*.acme.com"]. */
export function normalizeDomains(input: unknown): { domains: string[]; invalid: string[] } {
  const raw = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[\s,]+/);
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    let d = entry.trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
    if (DOMAIN.test(d) && !domains.includes(d)) domains.push(d);
    else if (!DOMAIN.test(d)) invalid.push(entry.trim());
  }
  return { domains: domains.slice(0, 50), invalid };
}

function hostMatches(host: string, domain: string): boolean {
  if (domain.startsWith("*.")) {
    const base = domain.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === domain;
}

/** May a request from `origin` use this widget? The desk's own origin (demo page, frame) always may. */
export function originAllowed(origin: string | null | undefined, domains: string[], deskOrigin: string): boolean {
  if (domains.length === 0) return true;
  if (!origin) return false;
  if (origin === deskOrigin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => hostMatches(host, d));
}

/** CSP for the chat frame: only allowed sites (and the desk) may show it. */
export function frameAncestors(domains: string[]): string {
  if (domains.length === 0) return "frame-ancestors *";
  // CSP's *.acme.com doesn't cover acme.com itself; our rule does, so list both.
  const hosts = domains.flatMap((d) => (d.startsWith("*.") ? [d, d.slice(2)] : [d]));
  const sources = [...new Set(hosts)].flatMap((d) => [`https://${d}:*`, `http://${d}:*`]);
  return `frame-ancestors 'self' ${sources.join(" ")}`;
}
