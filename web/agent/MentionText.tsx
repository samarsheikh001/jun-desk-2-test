import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { readYaml } from "../lib/agentFiles.ts";
import { TOOL, humanize } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// W-26: a text field where "@" names an action. Typing @ opens a list of the desk's actions (arrows,
// Enter or Tab, Escape; or the mouse) and writes "@lookup_order" into the text, which stays plain
// (the support AI reads @name as the tool called name). Every @mention is highlighted: an action, or
// a warning colour when there's no such action. The highlight is a copy of the text drawn behind a
// textarea with transparent text, so typing, undo, selection and IME stay the browser's own.

export interface MentionAction {
  name: string;
  description: string;
}

/** The draft's actions, with their descriptions, for the @ list. */
export function useMentionActions(cfg: AgentConfig): MentionAction[] {
  return useMemo(
    () =>
      Object.keys(cfg.draft)
        .map((path) => TOOL.exec(path)?.[1])
        .filter((n): n is string => Boolean(n))
        .sort()
        .map((name) => {
          const data = readYaml(cfg.draft[`tools/${name}.yaml`] ?? cfg.draft[`tools/${name}.yml`] ?? "") as { description?: unknown } | null;
          return { name, description: typeof data?.description === "string" ? data.description : "" };
        })
        // W-29: the AI's own tool for cards it fills in itself, when a card allows it.
        .concat(Object.entries(cfg.draft).some(([p, t]) => p.startsWith("widgets/") && /"aiFill"\s*:\s*true/.test(t)) ? [{ name: "show_widget", description: "Show a widget the AI fills in itself (widgets with that switch on)." }] : []),
    [cfg.draft],
  );
}

// The same rule as shared/agent-links.ts: not an email's "help@acme.com".
const MENTION = /(?<![\w.@])@([a-z][a-z0-9_]*)/g;
const TYPING = /(?<![\w.@])@([a-z0-9_]*)$/;

function highlight(text: string, known: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={m.index} className={known.has(m[1]!) ? "mention" : "mention mention-missing"}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function MentionText({ value, onChange, actions, readOnly, placeholder, id, ariaLabel, className, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  actions: MentionAction[];
  readOnly?: boolean;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  /** "mention-boxed" (a field with a border) or "mention-plain" (a page to write on), plus sizing. */
  className?: string;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const known = useMemo(() => new Set(actions.map((a) => a.name)), [actions]);

  // What's being typed after an @ right before the caret, and the actions it could be.
  const typing = caret === null || readOnly ? null : TYPING.exec(value.slice(0, caret));
  const query = typing ? typing[1]! : null;
  const options = query === null ? [] : actions.filter((a) => a.name.includes(query) || humanize(a.name).toLowerCase().includes(query)).slice(0, 8);
  const open = options.length > 0;
  const pick = active < options.length ? active : 0;

  // Place the list under the caret: a marker sits at the caret in the highlighted copy.
  useLayoutEffect(() => {
    if (!open || !marker.current || !back.current) return setPos(null);
    const field = back.current.parentElement!.getBoundingClientRect();
    const m = marker.current.getBoundingClientRect();
    setPos({ top: m.bottom - field.top + 4, left: Math.min(m.left - field.left, field.width - 280) });
  }, [open, caret, value]);

  const insert = (name: string) => {
    const el = input.current;
    if (!el || caret === null || query === null) return;
    const start = caret - query.length - 1;
    const after = value.slice(caret);
    const next = `${value.slice(0, start)}@${name}${/^\s/.test(after) ? "" : " "}${after}`;
    const at = start + name.length + 2;
    onChange(next);
    setCaret(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((pick + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(options[pick]!.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCaret(null);
    }
  };
  const track = () => setCaret(input.current?.selectionStart === input.current?.selectionEnd ? (input.current?.selectionStart ?? null) : null);

  const before = caret !== null && open ? value.slice(0, caret) : value;
  const rest = caret !== null && open ? value.slice(caret) : "";
  return (
    <div className={`mention-field${className ? ` ${className}` : ""}`}>
      <div className="mention-back" ref={back} aria-hidden="true">
        {highlight(before, known)}
        {open && <span ref={marker} />}
        {rest && highlight(rest, known)}
        {"\n"}
      </div>
      <textarea
        ref={input}
        id={id}
        aria-label={ariaLabel}
        className="mention-input"
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        autoFocus={autoFocus}
        spellCheck
        role={open ? "combobox" : undefined}
        aria-expanded={open || undefined}
        aria-controls={open ? `${id ?? "mention"}-list` : undefined}
        aria-activedescendant={open ? `${id ?? "mention"}-opt-${pick}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setCaret(e.target.selectionStart === e.target.selectionEnd ? e.target.selectionStart : null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && track()}
        onClick={track}
        onBlur={() => setCaret(null)}
        onScroll={(e) => {
          if (back.current) back.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
      {open && pos && (
        <ul className="mention-menu" id={`${id ?? "mention"}-list`} role="listbox" aria-label="Actions" style={{ top: pos.top, left: Math.max(0, pos.left) }}>
          {options.map((a, i) => (
            <li
              key={a.name}
              id={`${id ?? "mention"}-opt-${i}`}
              role="option"
              aria-selected={i === pick}
              className="mention-option"
              // mousedown, so the textarea keeps its caret (no blur first).
              onMouseDown={(e) => {
                e.preventDefault();
                insert(a.name);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="mention-option-name">@{a.name}</span>
              {a.description && <span className="mention-option-desc">{a.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
