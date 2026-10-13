import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { formatSize } from "../lib/thread.ts";
import { useAction } from "../useAction.ts";
import { FileUpload } from "./FileUpload.tsx";
import { SourceDetail } from "./SourceDetail.tsx";
import { KbSheet, KbSheetBody, KbSheetFooter } from "./KbSheet.tsx";
import { ago, plural, type SourceRow } from "./sources.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  EditIcon,
  FileIcon,
  GlobeIcon,
  InfoIcon,
  MoreIcon,
  RefreshIcon,
  SearchIcon,
  TextIcon,
  TrashIcon,
  XIcon,
} from "@/components/icons.tsx";

// The Knowledge page, laid out after Chatbase's Sources page: a row of "add" cards, then a
// searchable, filterable, paged list of sources. Adding a source, a source's details and the
// search tester each open in a right-hand sheet (KbSheet); the page itself never navigates.


interface Hit {
  id: string;
  title: string;
  heading: string;
  url: string | null;
  text: string;
  score: number;
}

type Panel = { kind: "add-file" | "add-website" | "add-snippet" | "test" } | { kind: "source"; id: string };
type TypeFilter = "all" | SourceRow["kind"];
type Sort = "status" | "newest" | "oldest" | "updated" | "az" | "za";

const TYPE_LABELS: Record<TypeFilter, string> = { all: "All sources", file: "Files", snippet: "Text snippets", website: "Website" };
const SORT_LABELS: Record<Sort, string> = { status: "Status", newest: "Newest", oldest: "Oldest", updated: "Last updated", az: "Alphabetical (A-Z)", za: "Alphabetical (Z-A)" };
const PAGE_SIZES = ["10", "25", "50"];
const KIND_ICONS = { website: GlobeIcon, file: FileIcon, snippet: TextIcon } as const;
const STATUS_ORDER = { error: 0, syncing: 1, pending: 2, ready: 3 } as const;

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const busyIndexing = (s: SourceRow) => s.status === "syncing" || s.status === "pending";
const fileExt = (name: string | null) => (name && name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "File");

function kindLabel(s: SourceRow): string {
  return s.kind === "website" ? "Website" : s.kind === "file" ? fileExt(s.fileName) : "Text";
}

/** The row's second line: when it was added and synced, and how much it holds. */
function meta(s: SourceRow): ReactNode {
  if (busyIndexing(s)) {
    return s.kind === "website" ? `Syncing…${s.pendingJobs > 0 ? ` ${plural(s.pendingJobs, "page")} queued` : ""}` : "Indexing…";
  }
  if (s.status === "error") return <span className="kb-row-error">{s.error ?? "Error"}</span>;
  const parts = [
    `Added ${day(s.createdAt)}`,
    `${s.kind === "website" ? "Synced" : "Indexed"} ${ago(s.lastSyncedAt)}`,
    s.kind === "website" ? plural(s.pageCount, "page") : null,
    s.kind === "file" && s.fileSize != null ? formatSize(s.fileSize) : null,
    plural(s.chunkCount, "chunk"),
  ];
  return (
    <>
      {parts.filter(Boolean).join(" · ")}
      {s.chunksWithoutVectors > 0 && <span className="kb-row-warn"> · keyword search only</span>}
    </>
  );
}

function readQuery(): string {
  try {
    return new URLSearchParams(location.search).get("q") ?? "";
  } catch {
    return "";
  }
}

