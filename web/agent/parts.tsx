import { useEffect, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { Field as UiField, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { ChevronRightIcon, PlusIcon, SearchIcon, TrashIcon } from "../components/icons.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import type { AgentConfig, Issue } from "./useAgentConfig.ts";

// Building blocks of the Agent page's plain views: the index of cards, list-of-text fields, problems,
// the save bar, and where each file lives on the page.

/** "add_seats" → "Add seats". */
export const humanize = (name: string) =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

/** A typed name as a file name: lower-case with dashes (tasks) or underscores (actions, widgets). */
export function slug(raw: string, sep: "-" | "_"): string {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(/^[-_]+|[-_]+$/g, "");
  return sep === "_" ? name.replace(/^[^a-z]+/, "") : name;
}

export const SKILL = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
export const TOOL = /^tools\/([a-z][a-z0-9_]*)\.ya?ml$/;
export const WIDGET = /^widgets\/([a-z][a-z0-9_-]*)\.widget$/;
export const EVAL = /^evals\/([a-zA-Z0-9_-]+)\.ya?ml$/;

/** The page a file is edited on (as a form, or in Code). Files of no known kind are under Instructions. */
export function routeFor(path: string): string {
  const skill = SKILL.exec(path)?.[1];
  if (skill) return `/agent/tasks/${skill}`;
  const tool = TOOL.exec(path)?.[1];
  if (tool) return `/agent/actions/${tool}`;
  const widget = WIDGET.exec(path)?.[1];
  if (widget) return `/agent/widgets/${widget}`;
  if (EVAL.test(path)) return "/agent/tests";
  if (path === "website-actions.yaml") return "/agent/actions";
  return "/agent";
}

// Form or Code: one switch for every Agent page, remembered in this browser (a developer who likes
// Code sees it everywhere). It never changes the URL: a page is the same page in either view.
const VIEW_KEY = "jun.agent.view";
const viewListeners = new Set<() => void>();
let codeView = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === "code";
  } catch {
    return false;
  }
})();
/** `later`: called while something renders (the shell rewriting an old link), so pages are told after it. */
export function setCodeView(code: boolean, later = false): void {
  if (code === codeView) return;
  codeView = code;
  try {
    localStorage.setItem(VIEW_KEY, code ? "code" : "form");
  } catch {
    // Storage blocked: the switch still works for this visit.
  }
  const tell = () => viewListeners.forEach((listener) => listener());
  if (later) queueMicrotask(tell);
  else tell();
}
export function useCodeView(): boolean {
  return useSyncExternalStore((cb) => (viewListeners.add(cb), () => viewListeners.delete(cb)), () => codeView);
}

export const go = (path: string) => navigate(path, { replace: true });

/** "new" or "edited" against what's live. */
export function changeOf(cfg: AgentConfig, path: string): "new" | "edited" | null {
  const live = cfg.state?.files[path];
  if (live === undefined) return path in cfg.draft ? "new" : null;
  return cfg.draft[path] !== live ? "edited" : null;
}

export interface ListItem {
  id: string;
  label: string;
  sub?: string;
  path: string;
  /** AI-24: "Not set up", for an action that can't work yet. */
  badge?: string;
}

/**
 * A list of items as a page of cards (actions, procedures), like the Widgets gallery: search, New, and
 * a card per item with what it does and its state. Opening one goes to its page (Studio.tsx).
 */
