import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { contactLabel } from "../../shared/notifications.ts";
import { markdownToPlain } from "../../shared/markdown.ts";
import { formatTime } from "../lib/thread.ts";
import { ColumnsIcon, SearchIcon, XIcon } from "@/components/icons";

// The inbox's list as Widgo's Conversations page (measured from app.widgo.ai, colours mapped to our
// tokens): sticky title, a tab strip with counts and search, a sortable table with a column picker,
// and 25 rows a page. Clicking a row opens the conversation in a drawer (InboxPage).

export const COLUMNS = ["Person", "Message", "Status", "Topic", "Assignee", "Tags", "Rating", "Updated"] as const;
export type Column = (typeof COLUMNS)[number];
const HIDDEN_BY_DEFAULT: Column[] = ["Tags", "Rating"];
/** Columns that sort newest / largest first when picked. */
const DESC_FIRST = new Set<Column>(["Updated"]);
export const PAGE_SIZE = 25;

export const isUnread = (c: ConversationSummary) => c.lastMessageAuthor === "visitor" && c.lastSeq > c.agentReadSeq;

// Widgo's avatar: initials on a colour picked by hashing the contact id; anonymous visitors get grey.
const AVATAR_COLORS = ["#163300", "#3FA110", "#7C5CE0", "#D28E3D", "#E41E3F", "#2E5C13", "#8A8D88", "#3B3D42", "#5CA02E", "#65676B"];
const ANONYMOUS_COLOR = "#BFC3BA";
function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
const initials = (name: string) => name.split(" ").map((w) => w[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "?";

function Avatar({ c }: { c: ConversationSummary }) {
  const name = c.contact.name?.trim();
  const email = c.contact.email?.trim();
  const label = name ? initials(name) : email ? email[0]!.toUpperCase() : "?";
  const size = 32;
  return (
    <span className="cv-avatar" style={{ width: size, height: size, background: name || email ? avatarColor(c.contact.id) : ANONYMOUS_COLOR, fontSize: size * 0.36 }} aria-hidden="true">
      {label}
    </span>
  );
}

/** Which columns this person hid (a per-viewer convenience: kept in this browser only). */
export function useHiddenColumns() {
  const key = "jun:inbox-hidden-columns";
  const [hidden, setHidden] = useState<Set<Column>>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) return new Set((JSON.parse(saved) as string[]).filter((c): c is Column => (COLUMNS as readonly string[]).includes(c)));
    } catch {}
    return new Set(HIDDEN_BY_DEFAULT);
  });
  const toggle = (column: Column) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return { hidden, toggle };
}

export type Sort = { column: Column; dir: "asc" | "desc" };
export const DEFAULT_SORT: Sort = { column: "Updated", dir: "desc" };

/** Widgo's header click: the same column flips direction, a new one starts at its natural order. */
export const nextSort = (sort: Sort, column: Column): Sort =>
  column === sort.column ? { column, dir: sort.dir === "asc" ? "desc" : "asc" } : { column, dir: DESC_FIRST.has(column) ? "desc" : "asc" };

/** Sorted like Widgo's table: blanks last whichever the direction, ties newest first. */
export function sortConversations(list: ConversationSummary[], sort: Sort, memberName: (id: string | null) => string) {
  const value = (c: ConversationSummary): string | number => {
    switch (sort.column) {
      case "Person": return contactLabel(c.contact).toLowerCase();
      case "Message": return (c.lastMessagePreview ?? "").toLowerCase();
      case "Status": return c.status;
      case "Topic": return (c.topic?.name ?? "").toLowerCase();
      case "Assignee": return memberName(c.assigneeId).toLowerCase();
      case "Tags": return c.tags.join(", ").toLowerCase();
      case "Rating": return c.csat.rating ?? "";
      case "Updated": return c.lastMessageAt;
    }
  };
  return list.slice().sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const xBlank = typeof x === "string" && !x;
    if (xBlank !== (typeof y === "string" && !y)) return xBlank ? 1 : -1;
    let d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    d = sort.dir === "asc" ? d : -d;
    return d === 0 ? b.lastMessageAt - a.lastMessageAt : d;
  });
}

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="cv-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </section>
  );
}

