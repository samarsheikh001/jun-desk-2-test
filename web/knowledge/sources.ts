// Shared by the Knowledge page and a source's sheet.

export interface SourceRow {
  id: string;
  kind: "website" | "snippet" | "file";
  url: string | null;
  title: string;
  status: "pending" | "syncing" | "ready" | "error";
  pageCount: number;
  pendingJobs: number;
  chunkCount: number;
  /** Stored for keyword search only: embedding failed (e.g. Workers AI's daily allocation). */
  chunksWithoutVectors: number;
  fileName: string | null;
  fileSize: number | null;
  error: string | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export const ago = (ms: number | null) => {
  if (!ms) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
};