export function ItemIndex({ cfg, items, base, onAdd, addLabel, canEdit, empty, noun }: {
  cfg: AgentConfig;
  items: ListItem[];
  /** The list's URL; an item is `${base}/${id}`. */
  base: string;
  onAdd: () => void;
  addLabel: string;
  canEdit: boolean;
  empty: { title: string; text: string };
  /** "actions", "tasks": in the search box. */
  noun: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => `${i.label} ${i.id} ${i.sub ?? ""}`.toLowerCase().includes(q)) : items;
  return (
    <div className="agent-gallery">
      <div className="agent-gallery-bar">
        <div className="agent-gallery-search">
          <SearchIcon />
          <Input type="search" placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="spacer" />
        {canEdit && (
          <Button onClick={onAdd}>
            <PlusIcon /> {addLabel}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="agent-gallery-empty">
          <h2>{empty.title}</h2>
          <p>{empty.text}</p>
          {canEdit && (
            <Button onClick={onAdd}>
              <PlusIcon /> {addLabel}
            </Button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <p className="muted small agent-gallery-none">Nothing matches "{query}".</p>
      ) : (
        <ul className="agent-index-grid">
          {shown.map((item) => {
            const change = changeOf(cfg, item.path);
            const problems = cfg.issuesFor(item.path).length;
            const href = `${base}/${item.id}`;
            return (
              <li key={item.id} className="agent-index-card">
                <a className="agent-index-link" href={href} onClick={(e) => { e.preventDefault(); go(href); }}>
                  {item.label}
                </a>
                <p className="agent-index-sub">{item.sub || <span className="muted">No description yet</span>}</p>
                {(problems > 0 || change || item.badge) && (
                  <div className="agent-index-badges">
                    {problems > 0 && <Badge variant="destructive">{problems === 1 ? "1 problem" : `${problems} problems`}</Badge>}
                    {item.badge && <Badge variant="outline">{item.badge}</Badge>}
                    {change && <Badge variant="secondary">{change}</Badge>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// The config checker speaks in file keys; the forms show the few a new item hits first in their words.
const PLAIN: [RegExp, string][] = [
  [/^description is required: say when/, "Say when the AI should do this task."],
  [/^description is required: tell the AI/, "Say what this action does, so the AI knows when to use it."],
  [/^url must start with https/, "The request address must start with https://."],
  [/: give the customer's message/, "Write what the customer says."],
  [/^\{(\w+)\} isn't an input\./, "The address uses {$1}, but there's no detail called $1. Add it under \"Details the AI asks for\", or fix the address."],
];
export const plain = (message: string) => {
  for (const [pattern, text] of PLAIN) {
    const match = pattern.exec(message);
    if (match) return text.replaceAll("$1", match[1] ?? "");
  }
  return message;
};

/** The config checker's messages; in the forms, `plain` words the common ones. */
export function Problems({ issues, raw }: { issues: Issue[]; raw?: boolean }) {
  return <FieldError errors={issues.map((i) => ({ message: raw ? i.message : plain(i.message) }))} />;
}

/** A file the form can't read (its YAML has a mistake): only Code can fix it. */
export function Unreadable() {
  return (
    <p className="agent-notice small">
      <span>This has a formatting mistake, so it can only be edited as code for now.</span>
      <span className="spacer" />
      <Button variant="outline" size="sm" onClick={() => setCodeView(true)}>Fix it in Code</Button>
    </p>
  );
}

/** Code, on a page with several files (Tests, Instructions' other files): which one shows. */
export function FilePicker({ files, value, onChange }: { files: string[]; value: string; onChange: (path: string) => void }) {
  return (
    <div className="agent-file-picker" role="group" aria-label="File">
      {files.map((f) => (
        <Button key={f} variant={f === value ? "secondary" : "ghost"} size="sm" className="mono" aria-pressed={f === value} onClick={() => onChange(f)}>
          {f}
        </Button>
      ))}
    </div>
  );
}

/** Code: one file as text, exactly as `jun pull` writes it, with the checker's messages under it. */
export function CodeEditor({ cfg, path, canEdit }: { cfg: AgentConfig; path: string; canEdit: boolean }) {
  // Tab inserts spaces (YAML and Markdown lists need them).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || !canEdit) return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = t;
    cfg.setFile(path, `${value.slice(0, start)}  ${value.slice(end)}`);
    requestAnimationFrame(() => t.setSelectionRange(start + 2, start + 2));
  };
  return (
    <>
      <div className="agent-code-path muted small">
        <code>{path}</code>
      </div>
      <Textarea
        className="agent-text"
        aria-label={path}
        spellCheck={path.endsWith(".md")}
        value={cfg.draft[path] ?? ""}
        onChange={(e) => cfg.setFile(path, e.target.value)}
        onKeyDown={onKeyDown}
        readOnly={!canEdit}
      />
      <Problems issues={cfg.issuesFor(path)} raw />
    </>
  );
}

/** A list of short texts. Empty rows stay on screen while you type but are never saved. */
export function TextList({ values, onChange, placeholder, addLabel, disabled, max, id, label }: {
  values: string[];
  /** Each row's accessible name (the field's label). */
  label?: string;
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
  disabled?: boolean;
  max?: number;
  id?: string;
}) {
  const [rows, setRows] = useState(values);
  // Changed elsewhere (Discard, the Code view, another version): show that.
  useEffect(() => {
    setRows((r) => (JSON.stringify(r.filter((v) => v.trim())) === JSON.stringify(values) ? r : values));
  }, [values]);
  const update = (next: string[]) => {
    setRows(next);
    onChange(next.map((v) => v.trim()).filter(Boolean));
  };
  return (
    <div className="agent-textlist" id={id}>
      {rows.map((value, i) => (
        <div key={i} className="agent-textlist-row">
          <Input value={value} aria-label={label ?? placeholder} placeholder={placeholder} disabled={disabled} autoFocus={value === "" && i === rows.length - 1} onChange={(e) => update(rows.map((v, j) => (j === i ? e.target.value : v)))} />
          {!disabled && (
            <Button variant="ghost" size="icon-sm" type="button" aria-label="Remove" onClick={() => update(rows.filter((_, j) => j !== i))}>
              <TrashIcon />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (max === undefined || rows.length < max) && (
        <Button variant="ghost" size="sm" type="button" className="agent-textlist-add" onClick={() => setRows([...rows, ""])}>
          <PlusIcon /> {addLabel}
        </Button>
      )}
    </div>
  );
}

/** A labelled field stacked over its control, with an optional hint under the label. */
/** shadcn's Field: a `<label>` when it names one control (`htmlFor`), a title over a group otherwise. */
export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <UiField className="agent-field">
      {htmlFor ? <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel> : <FieldTitle>{label}</FieldTitle>}
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {children}
    </UiField>
  );
}

/** Settings most people never need, folded away (shadcn's Collapsible). */
export function Advanced({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="agent-advanced">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="agent-advanced-trigger" />}>
        <ChevronRightIcon className="agent-advanced-chevron" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="agent-advanced-body">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Asks for a name, then creates the item. */
export function AddDialog({ open, onClose, title, description, placeholder, exists, onAdd }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  placeholder: string;
  /** The name is taken (or not usable): returns the reason. */
  exists: (name: string) => string | null;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  const problem = name.trim() ? exists(name) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="agent-dialog-form" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !problem) onAdd(name); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <UiField data-invalid={problem ? true : undefined}>
            <FieldLabel htmlFor="agent-new-name">Name</FieldLabel>
            <Input id="agent-new-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={60} aria-invalid={problem ? true : undefined} />
            {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>Nothing changes for customers until you save.</FieldDescription>}
          </UiField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || problem !== null}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pinned under every view while there are unsaved changes: one save for everything. */
export function SaveBar({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  if (!canEdit || !cfg.state) return null;
  const { dirty, issues, conflict, saved, busy, error } = cfg;
  if (!dirty && !conflict && saved === null && !error) return null;
  return (
    <div className="agent-savebar" role="region" aria-label="Unsaved changes">
      {conflict ? (
        <>
          <span className="error small">{conflict}</span>
          <span className="spacer" />
          <Button variant="outline" size="sm" onClick={() => cfg.load().catch(() => {})}>Load theirs (drops your edits)</Button>
          <Button variant="outline" size="sm" onClick={() => cfg.save(true)}>Keep mine</Button>
        </>
      ) : dirty ? (
        <>
          {issues.length > 0 ? (
            <span className="error small agent-savebar-text">
              {issues.length === 1 ? "1 problem" : `${issues.length} problems`} to fix before saving:{" "}
              {[...new Set(issues.map((i) => i.path))].slice(0, 3).map((p) => (
                <button key={p} type="button" className="link-button" onClick={() => go(routeFor(p))}>{labelFor(p)}</button>
              ))}
            </span>
          ) : (
            <span className="small agent-savebar-text">Unsaved changes. Customers see them once you save.</span>
          )}
          <Input className="agent-savebar-note" value={cfg.message} onChange={(e) => cfg.setMessage(e.target.value)} placeholder="What changed? (optional)" maxLength={500} />
          <Button variant="outline" size="sm" disabled={busy} onClick={cfg.discard}>Discard</Button>
          <Button size="sm" disabled={busy || issues.length > 0} onClick={() => cfg.save()}>Save and go live</Button>
        </>
      ) : saved !== null ? (
        <span className="small">Saved. Version {saved} is live ✓</span>
      ) : null}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/** A file as people know it on this page: "Instructions", "Cancellation"… */
export function labelFor(path: string): string {
  if (path === "AGENTS.md") return "Instructions";
  const skill = SKILL.exec(path)?.[1];
  if (skill) return humanize(skill);
  const tool = TOOL.exec(path)?.[1];
  if (tool) return humanize(tool);
  const widget = WIDGET.exec(path)?.[1];
  if (widget) return `${humanize(widget)} widget`;
  if (EVAL.test(path)) return "Tests";
  if (path === "website-actions.yaml") return "Website actions";
  return path || "Config";
}
