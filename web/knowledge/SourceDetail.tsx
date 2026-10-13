import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { formatSize } from "../lib/thread.ts";
import { useAction } from "../useAction.ts";
import { KbSheetBody, KbSheetFooter } from "./KbSheet.tsx";
import { plural, type SourceRow } from "./sources.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { ChevronRightIcon, DownloadIcon, ExternalLinkIcon, SearchIcon, TrashIcon } from "@/components/icons.tsx";

// K-04: what a knowledge source contains, and the knobs to fix it: edit a snippet, cap or
// skip pages of a website, remove a page (kept out of future syncs), see its indexed text.
// K-02: an uploaded file shows its original (download) and the text indexed from it.
// Shown in the source's sheet (after Chatbase's "Fetched links" panel): the pages or text on
// one tab, the source's settings on the other.

interface Detail {
  source: {
    id: string;
    kind: "website" | "snippet" | "file";
    url: string | null;
    title: string;
    body: string | null;
    maxPages: number;
    exclude: string[];
    file: { name: string; format: string; size: number } | null;
  };
  documents: { id: string; url: string; title: string | null; chunkCount: number; chunksWithoutVectors: number; updatedAt: number }[];
}

function pathOf(url: string, base: string | null): string {
  try {
    const u = new URL(url);
    return base && u.origin === new URL(base).origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

function Chunks({ base, documentId }: { base: string; documentId: string }) {
  const [chunks, setChunks] = useState<{ heading: string; text: string }[] | null>(null);
  useEffect(() => {
    api<{ chunks: { heading: string; text: string }[] }>(`${base}/documents/${documentId}`).then((r) => setChunks(r.chunks), () => setChunks([]));
  }, [base, documentId]);
  if (!chunks) return <div className="kb-chunks-loading kb-note">Loading…</div>;
  if (chunks.length === 0) return <div className="kb-chunks-loading kb-note">Nothing indexed from this yet.</div>;
  return (
    <ol className="kb-chunks">
      {chunks.map((c, i) => (
        <li key={i}>
          {c.heading && <div className="kb-chunk-heading">{c.heading}</div>}
          <div className="kb-chunk-text">{c.text}</div>
        </li>
      ))}
    </ol>
  );
}

export function SourceDetail({
  base,
  sourceId,
  row,
  canEdit,
  onChanged,
}: {
  base: string;
  sourceId: string;
  /** The list's row: its status and counts change while a sync runs, which reloads this. */
  row: SourceRow | undefined;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const url = `${base}/${sourceId}`;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState("content");
  const load = useCallback(async () => setDetail(await api<Detail>(url)), [url]);
  const version = row ? `${row.status}:${row.lastSyncedAt}:${row.chunkCount}:${row.pageCount}` : "";
  useEffect(() => {
    load().catch(() => {});
  }, [load, version]);

  if (!detail) {
    return (
      <KbSheetBody className="kb-detail-body">
        <Skeleton className="kb-detail-skeleton" />
      </KbSheetBody>
    );
  }
  const { source, documents } = detail;
  const changed = async () => {
    await load();
    onChanged();
  };

  const notices = row && (
    <>
      {row.status === "error" && <p className="kb-notice is-error" role="alert">{row.error ?? "The last sync failed."}</p>}
      {row.chunksWithoutVectors > 0 && row.status !== "syncing" && row.status !== "pending" && (
        <p className="kb-notice" role="status">
          Keyword search only{row.chunksWithoutVectors < row.chunkCount ? ` for ${row.chunksWithoutVectors} of ${plural(row.chunkCount, "chunk")}` : ""}: embedding failed (Workers AI may be out of its
          daily free allocation). {canEdit ? `${row.kind === "website" ? "Re-sync" : "Re-index"} later to add vectors; the daily re-sync also retries.` : "The daily re-sync retries."}
        </p>
      )}
    </>
  );

  if (source.kind === "snippet") {
    return (
      <Settings url={url} source={source} canEdit={canEdit} onSaved={changed} notices={notices} />
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="kb-detail-tabs">
      <div className="kb-detail-tabbar">
        <TabsList className="kb-tabs">
          <TabsTrigger value="content">{source.kind === "website" ? "Indexed pages" : "Indexed text"}</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="content" className="kb-detail-panel">
        <KbSheetBody className="kb-detail-body">
          {notices}
          {source.kind === "website" ? (
            <Pages url={url} source={source} documents={documents} canEdit={canEdit} onChanged={changed} />
          ) : (
            <FileText url={url} source={source} documents={documents} />
          )}
        </KbSheetBody>
      </TabsContent>
      <TabsContent value="settings" className="kb-detail-panel">
        <Settings url={url} source={source} canEdit={canEdit} onSaved={changed} />
      </TabsContent>
    </Tabs>
  );
}

/** A website's indexed pages: filter, read what was indexed, open, or remove one. */
function Pages({ url, source, documents, canEdit, onChanged }: { url: string; source: Detail["source"]; documents: Detail["documents"]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const shown = documents.filter((d) => !filter || `${d.title ?? ""} ${d.url}`.toLowerCase().includes(filter.toLowerCase()));
  const chunks = documents.reduce((n, d) => n + d.chunkCount, 0);
  return (
    <div className="kb-detail-card">
      <div className="kb-detail-card-head">
        <span className="kb-detail-root" title={source.url ?? ""}>{source.url}</span>
        <span className="kb-note">{plural(documents.length, "page")} · {plural(chunks, "chunk")}</span>
      </div>
      <div className="kb-sunken">
        <div className="kb-sunken-search">
          <SearchIcon className="kb-search-icon" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" aria-label="Filter pages" />
        </div>
        <div className="kb-sunken-tabs"><span className="active">{documents.length.toLocaleString()} indexed</span></div>
        {error && <p className="error small">{error}</p>}
        <ul className="kb-docs">
          {shown.length === 0 && <li className="kb-docs-empty kb-note">{documents.length === 0 ? "No pages indexed yet." : "No pages match."}</li>}
          {shown.map((d) => (
            <li key={d.id} className={open === d.id ? "open" : ""}>
              <div className="kb-doc">
                <button type="button" data-plain className="kb-doc-toggle" aria-expanded={open === d.id} aria-label={`Show what was indexed from ${d.title || pathOf(d.url, source.url)}`} onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <ChevronRightIcon />
                </button>
                <button type="button" data-plain className="kb-doc-title" title={d.url} onClick={() => setOpen(open === d.id ? null : d.id)}>
                  <span className="kb-doc-name">{d.title || pathOf(d.url, source.url)}</span>
                  {d.title && <span className="kb-doc-path">{pathOf(d.url, source.url)}</span>}
                </button>
                <span className="kb-doc-meta">
                  {plural(d.chunkCount, "chunk")}
                  {d.chunksWithoutVectors > 0 ? ` (${d.chunksWithoutVectors} keyword only)` : ""}
                </span>
                <a className="kb-doc-action" href={d.url} target="_blank" rel="noreferrer" aria-label="Open page" title="Open page"><ExternalLinkIcon /></a>
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="kb-doc-action"
                    disabled={busy}
                    aria-label="Remove page"
                    title="Remove it now and skip it in future syncs"
                    onClick={() => run(async () => { await api(`${url}/documents/${d.id}`, { method: "DELETE" }); await onChanged(); })}
                  >
                    <TrashIcon />
                  </Button>
                )}
              </div>
              {open === d.id && <Chunks base={url} documentId={d.id} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** An uploaded file: the original to download, and the text the AI can quote from it. */
function FileText({ url, source, documents }: { url: string; source: Detail["source"]; documents: Detail["documents"] }) {
  const doc = documents[0];
  return (
    <div className="kb-detail-card">
      <div className="kb-detail-card-head">
        <span className="kb-detail-root">{source.file?.name ?? source.title}</span>
        {source.file && <span className="kb-note">{source.file.format.toUpperCase()} · {formatSize(source.file.size)}</span>}
        {source.file && (
          <a className="kb-download" href={`/api${url}/file`} download={source.file.name}>
            <DownloadIcon />
            Download original
          </a>
        )}
      </div>
      <div className="kb-sunken">
        <div className="kb-sunken-tabs">
          <span className="active">
            {doc ? plural(doc.chunkCount, "chunk") : "0 chunks"}
            {doc && doc.chunksWithoutVectors > 0 ? ` (${doc.chunksWithoutVectors} keyword search only)` : ""}
          </span>
        </div>
        {doc ? <Chunks base={url} documentId={doc.id} /> : <p className="kb-note">Nothing indexed yet.</p>}
      </div>
    </div>
  );
}

/** Title for every source; the text of a snippet; page cap and skipped pages of a website. */
function Settings({ url, source, canEdit, onSaved, notices }: { url: string; source: Detail["source"]; canEdit: boolean; onSaved: () => Promise<void>; notices?: ReactNode }) {
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(async () => {
      await api(url, {
        method: "PATCH",
        body:
          source.kind === "snippet"
            ? { title: data.get("title"), body: data.get("body") }
            : source.kind === "file"
              ? { title: data.get("title") }
              : { title: data.get("title"), maxPages: Number(data.get("maxPages")), exclude: String(data.get("exclude") ?? "") },
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };
  return (
    <form onSubmit={save} className="kb-sheet-form">
      <KbSheetBody className={source.kind === "snippet" ? "kb-snippet-body" : "kb-detail-body"}>
        {notices}
        <div className="kb-field">
          <label className="kb-label" htmlFor="kb-edit-title">Title</label>
          <Input id="kb-edit-title" name="title" defaultValue={source.title} disabled={!canEdit} maxLength={200} className="kb-input" />
        </div>
        {source.kind === "snippet" && (
          <div className="kb-field kb-field-grow">
            <div className="kb-editor">
              <div className="kb-editor-bar"><span>Text</span></div>
              <Textarea name="body" defaultValue={source.body ?? ""} disabled={!canEdit} maxLength={20_000} aria-label="Snippet text" />
            </div>
          </div>
        )}
        {source.kind === "website" && (
          <>
            <div className="kb-field">
              <label className="kb-label" htmlFor="kb-edit-max">Max pages</label>
              <Input id="kb-edit-max" name="maxPages" type="number" min={1} max={2000} defaultValue={source.maxPages} disabled={!canEdit} className="kb-input kb-input-narrow" />
            </div>
            <div className="kb-field">
              <label className="kb-label" htmlFor="kb-edit-exclude">Skip these pages</label>
              <Textarea id="kb-edit-exclude" name="exclude" rows={4} defaultValue={source.exclude.join("\n")} disabled={!canEdit} placeholder="/blog/" />
              <span className="kb-note">One per line: a full URL, or a path like /blog/ or /changelog*. Page limits and skips apply on the next sync.</span>
            </div>
          </>
        )}
        {error && <p className="error small">{error}</p>}
      </KbSheetBody>
      {canEdit && (
        <KbSheetFooter className="kb-foot-end">
          {saved && <span className="kb-note">Saved</span>}
          <Button size="lg" disabled={busy}>{busy ? "Saving…" : source.kind === "website" ? "Save" : "Save and re-index"}</Button>
        </KbSheetFooter>
      )}
    </form>
  );
}
