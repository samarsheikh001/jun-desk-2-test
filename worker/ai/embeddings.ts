/** Multilingual embeddings via Workers AI (no API key needed). 1024 dimensions. */
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
const BATCH = 32;

export function normalize(vector: number[]): number[] {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vector.map((x) => x / norm);
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const result = (await env.AI.run(EMBEDDING_MODEL, { text: batch, truncate_inputs: true } as never)) as {
      data?: number[][];
      response?: number[][];
    };
    const vectors = result.data ?? result.response;
    if (!vectors || vectors.length !== batch.length) throw new Error("Embedding model returned an unexpected result");
    out.push(...vectors.map(normalize));
  }
  return out;
}
