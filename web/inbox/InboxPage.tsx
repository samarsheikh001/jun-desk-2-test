import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiAction, ConversationIssue, ConversationStatus, ConversationSummary, CsatRating, Message } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { fillSavedReply } from "../../shared/inbox.ts";
import { contactLabel } from "../../shared/notifications.ts";
import { Composer, type ComposerControl, type SavedReply } from "../components/Composer.tsx";
import { useBridge, type ConversationPatch } from "../lib/bridge.ts";
import { matchesFilter } from "../lib/commands.ts";
import { MessageList } from "../components/MessageList.tsx";
import { navigate } from "../lib/router.ts";
import { DebugPanel } from "./DebugPanel.tsx";
import { ToolCalls } from "./ToolCalls.tsx";
import { configuredProviders, IssueDialog, type FiledIssue } from "./IssueDialog.tsx";
import { ConversationDrawer, DrawerClose } from "./ConversationDrawer.tsx";
import {
  COLUMNS, ColumnPicker, ConversationRows, DEFAULT_SORT, isUnread, nextSort, PageHeader, PAGE_SIZE, Pager,
  sortConversations, TableHead, TabStrip, useHiddenColumns, type Sort, type Tab,
} from "./ConversationTable.tsx";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";
import { formatTime, uploadFile, useThread, useTypingSignal } from "../lib/thread.ts";
import type { Hub } from "../Shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";

/** The composer's saved-reply / @mention popup: focus stays in the textarea, so no tab stop. */
function SuggestScroller({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={className}>
      <ScrollArea viewportProps={{ tabIndex: -1 }}>{children}</ScrollArea>
    </div>
  );
}

type StatusFilter = ConversationStatus | "all";
type AssigneeFilter = "all" | "me" | "unassigned" | "mentions";
type RatingFilter = CsatRating | "";
interface Member { id: string; name: string }
interface Tag { id: string; name: string; conversations: number }
interface Topic { id: string; name: string; conversations: number }
interface MentionToast { conversationId: string; by: string; preview: string }

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "pending", label: "Pending" },
  { key: "resolved", label: "Resolved" },
];

/** W-12: the customer's latest rating as a small badge. */
function CsatBadge({ rating }: { rating: CsatRating | null }) {
  if (!rating) return null;
  return <em className={`tag csat-tag ${rating}`} title={rating === "good" ? "The customer rated this Good" : "The customer rated this Bad"}>{rating === "good" ? "👍" : "👎"}</em>;
}

/** AI-20: the intent the customer's app opened the chat with (agents only), and whether they took its exit. */
function IntentBadge({ intent }: { intent: ConversationSummary["intent"] }) {
  if (!intent) return null;
  const title = `Opened from the customer's app with the intent "${intent.name}"${intent.exitedAt ? `; they clicked the exit button ${formatTime(intent.exitedAt)}` : ""}`;
  return <em className="tag intent-tag" title={title}>Intent: {intent.name}{intent.exitedAt ? " · exited" : ""}</em>;
}

/** A-02: Reports links to /inbox?topic=<id>; the topic's chats are mostly resolved, so show all. */
const initialTopic = () => new URLSearchParams(window.location.search).get("topic") ?? "";