export function KnowledgePage({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/knowledge`;
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The sheet keeps its last panel while it slides out, so `open` is separate from `panel`.
  const [panel, setPanel] = useState<Panel | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SourceRow | null>(null);
  const [query, setQuery] = useState(readQuery);
  const [type, setType] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    try {
      setSources((await api<{ sources: SourceRow[] }>(base)).sources);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  // Poll while something is crawling or indexing.
  const syncing = sources?.some(busyIndexing);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [syncing, load]);

  // Like Chatbase, the search lives in the address (?q=) so a reload keeps it.
  useEffect(() => {
    const url = new URL(location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [query]);
  useEffect(() => setPage(0), [query, type, sort, pageSize]);

  const show = (next: Panel) => {
    setPanel(next);
    setOpen(true);
  };
  const changed = () => void load();

  const shown = useMemo(() => {
    if (!sources) return [];
    const q = query.trim().toLowerCase();
    const list = sources.filter(
      (s) => (type === "all" || s.kind === type) && (!q || `${s.title} ${s.url ?? ""} ${s.fileName ?? ""}`.toLowerCase().includes(q)),
    );
    const by: Record<Sort, (a: SourceRow, b: SourceRow) => number> = {
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt,
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      updated: (a, b) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0),
      az: (a, b) => a.title.localeCompare(b.title),
      za: (a, b) => b.title.localeCompare(a.title),
    };
    return list.sort(by[sort]);
  }, [sources, query, type, sort]);

  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = shown.slice(current * pageSize, (current + 1) * pageSize);
  const lastSynced = sources?.reduce<number | null>((max, s) => (s.lastSyncedAt && (!max || s.lastSyncedAt > max) ? s.lastSyncedAt : max), null) ?? null;
  const totalChunks = sources?.reduce((n, s) => n + s.chunkCount, 0) ?? 0;

  const resync = (s: SourceRow) =>
    run(async () => {
      await api(`${base}/${s.id}/sync`, { body: {} });
      await load();
    });
  const remove = (s: SourceRow) =>
    run(async () => {
      await api(`${base}/${s.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      if (panel?.kind === "source" && panel.id === s.id) setOpen(false);
      await load();
    });

  const sourceInPanel = panel?.kind === "source" ? sources?.find((s) => s.id === panel.id) : undefined;

  return (
    <div className="kb-page">
      <header className="kb-head">
        <h1>Knowledge</h1>
        <div className="kb-head-side">
          {lastSynced && <span className="kb-head-synced">Last synced {ago(lastSynced)}</span>}
          <Button type="button" variant="outline" size="lg" onClick={() => show({ kind: "test" })}>
            <SearchIcon />
            Test a question
          </Button>
        </div>
      </header>

      {canEdit && (
        <>
          <div className="kb-add-cards">
            <AddCard icon={<FileIcon />} label="Add files" onClick={() => show({ kind: "add-file" })} />
            <AddCard icon={<GlobeIcon />} label="Add website" onClick={() => show({ kind: "add-website" })} />
            <AddCard icon={<TextIcon />} label="Add text snippet" onClick={() => show({ kind: "add-snippet" })} />
          </div>
          <Separator className="kb-sep" />
        </>
      )}

      <div className="kb-list-block">
        <div className="kb-toolbar">
          <div className="kb-search">
            <SearchIcon className="kb-search-icon" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search..." aria-label="Search sources" />
            {query && (
              <Button type="button" variant="ghost" size="icon-xs" className="kb-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                <XIcon />
              </Button>
            )}
          </div>
          <Select items={TYPE_LABELS} value={type} onValueChange={(v) => v && setType(v as TypeFilter)}>
            <SelectTrigger className="kb-select kb-select-type" aria-label="Source type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              {(Object.keys(TYPE_LABELS) as TypeFilter[]).map((k) => <SelectItem key={k} value={k}>{TYPE_LABELS[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select items={SORT_LABELS} value={sort} onValueChange={(v) => v && setSort(v as Sort)}>
            <SelectTrigger className="kb-select" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              {(Object.keys(SORT_LABELS) as Sort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}
            </SelectContent>
          </Select>
          {sources && sources.length > 0 && (
            <span className="kb-total">
              Total: <strong>{plural(sources.length, "source")}</strong> · {plural(totalChunks, "chunk")}
            </span>
          )}
        </div>

        {(error || loadError) && <p className="error small">{error ?? loadError}</p>}

        <div className="kb-tray">
          {sources === null ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="kb-row-skeleton" />)
          ) : visible.length === 0 ? (
            <div className="kb-empty">
              {sources.length === 0
                ? canEdit
                  ? "No sources yet. Add your docs site, a file or a text snippet: the AI answers only from what's here, and cites it."
                  : "No sources yet. An admin can add the docs site, files or text snippets."
                : "No sources match your search."}
            </div>
          ) : (
            visible.map((s) => (
              <SourceRowView
                key={s.id}
                source={s}
                canEdit={canEdit}
                busy={busy}
                onOpen={() => show({ kind: "source", id: s.id })}
                onResync={() => resync(s)}
                onDelete={() => setConfirmDelete(s)}
              />
            ))
          )}
        </div>

        {sources && shown.length > 0 && (
          <div className="kb-pager">
            <div className="kb-pager-size">
              <span>Sources per page</span>
              <Select items={Object.fromEntries(PAGE_SIZES.map((n) => [n, n]))} value={String(pageSize)} onValueChange={(v) => v && setPageSize(Number(v))}>
                <SelectTrigger className="kb-select kb-select-size" aria-label="Sources per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="kb-pager-nav">
              <span>Page {current + 1} of {pages}</span>
              <Button type="button" variant="outline" size="icon" aria-label="First page" disabled={current === 0} onClick={() => setPage(0)}><ChevronsLeftIcon /></Button>
              <Button type="button" variant="outline" size="icon" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeftIcon /></Button>
              <Button type="button" variant="outline" size="icon" aria-label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}><ChevronRightIcon /></Button>
              <Button type="button" variant="outline" size="icon" aria-label="Last page" disabled={current >= pages - 1} onClick={() => setPage(pages - 1)}><ChevronsRightIcon /></Button>
            </div>
          </div>
        )}
      </div>

      <KnowledgeSheet
        panel={panel}
        open={open}
        onOpenChange={setOpen}
        base={base}
        canEdit={canEdit}
        source={sourceInPanel}
        onAdded={() => {
          setOpen(false);
          changed();
        }}
        onChanged={changed}
      />

      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this source?</DialogTitle>
            <DialogDescription>
              "{confirmDelete?.title}" and everything indexed from it leave the knowledge base. The AI stops citing it straight away.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="error small">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => confirmDelete && remove(confirmDelete)}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddCard({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" data-plain className="kb-add-card" onClick={onClick}>
      <span className="kb-add-icon" aria-hidden="true">{icon}</span>
      <span className="kb-add-label">{label}</span>
    </button>
  );
}

