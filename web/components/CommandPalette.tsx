import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ConversationSummary } from "../../shared/protocol.ts";
import { contactLabel } from "../../shared/notifications.ts";
import { api } from "../api.ts";
import { bridge, modKey, type ThreadBridge } from "../lib/bridge.ts";
import { rankScored, SHORTCUT_HELP } from "../lib/commands.ts";
import { navigate } from "../lib/router.ts";
import { setThemePref, THEME_LABEL, THEME_PREFS } from "../lib/theme.ts";
import { Button } from "@/components/ui/button.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";

interface Item {
  id: string;
  label: string;
  detail?: string | null;
  /** Extra text the search matches (an email, tags…), not shown. */
  keywords?: (string | null | undefined)[];
  /** Its keyboard shortcut, shown on the right. */
  hint?: string;
  /** A status, shown on the right. */
  meta?: string;
  run?: () => void | Promise<void>;
  /** Opens a sub-list instead (Assign to…, Add tag…). */
  page?: () => Page;
}
interface Group { label: string; items: Item[]; limit?: number }
interface Page { title: string; placeholder: string; groups: (query: string) => Group[] }

const NAVIGATION: { label: string; path: string; hint?: string }[] = [
  { label: "Dashboard", path: "/dashboard", hint: "g d" },
  { label: "Inbox", path: "/inbox", hint: "g i" },
  { label: "Visitors", path: "/visitors", hint: "g v" },
  { label: "Knowledge", path: "/knowledge" },
  { label: "Agent", path: "/agent" },
  { label: "Agent: Tasks", path: "/agent/tasks" },
  { label: "Agent: Actions", path: "/agent/actions" },
  { label: "Agent: Widgets", path: "/agent/widgets" },
  { label: "Agent: Tests", path: "/agent/tests" },
  { label: "Chat widget", path: "/appearance" },
  { label: "Settings", path: "/settings", hint: "g s" },
];
/**
 * Settings sections, found by their heading where they live (so they need no ids): the settings
 * dialog's sections, the Widget page's Install tab and the Agent page's Settings tab.
 */
const SETTINGS_SECTIONS: { heading: string; path: string; area?: string }[] = [
  { heading: "General", path: "/settings/general" },
  { heading: "Install the chat widget", path: "/appearance/install", area: "Chat widget" },
  { heading: "Allowed websites", path: "/appearance/install", area: "Chat widget" },
  { heading: "Proactive help", path: "/appearance/install", area: "Chat widget" },
  { heading: "Identify signed-in customers", path: "/appearance/install", area: "Chat widget" },
  { heading: "AI replies", path: "/settings/ai" },
  { heading: "Assignment", path: "/settings/inbox" },
  { heading: "Business hours", path: "/settings/inbox" },
  { heading: "Saved replies", path: "/settings/inbox" },
  { heading: "Tags", path: "/settings/inbox" },
  { heading: "Topics", path: "/settings/inbox" },
  { heading: "Team", path: "/settings/team" },
  { heading: "Notifications", path: "/settings/notifications" },
  { heading: "Issue trackers", path: "/settings/integrations" },
  { heading: "API tokens", path: "/settings/developer" },
  { heading: "Your passkeys", path: "/settings/account" },
];

/** Opens the settings dialog or page tab that holds this heading and scrolls to it once it has rendered. */
export function goToSettingsSection(heading: string): void {
  navigate(SETTINGS_SECTIONS.find((s) => s.heading === heading)?.path ?? "/settings");
  let tries = 0;
  const find = () => {
    const h = Array.from(document.querySelectorAll<HTMLElement>(".settings-card-head h2")).find((h) => h.textContent?.trim() === heading);
    if (h) {
      const target = h.closest("section") ?? h;
      target.scrollIntoView({ block: "start" });
      // Sections above it still loading push it down: scroll again once they have.
      for (const ms of [300, 900]) window.setTimeout(() => target.isConnected && target.scrollIntoView({ block: "start" }), ms);
    } else if (++tries < 40) window.setTimeout(find, 75);
  };
  window.setTimeout(find, 0);
}