export interface Tab<K extends string> { key: K; label: string; count: number | undefined }

export function TabStrip<K extends string>({ tabs, active, onChange, search, children, trailing }: {
  tabs: Tab<K>[];
  active: K;
  onChange: (key: K) => void;
  search: { value: string; onChange: (value: string) => void; placeholder: string; inputRef: Ref<HTMLInputElement>; onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void };
  /** Our extra filters (assignee, tag, topic, rating), between the tabs and the search. */
  children?: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <div className="cv-tabs">
      {tabs.map((t) => (
        <button key={t.key} type="button" data-plain className={`cv-tab ${t.key === active ? "active" : ""}`} aria-pressed={t.key === active} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span className="cv-tab-count">{t.count}</span>}
        </button>
      ))}
      {children}
      <label className="cv-search">
        <SearchIcon />
        <input
          ref={search.inputRef}
          data-plain
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          onKeyDown={search.onKeyDown}
          placeholder={search.placeholder}
          aria-label={search.placeholder}
          aria-keyshortcuts="/"
        />
        {search.value && (
          <button type="button" data-plain className="cv-search-clear" onClick={() => search.onChange("")} aria-label="Clear search">
            <XIcon />
          </button>
        )}
      </label>
      <div>{trailing}</div>
    </div>
  );
}

const PICKER_WIDTH = 208;