function SourceRowView({
  source: s,
  canEdit,
  busy,
  onOpen,
  onResync,
  onDelete,
}: {
  source: SourceRow;
  canEdit: boolean;
  busy: boolean;
  onOpen: () => void;
  onResync: () => void;
  onDelete: () => void;
}) {
  const Icon = KIND_ICONS[s.kind];
  return (
    <div className={`kb-row${s.status === "error" ? " is-error" : ""}`}>
      <button type="button" data-plain className="kb-row-main" onClick={onOpen}>
        <span className="kb-row-title">{s.title}</span>
        <span className="kb-row-meta">{meta(s)}</span>
      </button>
      <div className="kb-row-side">
        {busyIndexing(s) && <span className="kb-spinner" role="status" aria-label={s.kind === "website" ? "Syncing" : "Indexing"} />}
        <span className="kb-kind">
          <Icon />
          {kindLabel(s)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label="Source actions" className="kb-row-menu" />}>
            <MoreIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="kb-menu">
            <DropdownMenuItem onClick={onOpen}>
              <EditIcon />
              {canEdit ? "Edit" : "View"}
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuItem disabled={busy || busyIndexing(s)} onClick={onResync}>
                  <RefreshIcon />
                  {s.kind === "website" ? "Re-sync now" : "Re-index now"}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <TrashIcon />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** One sheet for every panel, so switching panels doesn't stack overlays. */
function KnowledgeSheet({
  panel,
  open,
  onOpenChange,
  base,
  canEdit,
  source,
  onAdded,
  onChanged,
}: {
  panel: Panel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  canEdit: boolean;
  source: SourceRow | undefined;
  onAdded: () => void;
  onChanged: () => void;
}) {
  if (!panel) return null;
  if (panel.kind === "add-file") {
    return (
      <KbSheet open={open} onOpenChange={onOpenChange} icon={<FileIcon />} title="Add files">
        <FileUpload base={base} onUploaded={onChanged} onDone={() => onOpenChange(false)} />
      </KbSheet>
    );
  }
  if (panel.kind === "add-website") {
    return (
      <KbSheet open={open} onOpenChange={onOpenChange} icon={<GlobeIcon />} title="Add website">
        <AddWebsite base={base} onAdded={onAdded} />
      </KbSheet>
    );
  }
  if (panel.kind === "add-snippet") {
    return (
      <KbSheet open={open} onOpenChange={onOpenChange} icon={<TextIcon />} title="Add text snippet">
        <AddSnippet base={base} onAdded={onAdded} />
      </KbSheet>
    );
  }
  if (panel.kind !== "source") {
    return (
      <KbSheet open={open} onOpenChange={onOpenChange} icon={<SearchIcon />} title="Test a question">
        <SearchTester base={base} />
      </KbSheet>
    );
  }
  return (
    <KbSheet
      open={open}
      onOpenChange={onOpenChange}
      title={source?.title ?? "Source"}
      description={source ? describeSource(source) : undefined}
    >
      <SourceDetail key={panel.id} base={base} sourceId={panel.id} row={source} canEdit={canEdit} onChanged={onChanged} />
    </KbSheet>
  );
}

function describeSource(s: SourceRow): string {
  if (busyIndexing(s)) return s.kind === "website" ? `Syncing…${s.pendingJobs > 0 ? ` ${plural(s.pendingJobs, "page")} queued` : ""}` : "Indexing…";
  if (s.kind === "website") return `We have indexed ${plural(s.pageCount, "page")} · ${plural(s.chunkCount, "chunk")} · synced ${ago(s.lastSyncedAt)}`;
  if (s.kind === "file") return `${s.fileName ?? "File"}${s.fileSize != null ? ` · ${formatSize(s.fileSize)}` : ""} · ${plural(s.chunkCount, "chunk")}`;
  return `Text snippet · ${plural(s.chunkCount, "chunk")}`;
}

/**
 * K-01: a docs site. "Crawl links" reads its sitemap or follows links (up to Max pages);
 * "Individual link" is the same crawl capped at one page, which is always the start URL.
 */
function AddWebsite({ base, onAdded }: { base: string; onAdded: () => void }) {
  const [mode, setMode] = useState<"crawl" | "link">("crawl");
  const [protocol, setProtocol] = useState("https://");
  const [host, setHost] = useState("");
  const [maxPages, setMaxPages] = useState(200);
  const [advanced, setAdvanced] = useState(false);
  const { busy, error, run } = useAction();

  // Pasting a full URL picks its protocol and keeps the rest.
  const onHost = (value: string) => {
    const match = /^(https?:\/\/)(.*)$/i.exec(value.trim());
    if (match?.[1] && match[2] !== undefined) {
      setProtocol(match[1].toLowerCase());
      setHost(match[2]);
    } else setHost(value);
  };
  const valid = /^[^\s/.]+\.[^\s]+/.test(host.trim());

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(async () => {
      await api(`${base}/websites`, { body: { url: `${protocol}${host.trim()}`, maxPages: mode === "link" ? 1 : maxPages } });
      onAdded();
    });
  };

  return (
    <form onSubmit={submit} className="kb-sheet-form">
      <Tabs value={mode} onValueChange={(v) => setMode(v as "crawl" | "link")} className="kb-sheet-tabs">
        <TabsList className="kb-tabs">
          <TabsTrigger value="crawl">Crawl links</TabsTrigger>
          <TabsTrigger value="link">Individual link</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="kb-sheet-rule" />
      <KbSheetBody>
        <div className="kb-fields">
          <div className="kb-field">
            <label className="kb-label" htmlFor="kb-url">URL</label>
            <div className="kb-url-box">
              <div className="kb-url">
                <Select items={{ "https://": "https://", "http://": "http://" }} value={protocol} onValueChange={(v) => v && setProtocol(v)}>
                  <SelectTrigger className="kb-url-protocol" aria-label="Protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="https://">https://</SelectItem>
                    <SelectItem value="http://">http://</SelectItem>
                  </SelectContent>
                </Select>
                <input id="kb-url" data-plain value={host} onChange={(e) => onHost(e.target.value)} placeholder={mode === "crawl" ? "docs.example.com" : "docs.example.com/billing/refunds"} autoComplete="off" spellCheck={false} />
              </div>
              <p className="kb-hint">
                <InfoIcon />
                {mode === "crawl"
                  ? "We read the site's sitemap or follow its links from this page, and re-sync it daily. The page count shows once the crawl finishes."
                  : "Only this page is indexed. It re-syncs daily."}
              </p>
            </div>
          </div>
          {mode === "crawl" && (
            <div className="kb-advanced">
              <Separator />
              <button type="button" data-plain className="kb-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                <ChevronDownIcon className={advanced ? "open" : ""} />
                Advanced options
              </button>
              {advanced && (
                <div className="kb-field">
                  <label className="kb-label" htmlFor="kb-max-pages">Max pages</label>
                  <Input id="kb-max-pages" type="number" min={1} max={2000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 1)} className="kb-input kb-input-narrow" />
                  <span className="kb-note">Up to 2,000. Skip paths like /blog/ from the source's settings once it's added.</span>
                </div>
              )}
            </div>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
      </KbSheetBody>
      <KbSheetFooter className="kb-foot-split">
        <span className="kb-note">{mode === "crawl" ? `Up to ${plural(maxPages, "page")}` : "1 page"}</span>
        <Button size="lg" disabled={busy || !valid}>{busy ? "Adding…" : mode === "crawl" ? "Fetch links" : "Add link"}</Button>
      </KbSheetFooter>
    </form>
  );
}

const SNIPPET_MAX = 20_000;

/** A FAQ, policy or internal note that isn't on the web. */
function AddSnippet({ base, onAdded }: { base: string; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(async () => {
      await api(`${base}/snippets`, { body: { title: data.get("title"), body } });
      onAdded();
    });
  };
  return (
    <form onSubmit={submit} className="kb-sheet-form">
      <KbSheetBody className="kb-snippet-body">
        <div className="kb-field">
          <label className="kb-label" htmlFor="kb-snippet-title">Title</label>
          <Input id="kb-snippet-title" name="title" required maxLength={200} placeholder="Ex: Refund requests" className="kb-input" />
        </div>
        <div className="kb-field kb-field-grow">
          <div className="kb-editor">
            <div className="kb-editor-bar">
              <span>Text</span>
              <span className="kb-editor-count">{body.length.toLocaleString()} / {SNIPPET_MAX.toLocaleString()}</span>
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              maxLength={SNIPPET_MAX}
              placeholder="Write the answer the way you'd explain it to a customer."
              aria-label="Snippet text"
            />
          </div>
        </div>
        {error && <p className="error small">{error}</p>}
      </KbSheetBody>
      <KbSheetFooter className="kb-foot-end">
        <Button size="lg" disabled={busy || !body.trim()}>{busy ? "Adding…" : "Add text snippet"}</Button>
      </KbSheetFooter>
    </form>
  );
}

/** Shows exactly which chunks the AI would get for a question. */
function SearchTester({ base }: { base: string }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const query = String(new FormData(e.currentTarget).get("query"));
    run(async () => setHits((await api<{ hits: Hit[] }>(`${base}/search`, { body: { query } })).hits));
  };
  return (
    <KbSheetBody className="kb-test-body">
      <p className="kb-note">See which knowledge the AI would use to answer, in the order it gets it.</p>
      <form onSubmit={submit} className="kb-test-form">
        <Input name="query" required placeholder="e.g. How do I get a refund?" aria-label="Question" className="kb-input" autoFocus />
        <Button size="lg" disabled={busy}>{busy ? "Searching…" : "Search"}</Button>
      </form>
      {error && <p className="error small">{error}</p>}
      {hits &&
        (hits.length === 0 ? (
          <div className="kb-empty">No matching knowledge. The AI would hand this to a person.</div>
        ) : (
          <ol className="kb-hits">
            {hits.map((h) => (
              <li key={h.id}>
                <div className="kb-hit-head">
                  <strong>{h.title}{h.heading ? ` › ${h.heading}` : ""}</strong>
                  <span className="kb-note nums">relevance {h.score.toFixed(2)}</span>
                </div>
                {h.url && <a className="kb-hit-url" href={h.url} target="_blank" rel="noreferrer">{h.url}</a>}
                <p>{h.text.length > 300 ? `${h.text.slice(0, 300)}…` : h.text}</p>
              </li>
            ))}
          </ol>
        ))}
    </KbSheetBody>
  );
}