export function InboxPage({ workspaceId, workspaceName, me, hub, conversationId }: { workspaceId: string; workspaceName: string; me: { id: string; name: string }; hub: Hub; conversationId: string | null }) {
  const [topicFilter, setTopicFilter] = useState(initialTopic);
  const [status, setStatus] = useState<StatusFilter>(() => (initialTopic() ? "all" : "open"));
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("");
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  // Per-status totals for the tabs, under the other filters (from the server, not just the loaded rows).
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [unreadMentions, setUnreadMentions] = useState(0);
  const [toast, setToast] = useState<MentionToast | null>(null);
  const [trackers, setTrackers] = useState<TrackerStatus | null>(null);
  // I-13: a quick text filter over the loaded list, and the j/k cursor.
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(conversationId);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [page, setPage] = useState(0);
  const { hidden, toggle: toggleColumn } = useHiddenColumns();
  const searchInput = useRef<HTMLInputElement>(null);
  // The open thread's update(), so `e` / `a` keep its header in sync.
  const threadUpdate = useRef<((patch: ConversationPatch) => Promise<void>) | null>(null);
  useEffect(() => {
    if (conversationId) setCursor(conversationId);
  }, [conversationId]);

  const matches = useCallback(
    (c: ConversationSummary) =>
      (status === "all" || c.status === status) &&
      (tagFilter === "" || c.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
      (topicFilter === "" || c.topic?.id === topicFilter) &&
      (ratingFilter === "" || c.csat.rating === ratingFilter) &&
      (assignee === "all" || assignee === "mentions" || (assignee === "me" ? c.assigneeId === me.id : c.assigneeId === null)),
    [status, assignee, tagFilter, topicFilter, ratingFilter, me.id],
  );

  const query = useMemo(
    () => new URLSearchParams({ status, ...(assignee !== "all" ? { assignee } : {}), ...(tagFilter ? { tag: tagFilter } : {}), ...(topicFilter ? { topic: topicFilter } : {}), ...(ratingFilter ? { rating: ratingFilter } : {}) }).toString(),
    [status, assignee, tagFilter, topicFilter, ratingFilter],
  );
  useEffect(() => {
    let cancelled = false;
    setList(null);
    setPage(0);
    api<{ conversations: ConversationSummary[]; counts: Record<string, number> }>(`/workspaces/${workspaceId}/conversations?${query}`).then((r) => {
      if (cancelled) return;
      setList(r.conversations);
      setCounts(r.counts);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, query]);

  // Live events can move a conversation between tabs: re-count once they settle.
  const recount = useRef<number | null>(null);
  const scheduleRecount = useCallback(() => {
    if (recount.current) window.clearTimeout(recount.current);
    recount.current = window.setTimeout(() => {
      api<{ counts: Record<string, number> }>(`/workspaces/${workspaceId}/conversations?${query}`).then((r) => setCounts(r.counts), () => {});
    }, 2000);
  }, [workspaceId, query]);
  useEffect(() => () => {
    if (recount.current) window.clearTimeout(recount.current);
  }, []);

  const loadTags = useCallback(() => api<{ tags: Tag[] }>(`/workspaces/${workspaceId}/tags`).then((r) => setTags(r.tags)), [workspaceId]);
  const loadMentions = useCallback(() => api<{ unread: number }>(`/workspaces/${workspaceId}/mentions`).then((r) => setUnreadMentions(r.unread)), [workspaceId]);
  useEffect(() => {
    api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`).then((r) => setMembers(r.members));
    api<TrackerStatus>(`/workspaces/${workspaceId}/trackers`).then(setTrackers, () => setTrackers(null));
    void loadTags();
    void loadMentions();
    api<{ topics: Topic[] }>(`/workspaces/${workspaceId}/topics`).then((r) => setTopics(r.topics), () => setTopics([]));
  }, [workspaceId, loadTags, loadMentions]);

  // Live updates: upsert conversations that match the current filters, drop ones that don't.
  // "Mentions me" can't be checked from a summary, so that view only updates what it shows.
  useEffect(
    () =>
      hub.subscribe((event) => {
        if (event.type === "mention") {
          if (!event.userIds.includes(me.id)) return;
          void loadMentions();
          if (event.conversationId !== conversationId) setToast({ conversationId: event.conversationId, by: event.by, preview: event.preview });
          return;
        }
        if (event.type !== "conversation") return;
        const updated = event.conversation;
        setList((current) => {
          if (!current) return current;
          const rest = current.filter((c) => c.id !== updated.id);
          const keep = matches(updated) && (assignee !== "mentions" || rest.length < current.length);
          return (keep ? [updated, ...rest] : rest).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        });
        scheduleRecount();
      }),
    [hub, matches, assignee, me.id, conversationId, loadMentions, scheduleRecount],
  );

  const memberName = useCallback((id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? "Teammate" : ""), [members]);
  const shown = useMemo(() => {
    if (!list) return null;
    const filtered = search.trim() ? list.filter((c) => matchesFilter(search, [contactLabel(c.contact), c.contact.email, c.lastMessagePreview, c.topic?.name, ...c.tags])) : list;
    return sortConversations(filtered, sort, memberName);
  }, [list, search, sort, memberName]);

  const pageCount = Math.max(1, Math.ceil((shown?.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = shown?.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) ?? null;

  // j/k can step onto another page: focus the row once that page has rendered.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingFocus.current || conversationId) return;
    document.getElementById(`conv-${pendingFocus.current}`)?.focus();
    pendingFocus.current = null;
  });
  const focusRow = useCallback(
    (id: string) => {
      const at = shown?.findIndex((c) => c.id === id) ?? -1;
      if (at >= 0) setPage(Math.floor(at / PAGE_SIZE));
      pendingFocus.current = id;
    },
    [shown],
  );
  const open = (id: string) => {
    setCursor(id);
    navigate(`/inbox/${id}`);
  };
  // Closing returns focus to the conversation's row.
  const close = useCallback(() => {
    if (conversationId) focusRow(conversationId);
    navigate("/inbox");
  }, [conversationId, focusRow]);

  useBridge("inbox", {
    conversations: shown ?? [],
    move(delta) {
      if (!shown?.length) return;
      const at = shown.findIndex((c) => c.id === cursor);
      const next = shown[at === -1 ? (delta === 1 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, at + delta))]!;
      setCursor(next.id);
      // The table sits behind an open conversation, so there j/k open the next one instead.
      if (conversationId) navigate(`/inbox/${next.id}`);
      else focusRow(next.id); // focus follows the cursor, so screen readers announce it and Enter opens it
    },
    openCursor() {
      const target = shown?.find((c) => c.id === cursor) ?? shown?.[0];
      if (target) open(target.id);
    },
    focusSearch() {
      searchInput.current?.focus();
      searchInput.current?.select();
    },
    act(command) {
      const patch: ConversationPatch = command === "resolve" ? { status: "resolved" } : { assigneeId: me.id };
      const target = conversationId ?? cursor;
      if (!target) return;
      if (target === conversationId && threadUpdate.current) void threadUpdate.current(patch);
      else void api(`/conversations/${target}`, { method: "PATCH", body: patch }).catch(() => {});
    },
  });

  const unreadCount = useMemo(() => list?.filter(isUnread).length ?? 0, [list]);
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Jun Desk` : "Jun Desk";
  }, [unreadCount]);

  const columns = COLUMNS.filter((c) => c === "Person" || !hidden.has(c));
  const tabs: Tab<StatusFilter>[] = STATUS_TABS.map((t) => ({ ...t, count: counts ? counts[t.key] ?? 0 : undefined }));
  const empty =
    !shown || shown.length > 0 ? null
    : search.trim() ? `No conversations match “${search.trim()}”.`
    : ratingFilter ? "No conversations with this rating."
    : topicFilter || tagFilter || assignee !== "all" ? "No conversations match these filters."
    : status === "all" ? "No conversations yet. Install the widget from Settings to start receiving chats."
    : "No records.";

  return (
    <div className="cv-page">
      {toast && (
        <div className="toast" role="status">
          <span><strong>{toast.by}</strong> mentioned you: {toast.preview}</span>
          <Button size="sm" onClick={() => { open(toast.conversationId); setToast(null); }}>Open</Button>
          <Button variant="outline" size="sm" aria-label="Dismiss" onClick={() => setToast(null)}>×</Button>
        </div>
      )}
      {/* Behind an open conversation the table is inert: the drawer is the dialog. */}
      <div className="cv-body" inert={conversationId !== null}>
        <PageHeader title="Inbox" subtitle={`Every chat on ${workspaceName}'s desk. Read, reply, resolve.`} />
        <TabStrip
          tabs={tabs}
          active={status}
          onChange={(key) => { setStatus(key); setPage(0); }}
          search={{
            value: search,
            onChange: (value) => { setSearch(value); setPage(0); },
            placeholder: "Search conversations…",
            inputRef: searchInput,
            onKeyDown: (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (search) setSearch("");
                else e.currentTarget.blur();
              } else if (e.key === "ArrowDown" || (e.key === "Enter" && !e.nativeEvent.isComposing)) {
                // Into the table: the first match.
                const first = shown?.[0];
                if (!first) return;
                e.preventDefault();
                setCursor(first.id);
                if (e.key === "Enter") open(first.id);
                else focusRow(first.id);
              }
            },
          }}
          trailing={<ColumnPicker hidden={hidden} onToggle={toggleColumn} />}
        >
          <select data-plain className="cv-filter" value={assignee} onChange={(e) => setAssignee(e.target.value as AssigneeFilter)} aria-label="Assignee filter">
            <option value="all">Everyone's</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            <option value="mentions">Mentions me{unreadMentions > 0 ? ` (${unreadMentions} new)` : ""}</option>
          </select>
          {tags.length > 0 && (
            <select data-plain className="cv-filter" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Tag filter">
              <option value="">Any tag</option>
              {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          )}
          {(topics.length > 0 || topicFilter) && (
            <select data-plain className="cv-filter" value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} aria-label="Topic filter">
              <option value="">Any topic</option>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              {topicFilter && !topics.some((t) => t.id === topicFilter) && <option value={topicFilter}>Topic not found</option>}
            </select>
          )}
          <select
            data-plain
            className="cv-filter"
            value={ratingFilter}
            onChange={(e) => {
              const next = e.target.value as RatingFilter;
              setRatingFilter(next);
              // Rated conversations are resolved ones: don't leave the filter on an empty Open tab.
              if (next && status === "open") setStatus("all");
            }}
            aria-label="Rating filter"
          >
            <option value="">Any rating</option>
            <option value="good">Rated 👍 Good</option>
            <option value="bad">Rated 👎 Bad</option>
          </select>
        </TabStrip>
        <div className="cv-table-wrap">
          <table className="cv-table">
            <TableHead columns={columns} sort={sort} onSort={(c) => { setSort((s) => nextSort(s, c)); setPage(0); }} />
            <tbody>
              <ConversationRows rows={rows} columns={columns} selected={conversationId} cursor={cursor} empty={empty} memberName={memberName} onOpen={open} onFocusRow={setCursor} />
            </tbody>
          </table>
        </div>
        <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />
      </div>
      {conversationId && (
        <ConversationDrawer label="Conversation" onClose={close}>
          <Thread
            key={conversationId}
            conversationId={conversationId}
            workspaceId={workspaceId}
            me={me}
            members={members}
            tags={tags}
            trackers={trackers}
            onTagsChanged={() => void loadTags()}
            onOpened={() => void loadMentions()}
            onClose={close}
            updateRef={threadUpdate}
          />
        </ConversationDrawer>
      )}
    </div>
  );
}

function Thread({
  conversationId,
  workspaceId,
  me,
  members,
  tags,
  trackers,
  onTagsChanged,
  onOpened,
  onClose,
  updateRef,
}: {
  conversationId: string;
  workspaceId: string;
  me: { id: string; name: string };
  members: Member[];
  tags: Tag[];
  trackers: TrackerStatus | null;
  onTagsChanged: () => void;
  onOpened: () => void;
  onClose: () => void;
  updateRef: { current: ((patch: ConversationPatch) => Promise<void>) | null };
}) {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [filed, setFiled] = useState<ConversationIssue[]>([]);
  const [issueOpen, setIssueOpen] = useState(false);
  const [created, setCreated] = useState<FiledIssue | null>(null);
  const [initial, setInitial] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [addingTag, setAddingTag] = useState(false);
  const composer = useRef<ComposerControl>(null);

  useEffect(() => {
    api<{ conversation: ConversationSummary; messages: Message[]; issues: ConversationIssue[] }>(`/conversations/${conversationId}`).then(
      (r) => {
        setConversation(r.conversation);
        setInitial(r.messages);
        setFiled(r.issues);
        onOpened(); // opening it reads my @mentions here
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    api<{ savedReplies: SavedReply[] }>(`/workspaces/${workspaceId}/saved-replies`).then((r) => setSavedReplies(r.savedReplies), () => {});
  }, [workspaceId]);

  // AI-11: tool calls, reloaded as each one is recorded (the `ai_action` event) and when an AI reply lands.
  const [actions, setActions] = useState<AiAction[]>([]);
  const [actionTick, setActionTick] = useState(0);
  const thread = useThread({
    socketUrl: initial ? `/api/conversations/${conversationId}/ws` : null,
    initialMessages: useMemo(() => initial ?? [], [initial]),
    other: "visitor",
    onConversation: setConversation,
    onAiAction: () => setActionTick((t) => t + 1),
  });
  const aiReplies = thread.messages.filter((m) => m.authorType === "ai").length;
  useEffect(() => setActions([]), [conversationId]);
  useEffect(() => {
    let live = true;
    // A burst of calls in one turn becomes one request.
    const timer = setTimeout(() => {
      api<{ actions: AiAction[] }>(`/conversations/${conversationId}/actions`).then((r) => live && setActions(r.actions), () => {});
    }, actionTick ? 150 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [conversationId, actionTick, aiReplies]);
  const actionsBySeq = useMemo(() => {
    const by = new Map<number, AiAction[]>();
    for (const a of actions) by.set(a.messageSeq, [...(by.get(a.messageSeq) ?? []), a]);
    return by;
  }, [actions]);
  const onTyping = useTypingSignal(thread.setTyping);

  // Mark as read while the thread is open and visible.
  const latest = thread.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    const mark = () => document.visibilityState === "visible" && latest > (conversation?.agentReadSeq ?? 0) && thread.markRead(latest);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, thread.state]);

  const update = async (patch: ConversationPatch) => {
    try {
      setConversation((await api<{ conversation: ConversationSummary }>(`/conversations/${conversationId}`, { method: "PATCH", body: patch })).conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setTags = async (next: string[]) => {
    try {
      setConversation((await api<{ conversation: ConversationSummary }>(`/conversations/${conversationId}/tags`, { method: "PUT", body: { tags: next } })).conversation);
      onTagsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // S-08: issues filed from here; ones a teammate files arrive live as "Issue created" notes.
  const issues = useMemo(() => {
    const all = [...filed];
    for (const m of thread.messages) if (m.meta.issue && !all.some((i) => i.id === m.meta.issue!.id)) all.push(m.meta.issue);
    return all;
  }, [filed, thread.messages]);

  const canCreateIssue = configuredProviders(trackers).length > 0;
  const canHandBack = thread.messages.some((m) => m.authorType === "ai");
  useEffect(() => {
    updateRef.current = update;
  });
  useEffect(() => () => {
    updateRef.current = null;
  }, [updateRef]);
  // I-13: what the command palette and shortcuts can do here.
  useBridge(
    "thread",
    conversation
      ? {
          conversation,
          members,
          knownTags: tags.map((t) => t.name),
          savedReplies,
          canCreateIssue,
          canHandBack,
          update,
          addTag: (name) => (conversation.tags.some((t) => t.toLowerCase() === name.toLowerCase()) ? Promise.resolve() : setTags([...conversation.tags, name])),
          startTag: () => setAddingTag(true),
          focusComposer: (mode) => composer.current?.focus(mode),
          insertReply: (reply) => composer.current?.insert(fillSavedReply(reply.body, { customerName: conversation.contact.name, agentName: me.name })),
          createIssue: () => {
            if (canCreateIssue) setIssueOpen(true);
          },
        }
      : null,
  );

  if (error || !conversation || !initial) {
    return (
      <>
        <div className="cv-drawer-head"><span /><DrawerClose onClose={onClose} /></div>
        <p className={`cv-drawer-state ${error ? "error" : ""}`}>{error ?? "Loading…"}</p>
      </>
    );
  }
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Teammate";

  // Refresh the side panel's browser context when the visitor writes or the AI answers.
  const visitorMessages = thread.messages.filter((m) => m.authorType === "visitor" || m.authorType === "ai").length;
  return (
    <>
      <header className="cv-drawer-head">
        <div className="cv-drawer-title">
          <div className="cv-drawer-name">
            {contactLabel(conversation.contact)}
            {conversation.contact.verified && <span className="verified" title="Identity verified by your site">✓</span>}
            <CsatBadge rating={conversation.csat.rating} />
            <IntentBadge intent={conversation.intent} />
          </div>
          <div className="cv-drawer-meta">
            <span>{thread.state === "open" ? "Live" : thread.state === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
            <span>· started {formatTime(conversation.createdAt)}</span>
            {conversation.topic && <span title="Topic, labelled by the AI">· {conversation.topic.name}</span>}
            {conversation.contact.email && contactLabel(conversation.contact) !== conversation.contact.email && <span>· {conversation.contact.email}</span>}
          </div>
        </div>
        <div className="cv-drawer-actions">
        <NativeSelect size="sm" value={conversation.assigneeId ?? ""} onChange={(e) => void update({ assigneeId: e.target.value || null })} aria-label="Assignee">
          <NativeSelectOption value="">Unassigned</NativeSelectOption>
          {members.map((m) => (
            <NativeSelectOption key={m.id} value={m.id}>{m.id === me.id ? `${m.name} (me)` : m.name}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect size="sm" value={conversation.status} onChange={(e) => void update({ status: e.target.value as ConversationStatus })} aria-label="Status">
          <NativeSelectOption value="open">Open</NativeSelectOption>
          <NativeSelectOption value="pending">Pending</NativeSelectOption>
          <NativeSelectOption value="snoozed">Snoozed</NativeSelectOption>
          <NativeSelectOption value="resolved">Resolved</NativeSelectOption>
        </NativeSelect>
        {conversation.status !== "resolved" && <Button size="sm" onClick={() => void update({ status: "resolved" })}>Resolve</Button>}
        <span className="issue-button">
          <Button variant="outline" size="sm" disabled={configuredProviders(trackers).length === 0} title={configuredProviders(trackers).length ? "Draft an issue from this conversation" : "Connect GitHub or Linear in Settings first"} onClick={() => setIssueOpen(true)}>
            Create issue
          </Button>
          {trackers && configuredProviders(trackers).length === 0 && (
            <a className="small" href="/settings/integrations#issue-trackers" onClick={(e) => { e.preventDefault(); navigate("/settings/integrations#issue-trackers"); }}>Set up</a>
          )}
        </span>
        <DrawerClose onClose={onClose} />
        </div>
      </header>
      <div className="cv-drawer-body">
      <section className="thread">
      <TagEditor tags={conversation.tags} known={tags} onChange={(next) => void setTags(next)} adding={addingTag} setAdding={setAddingTag} />
      {issues.length > 0 && (
        <div className="issue-bar small">
          <span className="muted">Issues</span>
          {issues.map((i) => (
            <a key={i.id} className="chip issue-chip" href={i.url} target="_blank" rel="noreferrer" title={i.title}>
              {i.key} <span className="clip issue-chip-title">{i.title}</span>
            </a>
          ))}
        </div>
      )}
      {issueOpen && trackers && configuredProviders(trackers).length > 0 && (
        <IssueDialog
          conversationId={conversationId}
          trackers={trackers}
          onClose={() => setIssueOpen(false)}
          onCreated={(result) => {
            const { issue } = result;
            setFiled((current) => (current.some((i) => i.id === issue.id) ? current : [...current, issue]));
            setCreated(result);
            setIssueOpen(false);
          }}
        />
      )}
      {created && (
        <div className="toast" role="status">
          <span>
            Created <a href={created.issue.url} target="_blank" rel="noreferrer">{created.issue.key}</a>
            {created.notice && <span className="error"> · {created.notice}</span>}
          </span>
          <Button variant="outline" size="sm" aria-label="Dismiss" onClick={() => setCreated(null)}>×</Button>
        </div>
      )}
      {conversation.handling === "ai" ? (
        <div className="ai-banner small">
          <span>🤖 The AI assistant is answering this conversation. Replying yourself takes it over.</span>
          <span className="spacer" />
          <Button variant="outline" size="sm" onClick={() => void update({ handling: "human" })}>Take over</Button>
        </div>
      ) : (
        thread.messages.some((m) => m.authorType === "ai") && (
          <div className="ai-banner small muted">
            <span>A teammate is handling this conversation.</span>
            <span className="spacer" />
            <Button variant="outline" size="sm" onClick={() => void update({ handling: "ai" })}>Hand back to AI</Button>
          </div>
        )
      )}
      {/* The transcript markup is shared with the widget; only the dashboard scrolls it in a ScrollArea. */}
      <ScrollArea className="messages-area">
      <MessageList
        messages={thread.messages}
        pending={thread.pending}
        mine={(m) => m.authorType !== "visitor"}
        authorLabel={(m) =>
          m.authorType === "visitor" ? contactLabel(conversation.contact) : m.authorType === "ai" ? "AI assistant" : m.authorId === me.id ? "You" : m.authorName ?? memberName(m.authorId)
        }
        otherReadSeq={Math.max(thread.otherReadSeq, conversation.visitorReadSeq)}
        typing={thread.typing}
        aiStream={thread.aiStream}
        aiThinking={thread.aiThinking}
        aiTurn={thread.aiTurn}
        onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId, undefined, p.internal)}
        onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
        mentionNames={members.map((m) => m.name)}
        aiActions={(seq) => {
          const calls = actionsBySeq.get(seq);
          return calls ? <ToolCalls actions={calls} defaultOpen={false} /> : null;
        }}
      />
      </ScrollArea>
      <Composer
        control={composer}
        placeholder={savedReplies.length ? "Reply… (/ for saved replies, Shift+Enter for a new line)" : "Reply… (Enter to send, Shift+Enter for a new line)"}
        upload={(file) => uploadFile(`/api/workspaces/${workspaceId}/files`, file)}
        onTyping={onTyping}
        notes
        suggestScroller={SuggestScroller}
        mentionables={members.filter((m) => m.id !== me.id)}
        savedReplies={savedReplies}
        fillReply={(body) => fillSavedReply(body, { customerName: conversation.contact.name, agentName: me.name })}
        onSend={(body, attachments, { internal }) => {
          if (!internal) thread.setTyping(false);
          thread.send(body, attachments, undefined, undefined, internal);
        }}
      />
      </section>
      <DebugPanel conversationId={conversationId} workspaceId={workspaceId} contact={conversation.contact} refreshKey={visitorMessages + conversation.debugIssueCount * 1000} actions={actions} />
      </div>
    </>
  );
}

/** I-07: the conversation's tags, with an input that suggests existing ones. */
function TagEditor({ tags, known, onChange, adding, setAdding }: { tags: string[]; known: Tag[]; onChange: (tags: string[]) => void; adding: boolean; setAdding: (adding: boolean) => void }) {
  const [value, setValue] = useState("");
  const add = () => {
    const name = value.trim();
    setValue("");
    setAdding(false);
    if (name && !tags.some((t) => t.toLowerCase() === name.toLowerCase())) onChange([...tags, name]);
  };
  return (
    <div className="tag-bar small">
      {tags.map((t) => (
        <span key={t} className="chip tag-chip">
          {t}
          <Button variant="link" size="xs" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</Button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input
            autoFocus
            list="known-tags"
            value={value}
            maxLength={40}
            placeholder="Tag name"
            aria-label="New tag"
            onChange={(e) => setValue(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setValue("");
                setAdding(false);
              }
            }}
          />
          <datalist id="known-tags">
            {known.filter((k) => !tags.includes(k.name)).map((k) => <option key={k.id} value={k.name} />)}
          </datalist>
        </form>
      ) : (
        <Button variant="link" onClick={() => setAdding(true)}>+ Tag</Button>
      )}
    </div>
  );
}
