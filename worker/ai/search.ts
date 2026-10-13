import { embed } from "./embeddings.ts";
import { ftsQuery, type SearchHit } from "./query.ts";

export type { SearchHit };


const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const CANDIDATES = 20;
const RRF_K = 60;

/**
 * Hybrid search: meaning (vectors in the KnowledgeIndex DO) + keywords (D1 FTS5), merged
 * with reciprocal rank fusion, then reranked by a cross-encoder.
 */
export async function searchKnowledge(env: Env, workspaceId: string, query: string, limit = 5): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 1000);
  if (!q) return [];

  const [vectorHits, keywordHits] = await Promise.all([
    // Workers AI embeds the query even when replies come from another provider; if it fails
    // (e.g. the daily free allocation is used up), keyword search alone still finds answers.
    embed(env, [q])
      .then(([v]) => env.KNOWLEDGE_INDEX.getByName(workspaceId).query(v!, CANDIDATES))
      .catch((error: unknown) => {
        console.error("query embedding failed, using keyword search only:", error);
        return [] as { chunkId: string }[];
      }),
    (async () => {
      const match = ftsQuery(q);
      if (!match) return [];
      const rows = await env.DB.prepare(
        `SELECT c.id FROM kb_chunks_fts f JOIN kb_chunks c ON c.rowid = f.rowid
         WHERE kb_chunks_fts MATCH ? AND c.workspace_id = ? ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
      )
        .bind(match, workspaceId, CANDIDATES)
        .all<{ id: string }>();
      return rows.results.map((r) => ({ chunkId: r.id }));
    })(),
  ]);

  // Reciprocal rank fusion.
  const fused = new Map<string, number>();
  const add = (ids: string[]) => ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  add(vectorHits.map((h) => h.chunkId));
  add(keywordHits.map((h) => h.chunkId));
  const ids = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([id]) => id);
  if (ids.length === 0) return [];

  const rows = await env.DB.prepare(`SELECT id, title, heading, url, text FROM kb_chunks WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<Omit<SearchHit, "score">>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const candidates = ids.map((id) => byId.get(id)).filter((r): r is Omit<SearchHit, "score"> => r !== undefined);

  // Nothing to choose between: skip the reranker round trip.
  if (candidates.length <= limit) return candidates.map((c) => ({ ...c, score: fused.get(c.id) ?? 0 }));

  try {
    const result = (await env.AI.run(RERANK_MODEL, {
      query: q,
      contexts: candidates.map((c) => ({ text: `${c.title}\n${c.heading}\n${c.text}`.slice(0, 2000) })),
      top_k: limit,
    } as never)) as { response?: { id: number; score: number }[] };
    const ranked = (result.response ?? []).sort((a, b) => b.score - a.score).slice(0, limit);
    return ranked.map((r) => ({ ...candidates[r.id]!, score: r.score }));
  } catch (error) {
    console.error("rerank failed, using fused order:", error);
    return candidates.slice(0, limit).map((c) => ({ ...c, score: fused.get(c.id) ?? 0 }));
  }
}
