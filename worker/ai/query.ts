// Search types and keyword-query helpers. Pure (no Worker APIs), so unit tests can import them.

export interface SearchHit {
  id: string;
  title: string;
  heading: string;
  url: string | null;
  text: string;
  /** Reranker relevance (higher is better), or the fused rank score if reranking failed. */
  score: number;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from how i if in is it its me my of on or our so that the this to was we what when where which who why will with you your".split(" "),
);

/** FTS5 query from free text: quoted terms OR'd together (quoting avoids syntax errors). */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)))].slice(0, 12);
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ") : null;
}