const STATUS_LABEL: Record<string, string> = { open: "Open", pending: "Pending", snoozed: "Snoozed", resolved: "Resolved" };

/** I-13: Ctrl+K / ⌘K. Conversations, navigation and, with a conversation open, its actions. */
export function CommandPalette({
  workspaceId,
  meId,
  onClose,
  onHelp,
  onToast,
}: {
  workspaceId: string;
  meId: string;
  /** Closes the palette and puts focus back where it was. */
  onClose: (then?: () => void) => void;
  onHelp: () => void;
  onToast: (text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState<Page[]>([]);
  const [active, setActive] = useState(0);
  const [fetched, setFetched] = useState<ConversationSummary[]>([]);
  const ids = useId();
  // Snapshot when opened: the palette lists what was on screen at that moment.
  const [thread] = useState<ThreadBridge | null>(() => (window.location.pathname.startsWith("/inbox/") ? bridge.thread : null));
  const [shown] = useState<ConversationSummary[]>(() => bridge.inbox?.conversations ?? []);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    input.current?.focus();
    let cancelled = false;
    // The list you're looking at comes first; the 100 most recent of every status fill in the rest.
    api<{ conversations: ConversationSummary[] }>(`/workspaces/${workspaceId}/conversations?status=all`).then(
      (r) => !cancelled && setFetched(r.conversations),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const root = useMemo<Page>(() => {
    const conversations = [...shown, ...fetched.filter((c) => !shown.some((s) => s.id === c.id))];
    const conversationItems = conversations.map<Item>((c) => ({
      id: `c-${c.id}`,
      label: contactLabel(c.contact),
      detail: c.lastMessagePreview,
      keywords: [c.contact.email, c.topic?.name, ...c.tags],
      meta: STATUS_LABEL[c.status],
      run: () => navigate(`/inbox/${c.id}`),
    }));
    const navItems: Item[] = [
      ...NAVIGATION.map<Item>((n) => ({ id: `n-${n.path}`, label: `Go to ${n.label}`, hint: n.hint, run: () => navigate(n.path) })),
      ...SETTINGS_SECTIONS.map<Item>(({ heading, area }) => ({ id: `s-${heading}`, label: `${area ?? "Settings"}: ${heading}`, run: () => goToSettingsSection(heading) })),
      { id: "help", label: "Keyboard shortcuts", hint: "?", run: onHelp },
      ...THEME_PREFS.map<Item>((t) => ({ id: `theme-${t}`, label: `Theme: ${THEME_LABEL[t]}`, keywords: ["appearance", "light", "dark", "mode"], run: () => setThemePref(t) })),
    ];
    return {
      title: "",
      placeholder: thread ? "Search conversations, actions and pages…" : "Search conversations and pages…",
      groups: (q) => [
        ...(thread ? [{ label: `Conversation with ${contactLabel(thread.conversation.contact)}`, items: threadActions(thread, meId, onToast) }] : []),
        // Without a query: the most recent few; with one: the best matches.
        { label: "Conversations", items: q ? conversationItems : conversationItems.slice(0, 5), limit: 8 },
        { label: "Go to", items: q ? navItems : navItems.slice(0, NAVIGATION.length) },
      ],
    };
  }, [shown, fetched, thread, meId, onHelp, onToast]);

  const page = stack.at(-1) ?? root;
  const groups = useMemo(() => {
    const ranked = page
      .groups(query)
      .map((g) => {
        const items = rankScored(query, g.items, (i) => [i.label, i.detail, ...(i.keywords ?? [])]).slice(0, g.limit ?? Infinity);
        return { label: g.label, items: items.map((r) => r.item), top: items[0]?.score ?? 0 };
      })
      .filter((g) => g.items.length > 0);
    // With a query, the group holding the best match goes first.
    return query.trim() ? ranked.sort((a, b) => b.top - a.top) : ranked;
  }, [page, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const optionId = (i: number) => `${ids}-o${i}`;

  useEffect(() => setActive(0), [query, stack.length]);
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.page) {
      setStack((s) => [...s, item.page!()]);
      setQuery("");
      input.current?.focus();
      return;
    }
    onClose(() => void item.run?.()); // focus goes back first, then the action may move it (Reply focuses the composer)
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the palette
    } else if (e.key === "Backspace" && query === "" && stack.length > 0) {
      e.preventDefault();
      setStack((s) => s.slice(0, -1));
    }
  };

  let index = -1;
  return (
    <dialog
      ref={dialog}
      className="palette"
      role="dialog"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      <div className="palette-search">
        {stack.length > 0 && <span className="chip palette-crumb">{page.title}</span>}
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-autocomplete="list"
          aria-activedescendant={flat.length ? optionId(active) : undefined}
          aria-label={page.title || "Search commands"}
          placeholder={page.placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {/* Focus stays in the search input, so the scroller is no tab stop. */}
      <ScrollArea className="palette-list" viewportProps={{ tabIndex: -1 }}>
      <div id={`${ids}-list`} className="palette-options" role="listbox" aria-label="Results">
        {groups.map((g, gi) => (
          <div key={g.label} role="group" aria-labelledby={`${ids}-g${gi}`}>
            <div id={`${ids}-g${gi}`} className="palette-group" role="presentation">{g.label}</div>
            {g.items.map((item) => {
              const i = ++index;
              return (
                <div
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${i === active ? "active" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                  onClick={() => choose(item)}
                >
                  <span className="palette-label">
                    {item.label}
                    {item.page && "…"}
                    {item.detail && <span className="muted small palette-detail">{item.detail}</span>}
                  </span>
                  {item.meta && <span className="muted small palette-meta">{item.meta}</span>}
                  {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="muted small pad">{stack.length === 0 ? "No matches." : "Nothing to pick here."}</p>}
      </div>
      </ScrollArea>
      <div className="palette-foot muted small" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> run</span>
        {stack.length > 0 && <span><kbd>⌫</kbd> back</span>}
        <span><kbd>Esc</kbd> close</span>
      </div>
    </dialog>
  );
}

function threadActions(t: ThreadBridge, meId: string, onToast: (text: string) => void): Item[] {
  const c = t.conversation;
  const items: Item[] = [
    { id: "reply", label: "Reply", hint: "r", run: () => t.focusComposer("reply") },
    { id: "note", label: "Write a note", hint: "n", run: () => t.focusComposer("note") },
  ];
  if (c.assigneeId !== meId) items.push({ id: "assign-me", label: "Assign to me", hint: "a", run: () => t.update({ assigneeId: meId }) });
  const others = t.members.filter((m) => m.id !== c.assigneeId && m.id !== meId);
  if (others.length > 0) {
    items.push({
      id: "assign",
      label: "Assign to teammate",
      keywords: ["teammate", "reassign"],
      page: () => ({
        title: "Assign to teammate",
        placeholder: "Teammate…",
        groups: () => [{ label: "Teammates", items: others.map((m) => ({ id: `m-${m.id}`, label: m.name, run: () => t.update({ assigneeId: m.id }) })) }],
      }),
    });
  }
  if (c.assigneeId) items.push({ id: "unassign", label: "Unassign", run: () => t.update({ assigneeId: null }) });
  if (c.status !== "resolved") items.push({ id: "resolve", label: "Resolve", hint: "e", keywords: ["close", "done"], run: () => t.update({ status: "resolved" }) });
  if (c.status !== "open") items.push({ id: "reopen", label: "Reopen", keywords: ["open"], run: () => t.update({ status: "open" }) });
  if (c.status !== "pending") items.push({ id: "pending", label: "Mark as pending", keywords: ["waiting"], run: () => t.update({ status: "pending" }) });
  if (c.handling === "ai") items.push({ id: "take-over", label: "Take over from the AI", keywords: ["human", "handoff"], run: () => t.update({ handling: "human" }) });
  else if (t.canHandBack) items.push({ id: "hand-back", label: "Hand back to the AI", keywords: ["assistant", "bot"], run: () => t.update({ handling: "ai" }) });
  items.push({
    id: "tag",
    label: "Add tag",
    hint: "t",
    keywords: ["label"],
    page: () => ({
      title: "Add tag",
      placeholder: "Tag name…",
      groups: (q) => {
        const name = q.trim().slice(0, 40);
        const known = t.knownTags.filter((k) => !c.tags.some((x) => x.toLowerCase() === k.toLowerCase()));
        const exists = name !== "" && [...known, ...c.tags].some((k) => k.toLowerCase() === name.toLowerCase());
        return [
          { label: "Tags", items: known.map((k) => ({ id: `t-${k}`, label: k, run: () => t.addTag(k) })) },
          ...(name && !exists ? [{ label: "New", items: [{ id: "t-new", label: `Create tag “${name}”`, keywords: [name], run: () => t.addTag(name) }] }] : []),
        ];
      },
    }),
  });
  if (t.savedReplies.length > 0) {
    items.push({
      id: "saved-reply",
      label: "Insert saved reply",
      keywords: ["canned", "macro", "template"],
      page: () => ({
        title: "Saved reply",
        placeholder: "Search saved replies…",
        groups: () => [{ label: "Saved replies", items: t.savedReplies.map((r) => ({ id: `r-${r.id}`, label: r.title, detail: r.body.slice(0, 120), run: () => t.insertReply(r) })) }],
      }),
    });
  }
  if (t.canCreateIssue) items.push({ id: "issue", label: "Create issue", keywords: ["github", "linear", "bug"], run: () => t.createIssue() });
  items.push({
    id: "copy-link",
    label: "Copy link to conversation",
    keywords: ["url", "share"],
    run: async () => {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/inbox/${c.id}`);
        onToast("Link copied");
      } catch {
        onToast("Couldn't copy the link");
      }
    },
  });
  return items;
}

/** I-13: the "?" sheet. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    close.current?.focus();
  }, []);
  const mod = modKey();
  return (
    <dialog
      ref={dialog}
      className="shortcuts"
      role="dialog"
      aria-labelledby="shortcuts-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === dialog.current && onClose()}
    >
      {/* The whole sheet scrolls, as the dialog did. Focus starts on Esc inside it, so keys scroll it without a tab stop. */}
      <ScrollArea viewportProps={{ tabIndex: -1 }}>
      <div className="shortcuts-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <span className="spacer" />
        <Button variant="outline" size="sm" ref={close} onClick={() => onClose()} aria-label="Close">Esc</Button>
      </div>
      <div className="shortcuts-body">
        {SHORTCUT_HELP.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            <dl>
              {g.keys.map((k) => (
                <div key={k.label} className="shortcut-row">
                  <dt>{k.label}</dt>
                  <dd>
                    <Keys keys={k.keys} mod={mod} />
                    {k.alt && (
                      <>
                        <span className="muted small"> or </span>
                        <Keys keys={k.alt} mod={mod} />
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted small shortcuts-foot">Single-key shortcuts are off while you type. Press Esc to leave a text field.</p>
      </ScrollArea>
    </dialog>
  );
}

/** One shortcut's keys: "g then i" for sequences, side by side for chords (Ctrl K). */
function Keys({ keys, mod }: { keys: string[]; mod: string }) {
  return keys.map((key, i) => (
    <span key={i}>
      {i > 0 && (keys[0] === "g" ? <span className="muted small"> then </span> : " ")}
      <kbd>{key === "Ctrl" ? mod : key}</kbd>
    </span>
  ));
}