/** Widgo's "Show columns" picker: a fixed popover under the button, closed by an outside click, scroll or resize. */
export function ColumnPicker({ hidden, onToggle }: { hidden: Set<Column>; onToggle: (column: Column) => void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, r.right - PICKER_WIDTH) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const close = () => setOpen(false);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <>
      <button ref={button} type="button" data-plain className="cv-columns" onClick={() => (open ? setOpen(false) : show())} title="Columns" aria-label="Columns" aria-expanded={open}>
        <ColumnsIcon />
      </button>
      {open && at && (
        <div ref={menu} className="cv-columns-menu" style={{ position: "fixed", top: at.top, left: at.left, width: PICKER_WIDTH }}>
          <div className="cv-columns-title">Show columns</div>
          {COLUMNS.filter((c) => c !== "Person").map((c) => (
            <label key={c}>
              <input type="checkbox" checked={!hidden.has(c)} onChange={() => onToggle(c)} />
              {c}
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** Widgo's page list: first, last, and the pages around the current one, with gaps between. */
function pageList(page: number, count: number) {
  const pages = [...new Set([0, count - 1, page, page - 1, page + 1])].filter((p) => p >= 0 && p < count).sort((a, b) => a - b);
  const out: number[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push(-1);
    out.push(p);
  });
  return out;
}

export function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  const PageButton = ({ children, active, disabled, on, label }: { children: ReactNode; active?: boolean; disabled?: boolean; on: () => void; label: string }) => (
    <button type="button" data-plain className={`cv-pager-btn ${active ? "active" : ""}`} disabled={disabled} onClick={on} aria-label={label} aria-current={active ? "page" : undefined}>{children}</button>
  );
  return (
    <nav className="cv-pager" aria-label="Pages">
      <PageButton disabled={page === 0} on={() => onPage(page - 1)} label="Previous page">‹</PageButton>
      {pageList(page, pageCount).map((p, i) =>
        p < 0 ? <span key={`gap-${i}`} className="cv-page-gap">…</span> : <PageButton key={p} active={p === page} on={() => onPage(p)} label={`Page ${p + 1}`}>{p + 1}</PageButton>,
      )}
      <PageButton disabled={page >= pageCount - 1} on={() => onPage(page + 1)} label="Next page">›</PageButton>
    </nav>
  );
}

const STATUS_LABEL: Record<ConversationSummary["status"], string> = { open: "Open", pending: "Pending", snoozed: "Snoozed", resolved: "Resolved" };
const dash = <span className="cv-dash">—</span>;

export function ConversationRows({ rows, columns, selected, cursor, empty, memberName, onOpen, onFocusRow }: {
  rows: ConversationSummary[] | null;
  columns: Column[];
  selected: string | null;
  cursor: string | null;
  /** The empty-state text, or null while there are rows. */
  empty: string | null;
  memberName: (id: string | null) => string;
  onOpen: (id: string) => void;
  onFocusRow: (id: string) => void;
}) {
  const shows = (c: Column) => columns.includes(c);
  if (rows === null || empty) {
    return (
      <tr>
        <td colSpan={columns.length} className="cv-empty">{rows === null ? "Loading…" : empty}</td>
      </tr>
    );
  }
  return (
    <>
      {rows.map((c) => {
        const name = c.contact.name?.trim();
        return (
          <tr key={c.id} onClick={() => onOpen(c.id)} className={`${c.id === selected ? "selected" : isUnread(c) ? "unread" : ""} ${c.id === cursor ? "cursor" : ""}`}>
            <td>
              <div className="cv-person">
                <Avatar c={c} />
                <div className="cv-person-text">
                  <div className="cv-name">
                    {/* The row's link: keyboard focus, Enter and open-in-new-tab. */}
                    <a id={`conv-${c.id}`} href={`/inbox/${c.id}`} onFocus={() => onFocusRow(c.id)} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(c.id); }}>{contactLabel(c.contact)}</a>
                    {c.contact.verified && <span className="verified" title="Identity verified by your site">✓</span>}
                    {c.handling === "ai" && <em className="tag ai-tag" title="The AI assistant is answering">AI</em>}
                    {/* AI-20: opened from the customer's app with an intent (agents only). */}
                    {c.intent && <em className="tag intent-tag" title={`Opened from the customer's app with the intent "${c.intent.name}"`}>{c.intent.name}</em>}
                    {c.debugIssueCount > 0 && <em className="tag issue-tag" title="Errors or failed requests in the visitor's browser">⚠ {c.debugIssueCount}</em>}
                  </div>
                  {name && c.contact.email && <div className="cv-email">{c.contact.email}</div>}
                </div>
              </div>
            </td>
            {shows("Message") && (
              <td className="cv-text">
                <span className="cv-clamp">
                  {c.lastMessageAuthor === "agent" && <span className="muted">You: </span>}
                  {c.lastMessageAuthor === "ai" && <span className="muted">AI: </span>}
                  {(c.lastMessageAuthor === "ai" && c.lastMessagePreview ? markdownToPlain(c.lastMessagePreview).replace(/\s+/g, " ") : c.lastMessagePreview) || dash}
                </span>
              </td>
            )}
            {shows("Status") && <td className="cv-text nowrap">{STATUS_LABEL[c.status]}</td>}
            {shows("Topic") && <td className="cv-text"><span className="cv-clamp" title={c.topic ? "Topic, labelled by the AI" : undefined}>{c.topic?.name ?? dash}</span></td>}
            {shows("Assignee") && <td className="cv-text nowrap">{c.assigneeId ? memberName(c.assigneeId) : dash}</td>}
            {shows("Tags") && (
              <td>{c.tags.length ? <span className="conv-tags">{c.tags.map((t) => <span key={t} className="chip tag-chip">{t}</span>)}</span> : dash}</td>
            )}
            {shows("Rating") && (
              <td className="cv-text nowrap">
                {c.csat.rating ? <span title={c.csat.rating === "good" ? "The customer rated this Good" : "The customer rated this Bad"}>{c.csat.rating === "good" ? "👍 Good" : "👎 Bad"}</span> : dash}
              </td>
            )}
            {shows("Updated") && <td className="cv-time">{formatTime(c.lastMessageAt)}</td>}
          </tr>
        );
      })}
    </>
  );
}

export function TableHead({ columns, sort, onSort }: { columns: Column[]; sort: Sort; onSort: (column: Column) => void }) {
  return (
    <thead>
      <tr>
        {columns.map((c) => {
          const active = sort.column === c;
          return (
            <th
              key={c}
              className={active ? "active" : ""}
              aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              tabIndex={0}
              onClick={() => onSort(c)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onSort(c);
              }}
            >
              {c}
              <span className="cv-sort" aria-hidden="true">{active && sort.dir === "asc" ? "↑" : "↓"}</span>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
