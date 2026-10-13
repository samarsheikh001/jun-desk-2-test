// URL rules for crawling (pure, so unit tests can import them without the Worker runtime).

export function normalizeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^ref$/i.test(key)) url.searchParams.delete(key);
    return url;
  } catch {
    return null;
  }
}

/** Is this URL one the admin asked us to skip? Exported for tests. */
export function isExcluded(url: URL, exclude: string[] = []): boolean {
  return exclude.some((rule) => {
    if (/^https?:\/\//.test(rule)) return normalizeUrl(rule)?.toString() === url.toString();
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`);
    return pattern.test(url.pathname);
  });
}
