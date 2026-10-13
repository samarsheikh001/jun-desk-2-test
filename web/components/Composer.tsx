import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { Attachment } from "../../shared/protocol.ts";
import { canCaptureScreen, captureScreen } from "../lib/screenshot.ts";
import { formatSize } from "../lib/thread.ts";

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

/** I-13: lets the inbox's shortcuts and command palette drive the composer. */
export interface ComposerControl {
  /** Focuses the input, switching to Reply or Note first (`notes` only). */
  focus(mode?: "reply" | "note"): void;
  /** Inserts text (a saved reply): replaces an empty draft, otherwise goes on a new line. */
  insert(text: string): void;
}

type Suggestion = { kind: "mention"; id: string; label: string; start: number } | { kind: "reply"; id: string; label: string; body: string };

/**
 * Message input with attachments. Enter sends, Shift+Enter adds a line. In the dashboard it
 * also writes internal notes with @mentions (I-05) and inserts saved replies with "/" (I-06).
 * Ctrl/⌘+Enter sends too, even with suggestions open; in the dashboard Esc leaves the input (I-13).
 */
export function Composer({
  placeholder,
  disabled,
  upload,
  onSend,
  onTyping,
  notes,
  mentionables = [],
  savedReplies = [],
  fillReply = (body) => body,
  screenshot = false,
  control,
  suggestScroller: SuggestScroller,
  pill = false,
}: {
  placeholder: string;
  disabled?: boolean;
  upload: (file: File) => Promise<Attachment>;
  onSend: (body: string, attachments: Attachment[], options: { internal: boolean }) => void | Promise<void>;
  onTyping?: (value: string) => void;
  /** Offer a Reply / Note switch (agents only). */
  notes?: boolean;
  mentionables?: { id: string; name: string }[];
  savedReplies?: SavedReply[];
  fillReply?: (body: string) => string;
  /** S-15: offer "Send a screenshot" (the widget), where the browser supports it. */
  screenshot?: boolean;
  control?: Ref<ComposerControl>;
  /**
   * The dashboard scrolls the suggestions in a shadcn ScrollArea; passed in (not imported) so
   * the widget, which shares this component, keeps its own markup and bundle.
   */
  suggestScroller?: ComponentType<{ className: string; children: ReactNode }>;
  /**
   * The widget's composer (the chat window and the W-04 bar, D-32): one box with "+" (files,
   * screenshot), the input and Send; the input moves above the buttons once the text wraps.
   */
  pill?: boolean;
}) {
  const [body, setBody] = useState("");
  const [note, setNote] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const suggestList = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // S-15: a captured screenshot waiting for the visitor to send or discard it.
  const canShoot = useMemo(() => screenshot && canCaptureScreen(), [screenshot]);
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [shooting, setShooting] = useState(false);
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);
  // The widget's "+" menu and its two-row layout (pill only).
  const [plusOpen, setPlusOpen] = useState(false);
  const [tool, setTool] = useState(0);
  const [toolBox, setToolBox] = useState<{ top: number; height: number } | null>(null);
  const [wide, setWide] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const toolRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const measure = useRef<HTMLSpanElement>(null);
  const inlineWidth = useRef(Infinity);

  const before = body.slice(0, caret);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (dismissed === before) return [];
    const reply = /^\/([^\n]*)$/.exec(body);
    if (reply && savedReplies.length) {
      const q = reply[1]!.trim().toLowerCase();
      return savedReplies
        .filter((r) => r.title.toLowerCase().includes(q) || (q.length > 2 && r.body.toLowerCase().includes(q)))
        .slice(0, 8)
        .map((r) => ({ kind: "reply", id: r.id, label: r.title, body: r.body }));
    }
    const mention = note ? /(?:^|\s)@([\p{L}\p{N}_]*(?: [\p{L}\p{N}_]*)?)$/u.exec(before) : null;
    if (mention) {
      const q = mention[1]!.toLowerCase();
      return mentionables
        .filter((m) => m.name.toLowerCase().startsWith(q))
        .slice(0, 8)
        .map((m) => ({ kind: "mention", id: m.id, label: m.name, start: before.length - q.length - 1 }));
    }
    return [];
  }, [body, before, note, mentionables, savedReplies, dismissed]);
  const open = suggestions.length > 0;

  useEffect(() => setActive(0), [suggestions.length]);
  useEffect(() => {
    suggestList.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [body]);

  const change = (value: string) => {
    setBody(value);
    // Notes stay between agents: don't show the visitor "typing…" for them.
    if (!note) onTyping?.(value);
  };

  const pick = (s: Suggestion) => {
    if (s.kind === "reply") {
      const filled = fillReply(s.body);
      pendingCaret.current = filled.length;
      change(filled);
    } else {
      const inserted = `${body.slice(0, s.start)}@${s.label} `;
      pendingCaret.current = inserted.length;
      change(inserted + body.slice(caret));
    }
    input.current?.focus();
  };

  const switchMode = (toNote: boolean) => {
    if (toNote === note) return;
    if (toNote) onTyping?.("");
    setNote(toNote);
    input.current?.focus();
  };

  useImperativeHandle(control, () => ({
    focus(mode) {
      if (mode && notes) switchMode(mode === "note");
      input.current?.focus();
    },
    insert(text) {
      const next = body.trim() ? `${body.replace(/\s+$/, "")}\n${text}` : text;
      pendingCaret.current = next.length;
      change(next);
      input.current?.focus();
    },
  }));

  const submit = async () => {
    if (disabled || uploading > 0 || (!body.trim() && attachments.length === 0)) return;
    const [text, files] = [body, attachments];
    setBody("");
    setAttachments([]);
    await onSend(text, files, { internal: note });
  };

  const addFiles = async (files: FileList | null) => {
    setError(null);
    for (const file of Array.from(files ?? [])) {
      setUploading((n) => n + 1);
      try {
        const attachment = await upload(file);
        setAttachments((a) => [...a, attachment]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const takeScreenshot = async () => {
    setError(null);
    setShooting(true);
    try {
      const file = await captureScreen();
      if (file) setShot({ file, url: URL.createObjectURL(file) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setShooting(false);
    }
  };

  /** Sends the screenshot now, with whatever the visitor already typed or attached. */
  const sendShot = async () => {
    if (!shot) return;
    setUploading((n) => n + 1);
    try {
      const attachment = await upload(shot.file);
      setShot(null);
      const [text, files] = [body, attachments];
      setBody("");
      setAttachments([]);
      await onSend(text, [...files, attachment], { internal: note });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  // Focus stays on "+" while the file picker or the capture prompt is up, so the bar (which
  // folds when the frame loses focus) can tell it apart from a click elsewhere on the page.
  const tools = [
    { key: "files", label: "Add photos & files", desc: "From your device", icon: CLIP, run: () => fileInput.current?.click() },
    ...(canShoot ? [{ key: "shot", label: "Take a screenshot", desc: "You check it before it's sent", icon: CAMERA, run: () => void takeScreenshot() }] : []),
  ];
  const runTool = (i: number) => {
    setPlusOpen(false);
    plus.current?.focus();
    tools[i]?.run();
  };

  // A single highlight glides to the active row of the "+" menu.
  useLayoutEffect(() => {
    const row = toolRefs.current[tool];
    if (plusOpen && row) setToolBox({ top: row.offsetTop, height: row.offsetHeight });
  }, [plusOpen, tool]);
  useEffect(() => {
    if (plusOpen) toolRefs.current[tool]?.focus();
  }, [plusOpen, tool]);
  useEffect(() => {
    if (!plusOpen) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".composer-plus, .composer-menu")) setPlusOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [plusOpen]);

  // The input sits between "+" and Send until its text would wrap (or has a line break), then
  // takes the whole first row; it grows with the text up to its CSS max-height, then scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    const m = measure.current;
    if (!pill || !el || !m) return;
    const style = getComputedStyle(el);
    if (!wide) inlineWidth.current = el.clientWidth;
    m.style.font = style.font;
    m.style.letterSpacing = style.letterSpacing;
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const needsRow = body.includes("\n") || m.offsetWidth + padding + 2 > inlineWidth.current;
    if (needsRow !== wide) setWide(needsRow);
    el.style.height = "0px";
    const max = parseFloat(style.maxHeight) || 120;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [pill, body, wide]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // an IME is composing: its keys aren't ours
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[active] ?? suggestions[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(before);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // Agents: Esc leaves the input so single-key shortcuts work again (the draft stays).
    if (e.key === "Escape" && notes) {
      e.preventDefault();
      input.current?.blur();
    }
  };

  return (
    <div className={`composer ${note ? "note" : ""} ${pill ? "pill" : ""}`}>
      {notes && (
        <div className="composer-modes" role="tablist">
          <button role="tab" aria-selected={!note} className={`mode ${note ? "" : "active"}`} onClick={() => switchMode(false)}>Reply</button>
          <button role="tab" aria-selected={note} className={`mode ${note ? "active" : ""}`} onClick={() => switchMode(true)}>Note</button>
          {note && <span className="muted small">Only your team sees notes. Type @ to mention someone.</span>}
        </div>
      )}
      {!pill && (attachments.length > 0 || uploading > 0 || error) && (
        <div className="composer-files">
          {attachments.map((a) => (
            <span key={a.key} className="chip">
              📎 {a.name} <span className="muted">{formatSize(a.size)}</span>
              <button className="link" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y.key !== a.key))}>×</button>
            </span>
          ))}
          {uploading > 0 && <span className="muted small">Uploading…</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      )}
      {shot && (
        <div className="composer-shot" role="group" aria-label="Screenshot preview">
          <img src={shot.url} alt="Your screenshot" />
          <div className="composer-shot-actions">
            <span className="muted small">Check it shows nothing private. It's sent only if you press Send.</span>
            <button className="ghost small" disabled={uploading > 0} onClick={() => setShot(null)}>Discard</button>
            <button className="small" disabled={disabled || uploading > 0} onClick={() => void sendShot()}>{uploading > 0 ? "Sending…" : "Send screenshot"}</button>
          </div>
        </div>
      )}
      {open && (() => {
        const list = (
          <ul ref={suggestList} className={SuggestScroller ? "suggest-list" : "suggest"} role="listbox" aria-label={suggestions[0]!.kind === "reply" ? "Saved replies" : "Mention a teammate"}>
            {suggestions.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
                <span className="strong">{s.kind === "mention" ? `@${s.label}` : s.label}</span>
                {s.kind === "reply" && <span className="muted small"> {s.body.slice(0, 80)}</span>}
              </li>
            ))}
          </ul>
        );
        return SuggestScroller ? <SuggestScroller className="suggest">{list}</SuggestScroller> : list;
      })()}
      {pill ? (
        <>
          {plusOpen && (
            <div
              className="composer-menu"
              role="menu"
              aria-label="Add to your message"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setTool((i) => (i + (e.key === "ArrowDown" ? 1 : tools.length - 1)) % tools.length);
                } else if (e.key === "Escape" || e.key === "Tab") {
                  e.preventDefault();
                  e.nativeEvent.stopImmediatePropagation(); // Esc closes the menu, not the bar
                  setPlusOpen(false);
                  plus.current?.focus();
                }
              }}
            >
              <span aria-hidden="true" className="composer-menu-glide" style={toolBox ? { top: toolBox.top, height: toolBox.height } : { opacity: 0 }} />
              {tools.map((t, i) => (
                <button
                  key={t.key}
                  type="button"
                  role="menuitem"
                  tabIndex={i === tool ? 0 : -1}
                  ref={(el) => {
                    toolRefs.current[i] = el;
                  }}
                  onMouseEnter={() => setTool(i)}
                  onClick={() => runTool(i)}
                >
                  <span className="composer-menu-icon">{t.icon}</span>
                  <span className="composer-menu-label">{t.label}</span>
                  <span className="composer-menu-desc">{t.desc}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`composer-box ${wide ? "wide" : ""}`}>
            <span ref={measure} className="composer-measure" aria-hidden="true">{body}</span>
            {(attachments.length > 0 || uploading > 0 || error) && (
              <div className="composer-files">
                {attachments.map((a) => (
                  <span key={a.key} className="composer-file">
                    {FILE}
                    <span className="composer-file-name">{a.name}</span>
                    <span className="muted">{formatSize(a.size)}</span>
                    <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y.key !== a.key))}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                  </span>
                ))}
                {uploading > 0 && <span className="muted small">Uploading…</span>}
                {error && <span className="error small">{error}</span>}
              </div>
            )}
            <div className="composer-grid">
              <button
                ref={plus}
                type="button"
                className={`composer-plus ${plusOpen ? "active" : ""}`}
                title={tools.length > 1 ? "Add files or a screenshot" : "Attach files"}
                aria-label={tools.length > 1 ? "Add files or a screenshot" : "Attach files"}
                aria-haspopup={tools.length > 1 ? "menu" : undefined}
                aria-expanded={tools.length > 1 ? plusOpen : undefined}
                disabled={disabled || shooting}
                onClick={() => {
                  if (tools.length === 1) return runTool(0);
                  setTool(0);
                  setPlusOpen((o) => !o);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
              <textarea
                ref={input}
                rows={1}
                value={body}
                placeholder={placeholder}
                disabled={disabled}
                aria-label="Message"
                onChange={(e) => change(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  if (e.clipboardData.files.length > 0) {
                    e.preventDefault();
                    void addFiles(e.clipboardData.files);
                  }
                }}
              />
              <button className="composer-send" aria-label="Send" disabled={disabled || uploading > 0 || (!body.trim() && attachments.length === 0)} onClick={() => void submit()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </div>
          </div>
        </>
      ) : (
      <div className="composer-row">
        <button className="ghost icon" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>{CLIP}</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
        {canShoot && (
          <button className="ghost icon" title="Send a screenshot" aria-label="Send a screenshot" disabled={disabled || shooting || shot !== null} onClick={() => void takeScreenshot()}>
            {CAMERA}
          </button>
        )}
        <textarea
          ref={input}
          rows={1}
          value={body}
          placeholder={note ? "Note for your team… (@ to mention)" : placeholder}
          disabled={disabled}
          aria-label={note ? "Note" : "Message"}
          onChange={(e) => {
            setCaret(e.target.selectionStart);
            change(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
        />
        <button disabled={disabled || uploading > 0 || (!body.trim() && attachments.length === 0)} onClick={() => void submit()}>{note ? "Add note" : "Send"}</button>
      </div>
      )}
    </div>
  );
}

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const CLIP = icon(<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />);
const CAMERA = icon(<><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.1l1.5-2h7.8l1.5 2h2.1A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><circle cx="12" cy="12.5" r="3.25" /></>);
const FILE = icon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>);
