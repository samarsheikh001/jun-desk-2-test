import { useRef, type KeyboardEvent, type ReactNode } from "react";

// A code field with line numbers and colours, for widget templates (JSON with Jinja inside) and
// JSON data: a plain textarea with transparent text over a highlighted copy of the same text.
// Nothing to load; the textarea keeps undo, selection and IME.

type Token = { cls: string; text: string };

const TOKEN = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})|("(?:\\.|[^"\\\n])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],:])/g;

function tokens(source: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    if (m.index > last) out.push({ cls: "", text: source.slice(last, m.index) });
    if (m[1]) out.push({ cls: "tok-jinja", text: m[1] });
    else if (m[2]) {
      out.push({ cls: m[3] ? "tok-key" : "tok-str", text: m[2] });
      if (m[3]) out.push({ cls: "tok-punct", text: m[3] });
    } else if (m[4]) out.push({ cls: "tok-num", text: m[4] });
    else if (m[5]) out.push({ cls: "tok-lit", text: m[5] });
    else out.push({ cls: "tok-punct", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ cls: "", text: source.slice(last) });
  return out;
}

function highlight(source: string): ReactNode[] {
  return tokens(source).map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : t.text));
}

export function CodeArea({ value, onChange, readOnly, label, className }: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  label: string;
  className?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split("\n").length;
  // Tab inserts two spaces (indented JSON).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || readOnly || e.shiftKey) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = t;
    onChange(`${t.value.slice(0, start)}  ${t.value.slice(end)}`);
    requestAnimationFrame(() => t.setSelectionRange(start + 2, start + 2));
  };
  return (
    <div className={`code-area${className ? ` ${className}` : ""}`}>
      <div className="code-area-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="code-area-body">
        <pre ref={pre} aria-hidden="true">
          {highlight(value)}
          {"\n"}
        </pre>
        <textarea
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget;
            if (pre.current) {
              pre.current.scrollTop = scrollTop;
              pre.current.scrollLeft = scrollLeft;
            }
            if (gutter.current) gutter.current.scrollTop = scrollTop;
          }}
        />
      </div>
    </div>
  );
}
