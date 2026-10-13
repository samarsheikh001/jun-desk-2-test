import { Hono } from "hono";
import { MAX_UPLOAD_BYTES, type Attachment } from "../../shared/protocol.ts";
import { randomToken } from "../lib/crypto.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";

/** Images we show inline. Everything else downloads, so uploaded HTML/SVG can't run on our origin. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Stores a raw-body upload (`Content-Type` = the file's type, `X-File-Name` = URI-encoded
 * name) in R2 and records it. Returns the attachment descriptor to put on a message.
 */
export async function storeUpload(c: AppContext, workspaceId: string, uploadedBy: string): Promise<Attachment> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(400, "too_large", "Files are limited to 10 MB.");

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw new HttpError(400, "empty_file", "The file is empty.");
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(400, "too_large", "Files are limited to 10 MB.");

  let name = "file";
  try {
    name = decodeURIComponent(c.req.header("x-file-name") ?? "file");
  } catch {
    // keep the default
  }
  name = name.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || "file";
  const type = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase().slice(0, 100);

  const key = `f_${randomToken(18)}`;
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare("INSERT INTO files (key, workspace_id, name, type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(key, workspaceId, name, type, body.byteLength, uploadedBy, Date.now())
    .run();
  return { key, name, type, size: body.byteLength };
}

export const files = new Hono<AppEnv>();

// Files are addressed by unguessable keys (like most chat apps' attachment links).
files.get("/files/:key", async (c) => {
  const key = c.req.param("key");
  const meta = await c.env.DB.prepare("SELECT name, type FROM files WHERE key = ?").bind(key).first<{ name: string; type: string }>();
  const object = meta ? await c.env.FILES.get(key) : null;
  if (!meta || !object) throw new HttpError(404, "not_found", "File not found.");

  const inline = INLINE_TYPES.has(meta.type);
  return new Response(object.body, {
    headers: {
      "Content-Type": inline ? meta.type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
