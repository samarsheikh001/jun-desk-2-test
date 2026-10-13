import { DurableObject } from "cloudflare:workers";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

export interface VectorItem {
  chunkId: string;
  sourceId: string;
  vector: number[];
}

/**
 * Per-workspace vector index. Embeddings are stored int8-quantized in the object's own
 * SQLite and searched in memory by brute force: milliseconds for tens of thousands of
 * chunks, and, unlike Vectorize, it works in local dev and with one-click deploy.
 * (Vectorize can become an optional "scale mode" later.)
 */
export class KnowledgeIndex extends DurableObject<Env> {
  #cache: { ids: string[]; vectors: Int8Array; scales: Float32Array } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS vectors (chunk_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, scale REAL NOT NULL, vec BLOB NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS vectors_source ON vectors(source_id)");
  }

  async upsert(items: VectorItem[]): Promise<void> {
    for (const item of items) {
      const { bytes, scale } = quantize(item.vector);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO vectors (chunk_id, source_id, scale, vec) VALUES (?, ?, ?, ?)",
        item.chunkId,
        item.sourceId,
        scale,
        bytes.buffer,
      );
    }
    this.#cache = undefined;
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    for (let i = 0; i < chunkIds.length; i += 100) {
      const ids = chunkIds.slice(i, i + 100);
      this.ctx.storage.sql.exec(`DELETE FROM vectors WHERE chunk_id IN (${ids.map(() => "?").join(",")})`, ...ids);
    }
    this.#cache = undefined;
  }

  async deleteSource(sourceId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM vectors WHERE source_id = ?", sourceId);
    this.#cache = undefined;
  }

  async count(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM vectors").one().n;
  }

  /** Top-k chunks by cosine similarity (vectors are unit-length, so a dot product). */
  async query(vector: number[], topK = 20): Promise<{ chunkId: string; score: number }[]> {
    const { ids, vectors, scales } = this.#load();
    const q = Float32Array.from(vector);
    const dim = EMBEDDING_DIMENSIONS;
    const best: { index: number; score: number }[] = [];
    for (let i = 0; i < ids.length; i++) {
      let dot = 0;
      const offset = i * dim;
      for (let j = 0; j < dim; j++) dot += q[j]! * vectors[offset + j]!;
      const score = dot * scales[i]!;
      if (best.length < topK) {
        best.push({ index: i, score });
        best.sort((a, b) => b.score - a.score);
      } else if (score > best[best.length - 1]!.score) {
        best[best.length - 1] = { index: i, score };
        best.sort((a, b) => b.score - a.score);
      }
    }
    return best.map((b) => ({ chunkId: ids[b.index]!, score: b.score }));
  }

  #load() {
    if (this.#cache) return this.#cache;
    const rows = this.ctx.storage.sql.exec<{ chunk_id: string; scale: number; vec: ArrayBuffer }>("SELECT chunk_id, scale, vec FROM vectors").toArray();
    const ids = new Array<string>(rows.length);
    const vectors = new Int8Array(rows.length * EMBEDDING_DIMENSIONS);
    const scales = new Float32Array(rows.length);
    rows.forEach((row, i) => {
      ids[i] = row.chunk_id;
      scales[i] = row.scale;
      vectors.set(new Int8Array(row.vec), i * EMBEDDING_DIMENSIONS);
    });
    this.#cache = { ids, vectors, scales };
    return this.#cache;
  }
}

/** Symmetric int8 quantization: v ≈ bytes * scale. 4x smaller than float32. */
function quantize(vector: number[]): { bytes: Int8Array; scale: number } {
  if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`);
  let max = 0;
  for (const x of vector) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) bytes[i] = Math.round(vector[i]! / scale);
  return { bytes, scale };
}
