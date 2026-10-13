import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { actionUrl, DISMISS, isClientAction, itemIds, OPEN_URL, TOOL_ACTION, widgetSummary, type MessageWidget, type WidgetActionConfig, type WidgetNode } from "../../../shared/widgets.ts";
import { WidgetChart } from "./chart.tsx";
import { hasIcon, iconSize, WidgetIcon } from "./icons.tsx";
import { background, block, box, color, imageSrc, insets, length, onTone, SEMANTIC, space, text, type Theme } from "./style.ts";
import "./chatkit.css";

// W-09 (D-43): draws a ChatKit widget tree (shared/widgets.ts) in the chat. Our own renderer for
// OpenAI's ChatKit widget format: components and props per ChatKit's spec (openai/chatkit-js
// widgets.d.ts, Apache-2.0), look after our chat's tokens, structure after @swis/genui-widgets
// (MIT, © swisnl). Used by the widget frame (Preact) and, read-only, by the inbox (React).
//
// The whole card is one <form>: any action sends what the visitor entered in the card's named
// fields (the server keeps only the card's own fields), and a submit or confirm checks required
// fields first. A used Card (`widget.used`) folds like ChatKit's `collapsed` card: one row with what
// was chosen, which opens to the card with its controls off.
//
// D-51, ChatKit's action options: `handler: "client"` goes to the host page (`onClientAction`), never
// to the server; `loadingBehavior` picks what shows busy while it's sent (auto: the pressed control,
// a card's confirm: the card); a field's `onChangeAction` (`tool:<name>` only) runs quietly through
// `onChange` and the card the tool returns replaces this one.
//
// W-27: a `dismiss` action (ours, like `open_url`) folds the card here and sends nothing; a card that
// isn't a Card (a list, a Basic root) goes away instead. Only for this view: a reload shows it again.

export interface WidgetActionEvent {
  action: WidgetActionConfig;
  label: string;
  values: Record<string, string | boolean>;
  /** W-17: the list item it was pressed in. */
  item?: string;
}

/** W-27: how a press went; `ok: false` with a message when the action's widget_failed line answered it. */
export interface WidgetActionOutcome {
  ok: boolean;
  message?: string;
}

/** D-51: an action with ChatKit's `handler: "client"`, for the host page. */
export interface WidgetClientEvent {
  action: { type: string; payload?: unknown };
  values: Record<string, string | boolean>;
  /** The widget file's name. */
  widget: string;
}

/** D-51: a field's `onChangeAction` (`tool:<name>`): what changed and what the card holds now. */
export interface WidgetChangeEvent {
  action: { type: string; payload?: unknown };
  field: string;
  values: Record<string, string | boolean>;
}

interface Ctx {
  theme: Theme;
  /** The card's own actions are off (read-only, used, or one is being sent). */
  disabled: boolean;
  /** Read-only (history, inbox, streaming): nothing can be sent, though links still open. */
  readOnly: boolean;
  /** Sends an action. `self`: the pressed control's key, for `loadingBehavior` "self" (and "auto" on a control). */
  fire: (action: unknown, label: string, check: boolean, item?: string, self?: string) => void;
  /** D-51: a field changed; runs its `onChangeAction` if it has one. */
  change: (node: WidgetNode, self: string) => void;
  /** Whether the control with this key shows busy (its action or change is being sent). */
  busy: (self: string) => boolean;
  /** The root's one-line summary and, once used, what was chosen (a used root Card folds to them). */
  summary: string;
  usedLabel: string | null;
  /** W-27: a `dismiss` button folded the card. */
  dismissed: boolean;
  /** W-17: list item ids, and which items are used or being sent. */
  items: Map<WidgetNode, string>;
  /** The element id of the card's field with this name (a Label's `fieldName` points at it). */
  fieldId: (name: unknown) => string | undefined;
  itemState: (id: string) => { used: { label: string } | null; busy: boolean };
}

const WidgetCtx = createContext<Ctx>({
  theme: "light",
  disabled: true,
  readOnly: true,
  fire: () => {},
  change: () => {},
  busy: () => false,
  summary: "",
  usedLabel: null,
  dismissed: false,
  items: new Map(),
  itemState: () => ({ used: null, busy: false }),
  fieldId: () => undefined,
});

/** A stable key for one control (busy state). */
function useKey(): string {
  return useRef(Math.random().toString(36).slice(2, 9)).current;
}

function Spinner() {
  return <span className="ck-spinner" aria-hidden="true" />;
}
/** W-17: the list item a control sits in (its own used state). */
/** A list row: its id, whether it's off, and (once used) the label of the button that used it. */
const ItemCtx = createContext<{ id?: string; disabled: boolean; used?: string }>({ disabled: false });

/** The row has a (non-link) button with this label: the press shows in its place. */
function hasButton(node: WidgetNode, label: string): boolean {
  if (node.type === "Button" && asAction(node.onClickAction)?.type !== OPEN_URL && (str(node.label) || asAction(node.onClickAction)?.type) === label) return true;
  return (node.children ?? []).some((c) => hasButton(c, label));
}

function asAction(value: unknown): WidgetActionConfig | null {
  return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? (value as WidgetActionConfig) : null;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v));

const TEXT_SIZES: Record<string, string> = { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "18px" };
const TITLE_SIZES: Record<string, string> = { sm: "15px", md: "17px", lg: "20px", xl: "24px", "2xl": "28px", "3xl": "34px", "4xl": "42px", "5xl": "52px" };
const CAPTION_SIZES: Record<string, string> = { sm: "11px", md: "12px", lg: "13px" };
const WEIGHTS: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };

function textNode(node: WidgetNode, theme: Theme, sizes: Record<string, string>, base: { size: string; weight: number; className: string }): ReactNode {
  const style: CSSProperties = { ...text(node, theme), fontSize: sizes[str(node.size)] ?? sizes[base.size] };
  const weight = WEIGHTS[str(node.weight)];
  if (weight) style.fontWeight = weight;
  return (
    <div className={`${base.className}${node.truncate === true ? " ck-truncate" : ""}`} style={style}>
      {str(node.value)}
    </div>
  );
}

/** A tiny Markdown subset for ChatKit's Markdown component: paragraphs, lists, **bold**, *italic*, `code`, links. */
function Markdown({ value }: { value: string }) {
  const inline = (line: string, key: number): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g).map((part, i) => {
      const k = `${key}-${i}`;
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^`[^`]+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      if (/^\*[^*]+\*$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
      const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(part);
      if (link) return <a key={k} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
      return <Fragment key={k}>{part}</Fragment>;
    });
  const blocks = value.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="ck-md">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]!);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), j)}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l, j)] : inline(l, j)))}</p>;
      })}
    </div>
  );
}

const CONTROL_SIZES = new Set(["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"]);

function Button({ node }: { node: WidgetNode }) {
  const { theme, disabled: cardOff, fire, busy } = useContext(WidgetCtx);
  const item = useContext(ItemCtx);
  const key = useKey();
  const loading = busy(key);
  const action = asAction(node.onClickAction);
  // A link opens even on a used or read-only card; in a list, a row is off once it's used.
  const link = action?.type === OPEN_URL;
  const disabled = link ? false : item.id ? item.disabled : cardOff;
  const label = str(node.label);
  const style = node.style === "primary" ? "primary" : node.style === "secondary" ? "secondary" : null;
  const tone = str(node.color) || (style === "primary" ? "primary" : "secondary");
  const variant = ["solid", "soft", "outline", "ghost"].includes(str(node.variant)) ? str(node.variant) : tone === "primary" || style === "primary" ? "solid" : "outline";
  const size = CONTROL_SIZES.has(str(node.size)) ? str(node.size) : "md";
  const c = SEMANTIC[tone] ?? color(tone, theme) ?? "var(--ck-text)";
  const submit = node.submit === true;
  const icons = buttonIconSize(node);
  // W-17: in a used row, the button that was pressed becomes its check ("✓ Email"), not a dimmed copy beside one.
  if (item.used && !link && (label || action?.type) === item.used) {
    return (
      <span className="ck-item-done">
        <WidgetIcon name="check" size={13} />
        <span>{item.used}</span>
      </span>
    );
  }
  return (
    <button
      type={submit ? "submit" : "button"}
      // An icon-only button still needs a name for screen readers.
      {...(!label ? { "aria-label": link ? "Open link" : String(node.iconStart ?? node.iconEnd ?? action?.type ?? "Button").replace(/[-_]/g, " ") } : {})}
      className={`ck-btn ck-btn-${variant} ck-size-${size}${node.pill === true ? " ck-pill" : ""}${node.block === true ? " ck-block" : ""}${!label ? " ck-btn-icon" : ""}${loading ? " ck-busy" : ""}`}
      {...(loading ? { "aria-busy": true } : {})}
      style={{ "--ck-tone": c, "--ck-on-tone": onTone(tone) } as CSSProperties}
      disabled={disabled || node.disabled === true || (!action && !submit)}
      // As in ChatKit, a button's own action runs on click, `submit` or not (a submit one checks the
      // card's required fields first, and its own action wins over the Form's). A submit button
      // without an action submits its Form, or an `asForm` Card (see Container and Card).
      {...(action && submit ? { "data-ck-own": "" } : {})}
      onClick={
        !action
          ? undefined
          : (e) => {
              if (submit) e.preventDefault();
              fire(action, label || action.type, submit, item.id, key);
            }
      }
    >
      {loading ? <Spinner /> : node.iconStart ? <WidgetIcon name={node.iconStart} size={icons} /> : null}
      {label && <span>{label}</span>}
      {node.iconEnd ? <WidgetIcon name={node.iconEnd} size={icons} /> : null}
    </button>
  );
}

function Badge({ node }: { node: WidgetNode }) {
  const { theme } = useContext(WidgetCtx);
  const name = str(node.color) || "secondary";
  const tone = SEMANTIC[name] ?? color(node.color, theme) ?? "var(--ck-text-2)";
  const variant = ["solid", "soft", "outline"].includes(str(node.variant)) ? str(node.variant) : "soft";
  const size = ["sm", "md", "lg"].includes(str(node.size)) ? str(node.size) : "sm";
  return <span className={`ck-badge ck-badge-${variant} ck-badge-${size}${node.pill === true ? " ck-pill" : ""}`} style={{ "--ck-tone": tone, "--ck-on-tone": onTone(SEMANTIC[name] ? name : "") } as CSSProperties}>{str(node.label)}</span>;
}

// ChatKit's button icons: `iconSize` if given, else from the button's size (its stylesheet:
// --control-icon-size xs 14, sm 16, md 18, lg 20, xl 22, 2xl 24; sizes 3xs → xs, 2xs/xs → sm, sm–xl → md, 2xl/3xl → lg).
const CONTROL_ICON: Record<string, number> = { xs: 14, sm: 16, md: 18, lg: 20, xl: 22, "2xl": 24 };
const BUTTON_ICON: Record<string, string> = { "3xs": "xs", "2xs": "sm", xs: "sm", sm: "md", md: "md", lg: "md", xl: "md", "2xl": "lg", "3xl": "lg" };
function buttonIconSize(node: WidgetNode): number {
  return CONTROL_ICON[str(node.iconSize)] ?? CONTROL_ICON[BUTTON_ICON[str(node.size)] ?? "md"]!;
}

function Image({ node }: { node: WidgetNode }) {
  const { theme, disabled: cardOff, fire, busy } = useContext(WidgetCtx);
  const item = useContext(ItemCtx);
  const key = useKey();
  // ChatKit's `src` is a URL or { light, dark }: the one for the card's theme, else the other.
  const themed = node.src && typeof node.src === "object" ? (node.src as { light?: unknown; dark?: unknown }) : null;
  const src = themed ? imageSrc(themed[theme]) ?? imageSrc(themed[theme === "dark" ? "light" : "dark"]) : imageSrc(node.src);
  const [broken, setBroken] = useState(false);
  const action = asAction(node.onClickAction);
  if (!src || broken) return null;
  const style: CSSProperties = { borderRadius: "8px", ...block(node) };
  const fit = str(node.fit);
  if (["cover", "contain", "fill", "scale-down", "none"].includes(fit)) style.objectFit = fit as CSSProperties["objectFit"];
  if (typeof node.position === "string" && /^(top|bottom|left|right|center)( (left|right))?$/.test(node.position)) style.objectPosition = node.position;
  // No size given: ChatKit draws a 40×40 square (an avatar or cover in a row), not the picture's own size.
  if (!style.width && !style.height && !node.flush) {
    if (style.aspectRatio) style.maxWidth = "100%";
    else {
      style.width = "40px";
      style.height = "40px";
    }
  }
  const link = action?.type === OPEN_URL;
  const off = link ? false : item.id ? item.disabled : cardOff;
  const clickable = action
    ? {
        role: "button",
        tabIndex: off ? -1 : 0,
        "aria-disabled": off,
        ...(busy(key) ? { "aria-busy": true } : {}),
        onClick: () => !off && fire(action, str(node.alt) || action.type, false, item.id, key),
        onKeyDown: (e: React.KeyboardEvent) => {
          if ((e.key === "Enter" || e.key === " ") && !off) {
            e.preventDefault();
            fire(action, str(node.alt) || action.type, false, item.id, key);
          }
        },
      }
    : {};
  return (
    <img
      {...clickable}
      className={`ck-img${node.frame === true ? " ck-frame" : ""}${node.flush === true ? " ck-flush" : ""}${action ? " ck-img-btn" : ""}${busy(key) ? " ck-busy" : ""}`}
      src={src}
      alt={str(node.alt)}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={style}
      onError={() => setBroken(true)}
    />
  );
}

function fieldClass(node: WidgetNode, base: string) {
  const variant = str(node.variant) === "soft" ? "soft" : "outline";
  return `${base} ck-field-${variant}${node.pill === true ? " ck-pill" : ""}${node.block === true ? " ck-block" : ""}`;
}

function Input({ node }: { node: WidgetNode }) {
  const { disabled, fieldId } = useContext(WidgetCtx);
  const type = ["number", "email", "text", "password", "tel", "url"].includes(str(node.inputType)) ? str(node.inputType) : "text";
  return (
    <input
      className={fieldClass(node, "ck-input")}
      name={str(node.name)}
      id={fieldId(node.name)}
      type={type}
      defaultValue={str(node.defaultValue)}
      placeholder={str(node.placeholder)}
      required={node.required === true}
      {...(typeof node.pattern === "string" ? { pattern: node.pattern } : {})}
      disabled={disabled || node.disabled === true}
      autoComplete="off"
    />
  );
}

function Textarea({ node }: { node: WidgetNode }) {
  const { disabled, fieldId } = useContext(WidgetCtx);
  return (
    <textarea
      className={fieldClass(node, "ck-input ck-textarea")}
      name={str(node.name)}
      id={fieldId(node.name)}
      defaultValue={str(node.defaultValue)}
      placeholder={str(node.placeholder)}
      required={node.required === true}
      rows={typeof node.rows === "number" ? Math.min(12, Math.max(1, node.rows)) : 3}
      disabled={disabled || node.disabled === true}
    />
  );
}

/** A field's change: runs its ChatKit `onChangeAction`, and shows busy while that's sent. */
function useChange(node: WidgetNode): { onChange?: () => void; busy: boolean } {
  const { change, busy } = useContext(WidgetCtx);
  const key = useKey();
  return node.onChangeAction ? { onChange: () => change(node, key), busy: busy(key) } : { busy: false };
}

function Select({ node }: { node: WidgetNode }) {
  const { disabled, fieldId } = useContext(WidgetCtx);
  const changed = useChange(node);
  const options = (Array.isArray(node.options) ? node.options : []) as { value?: unknown; label?: unknown; disabled?: unknown }[];
  // ChatKit's own props: `searchable` adds a search box to the menu, `clearable` a way back to no choice.
  if (node.searchable === true || node.clearable === true) return <MenuSelect node={node} options={options.map((o) => ({ value: str(o.value), label: str(o.label ?? o.value), disabled: o.disabled === true }))} />;
  return (
    <select
      className={fieldClass(node, `ck-input ck-select${changed.busy ? " ck-busy" : ""}`)}
      name={str(node.name)}
      id={fieldId(node.name)}
      defaultValue={str(node.defaultValue)}
      required={node.required === true}
      disabled={disabled || node.disabled === true}
      {...(changed.busy ? { "aria-busy": true } : {})}
      {...(changed.onChange ? { onChange: changed.onChange } : {})}
    >
      {(node.placeholder || !node.defaultValue) && <option value="" disabled={node.required === true}>{str(node.placeholder) || "Choose…"}</option>}
      {options.map((o, i) => <option key={i} value={str(o.value)} disabled={o.disabled === true}>{str(o.label ?? o.value)}</option>)}
    </select>
  );
}

/**
 * A Select with ChatKit's `searchable` or `clearable` (W-18), drawn the way ChatKit draws it: a
 * field showing the choice opens a menu; `searchable` puts a search box at the top of the menu
 * (type to filter by label, arrows and Enter to pick, Escape to close, "No results found."),
 * `clearable` adds a button that clears the choice. One difference: the menu opens inline under the
 * field (it pushes the card down rather than floating, so a scrolling chat never clips it). The
 * chosen value goes in a hidden input under the Select's name, so the card's fields are collected as
 * with the native one, and `required` is checked on the field.
 */
type MenuOption = { value: string; label: string; disabled: boolean };

function MenuSelect({ node, options }: { node: WidgetNode; options: MenuOption[] }) {
  const { disabled: cardOff, fieldId } = useContext(WidgetCtx);
  const changed = useChange(node);
  // The value input is controlled: its change fires after it's rendered with the new value.
  const first = useRef(true);
  const disabled = cardOff || node.disabled === true;
  const searchable = node.searchable === true;
  const [chosen, setChosen] = useState(() => options.find((o) => o.value === str(node.defaultValue)) ?? null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const check = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useMemo(() => `ck-sel-${Math.random().toString(36).slice(2, 8)}`, []);
  const typed = query.trim().toLowerCase();
  const shown = typed ? options.filter((o) => o.label.toLowerCase().includes(typed)) : options;
  useEffect(() => {
    check.current?.setCustomValidity(node.required === true && !chosen ? "Choose one of the options." : "");
  }, [chosen, node.required]);
  useEffect(() => {
    if (first.current) first.current = false;
    else changed.onChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);
  useEffect(() => {
    if (!open) return;
    (search.current ?? menu.current)?.focus({ preventScroll: true });
    menu.current?.querySelector(".ck-active")?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const show = () => {
    setQuery("");
    setActive(Math.max(0, chosen ? options.indexOf(chosen) : 0));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (o: MenuOption) => {
    if (o.disabled) return;
    setChosen(o);
    close(true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (shown.length ? (a + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };
  useEffect(() => {
    menu.current?.querySelector(".ck-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  // Closes when focus leaves the field and its menu (a native focusout: Preact's onBlur doesn't bubble).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const out = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setOpen(false);
    };
    el.addEventListener("focusout", out);
    return () => el.removeEventListener("focusout", out);
  }, []);
  return (
    <div ref={root} className={`ck-menu-select${node.block === true ? " ck-block" : ""}`}>
      <div className="ck-menu-trigger-row">
        <button
          ref={trigger}
          type="button"
          id={fieldId(node.name)}
          className={fieldClass(node, `ck-input ck-menu-trigger${changed.busy ? " ck-busy" : ""}`)}
          {...(changed.busy ? { "aria-busy": true } : {})}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          disabled={disabled}
          onClick={() => (open ? close(false) : show())}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              show();
            }
          }}
        >
          <span className={chosen ? "ck-menu-value" : "ck-menu-placeholder"}>{chosen?.label ?? (str(node.placeholder) || "Choose…")}</span>
          <svg className="ck-menu-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        {node.clearable === true && chosen && !disabled && (
          <button type="button" className="ck-menu-clear" aria-label="Clear" onClick={() => setChosen(null)}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
      </div>
      {/* Carries the value and takes `required`'s message (a read-only input would skip the check). */}
      <input ref={check} className="ck-menu-check" tabIndex={-1} aria-hidden="true" name={str(node.name)} value={chosen?.value ?? ""} onChange={() => {}} />
      {open && !disabled && (
        <div ref={menu} className="ck-menu" tabIndex={-1} onKeyDown={onKey}>
          {searchable && (
            <input
              ref={search}
              className="ck-menu-search"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              {...(shown[active] ? { "aria-activedescendant": `${id}-${active}` } : {})}
              aria-label="Search"
              placeholder="Search…"
              value={query}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          )}
          <ul className="ck-menu-list" id={`${id}-list`} role="listbox">
            {shown.length === 0 && <li className="ck-menu-empty">No results found.</li>}
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={chosen?.value === o.value}
                {...(o.disabled ? { "aria-disabled": true } : {})}
                className={`ck-menu-opt${i === active ? " ck-active" : ""}${o.disabled ? " ck-off" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseEnter={() => setActive(i)}
              >
                <span>{o.label}</span>
                {chosen?.value === o.value && <WidgetIcon name="check" size={14} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DatePicker({ node }: { node: WidgetNode }) {
  const { disabled, fieldId } = useContext(WidgetCtx);
  const changed = useChange(node);
  const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "");
  return (
    <input
      className={fieldClass(node, "ck-input")}
      type="date"
      name={str(node.name)}
      id={fieldId(node.name)}
      {...(changed.busy ? { "aria-busy": true } : {})}
      {...(changed.onChange ? { onChange: changed.onChange } : {})}
      defaultValue={day(node.defaultValue)}
      {...(node.min ? { min: day(node.min) } : {})}
      {...(node.max ? { max: day(node.max) } : {})}
      required={node.required === true}
      disabled={disabled || node.disabled === true}
    />
  );
}

function Checkbox({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const changed = useChange(node);
  return (
    <label className={`ck-check${changed.busy ? " ck-busy" : ""}`}>
      <input type="checkbox" {...(changed.onChange ? { onChange: changed.onChange } : {})} name={str(node.name)} defaultChecked={node.defaultChecked === true || node.defaultChecked === "true"} required={node.required === true} disabled={disabled || node.disabled === true} />
      {node.label ? <span>{str(node.label)}</span> : null}
    </label>
  );
}

function RadioGroup({ node }: { node: WidgetNode }) {
  const { disabled } = useContext(WidgetCtx);
  const changed = useChange(node);
  const options = (Array.isArray(node.options) ? node.options : []) as { value?: unknown; label?: unknown; disabled?: unknown }[];
  return (
    <div
      className={`ck-radios${node.direction === "row" ? " ck-row-dir" : ""}${changed.busy ? " ck-busy" : ""}`}
      role="radiogroup"
      aria-label={str(node.ariaLabel) || undefined}
      {...(changed.busy ? { "aria-busy": true } : {})}
      {...(changed.onChange ? { onChange: changed.onChange } : {})}
    >
      {options.map((o, i) => (
        <label key={i} className="ck-check">
          <input type="radio" name={str(node.name)} value={str(o.value)} defaultChecked={str(node.defaultValue) === str(o.value)} required={node.required === true} disabled={disabled || node.disabled === true || o.disabled === true} />
          <span>{str(o.label ?? o.value)}</span>
        </label>
      ))}
    </div>
  );
}

/** ChatKit's ListView `limit` when it's "auto" or not set. */
const LIST_LIMIT = 4;

function ListView({ node }: { node: WidgetNode }) {
  const items = node.children ?? [];
  const limit = typeof node.limit === "number" ? node.limit : LIST_LIMIT;
  const [all, setAll] = useState(false);
  const folds = limit > 0 && items.length > limit;
  const shown = folds && !all ? items.slice(0, limit) : items;
  return (
    <div className="ck-list">
      {shown.map((child, i) => <Node key={str(child.key) || i} node={child} />)}
      {folds && (
        <button type="button" className="ck-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show ${items.length - shown.length} more`}
        </button>
      )}
    </div>
  );
}

function ListViewItem({ node }: { node: WidgetNode }) {
  const { readOnly, disabled: cardOff, fire, items, itemState, busy } = useContext(WidgetCtx);
  const id = items.get(node);
  const key = useKey();
  const state = id ? itemState(id) : { used: null, busy: false };
  // W-17: each row is used on its own; the card being used (or read-only) turns them all off.
  const disabled = readOnly || cardOff || Boolean(state.used) || state.busy;
  const action = asAction(node.onClickAction);
  const style: CSSProperties = { gap: space(node.gap) ?? "12px" };
  if (typeof node.align === "string") style.alignItems = { start: "flex-start", end: "flex-end", center: "center", baseline: "baseline", stretch: "stretch" }[node.align] ?? "center";
  const children = (node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />);
  const done = state.used && !hasButton(node, state.used.label) ? (
    <span className="ck-item-done">
      <WidgetIcon name="check" size={13} />
      <span>{state.used.label}</span>
    </span>
  ) : null;
  const body = (
    <ItemCtx.Provider value={{ ...(id ? { id } : {}), disabled, ...(state.used ? { used: state.used.label } : {}) }}>
      {children}
      {done}
    </ItemCtx.Provider>
  );
  if (!action) return <div className={`ck-item${state.used ? " ck-item-used" : ""}`} style={style}>{body}</div>;
  const label = (node.children ?? []).map((c) => str(c.value)).filter(Boolean)[0] ?? action.type;
  const link = action.type === OPEN_URL;
  return (
    <div
      className={`ck-item ck-item-btn${state.used ? " ck-item-used" : ""}${busy(key) ? " ck-busy" : ""}`}
      {...(busy(key) ? { "aria-busy": true } : {})}
      style={style}
      role="button"
      tabIndex={disabled && !link ? -1 : 0}
      aria-disabled={disabled && !link}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, select, textarea, label")) return; // its own controls
        if (link || !disabled) fire(action, label, false, id, key);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (link || !disabled)) {
          e.preventDefault();
          fire(action, label, false, id, key);
        }
      }}
    >
      {body}
    </div>
  );
}

function Table({ node }: { node: WidgetNode }) {
  return (
    <div className="ck-table-wrap">
      <table className="ck-table">
        <tbody>
          {(node.children ?? []).map((row, i) => (
            <tr key={str(row.key) || i} className={row.header === true ? "ck-th" : undefined}>
              {(row.children ?? []).map((cell, j) => {
                const style: CSSProperties = { ...insets("padding", cell.padding) };
                const w = length(cell.width);
                if (w) style.width = w;
                if (cell.align === "center" || cell.align === "end") style.textAlign = cell.align;
                if (cell.vAlign === "start" || cell.vAlign === "center" || cell.vAlign === "end") style.verticalAlign = cell.vAlign === "start" ? "top" : cell.vAlign === "end" ? "bottom" : "middle";
                const span = { ...(typeof cell.colSpan === "number" ? { colSpan: cell.colSpan } : {}), ...(typeof cell.rowSpan === "number" ? { rowSpan: cell.rowSpan } : {}) };
                const Cell = row.header === true ? "th" : "td";
                return (
                  <Cell key={str(cell.key) || j} style={style} {...span}>
                    {(cell.children ?? []).map((c, k) => <Node key={str(c.key) || k} node={c} />)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Container({ node, dir, className = "" }: { node: WidgetNode; dir: "row" | "col"; className?: string }) {
  const { theme, disabled: cardOff, fire, busy } = useContext(WidgetCtx);
  const item = useContext(ItemCtx);
  const key = useKey();
  const disabled = item.id ? item.disabled : cardOff;
  const style = box(node, theme);
  const click = asAction(node.onClickAction);
  const children = (node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />);
  const cls = `ck-box ck-${dir}${className}${node.flush === true ? " ck-flush" : ""}`;
  if (node.type === "Form") {
    // A Form inside the card's form: its submit button sends the Form's action (validated first).
    // Enter in one of its fields clicks the card's first submit button, which lands here too.
    const submit = asAction(node.onSubmitAction);
    return (
      <div
        className={cls}
        style={style}
        data-ck-form=""
        onClickCapture={(e) => {
          const target = e.target as HTMLElement;
          const btn = target.closest("button[type=submit]") as HTMLButtonElement | null;
          if (!btn || !submit || btn.hasAttribute("data-ck-own")) return;
          e.preventDefault();
          fire(submit, btn.textContent?.trim() || "Submit", true, item.id);
        }}
      >
        {children}
      </div>
    );
  }
  if (click) {
    return (
      <div
        className={`${cls} ck-clickable${busy(key) ? " ck-busy" : ""}`}
        style={style}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        {...(busy(key) ? { "aria-busy": true } : {})}
        onClick={() => !disabled && fire(click, click.type, false, item.id, key)}
      >
        {children}
      </div>
    );
  }
  return <div className={cls} style={style}>{children}</div>;
}

function Node({ node }: { node: WidgetNode }): ReactNode {
  const { theme, fieldId } = useContext(WidgetCtx);
  switch (node.type) {
    case "Box":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Row":
      return <Container node={node} dir="row" />;
    case "Col":
    case "Form":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Basic":
      return <Container node={node} dir={node.direction === "row" ? "row" : "col"} />;
    case "Card":
      return <Card node={node} nested />;
    case "ListView":
      return <ListView node={node} />;
    case "ListViewItem":
      return <ListViewItem node={node} />;
    case "Spacer": {
      const min = length(node.minSize);
      return <div className="ck-spacer" style={min ? { minWidth: min, minHeight: min } : undefined} />;
    }
    case "Divider": {
      const c = color(node.color, theme, "border");
      const size = length(node.size);
      const spacing = space(node.spacing);
      return <hr className={`ck-divider${node.flush === true ? " ck-flush" : ""}`} style={{ ...(c ? { borderColor: c } : {}), ...(size ? { borderTopWidth: size } : {}), ...(spacing ? { marginBlock: spacing } : {}) }} />;
    }
    case "Transition":
      return <>{(node.children ?? []).map((c, i) => <Node key={i} node={c} />)}</>;
    case "Table":
      return <Table node={node} />;
    case "Text":
    case "Title": {
      // Both take ChatKit's `editable` ({ name, … }): the text becomes a field under that name.
      const editable = node.editable && typeof node.editable === "object" ? (node.editable as Record<string, unknown>) : null;
      const title = node.type === "Title";
      if (editable && typeof editable.name === "string") {
        return <EditableText node={node} editable={editable} sizes={title ? TITLE_SIZES : TEXT_SIZES} weight={title ? 600 : 400} />;
      }
      return title ? textNode(node, theme, TITLE_SIZES, { size: "md", weight: 600, className: "ck-title" }) : textNode(node, theme, TEXT_SIZES, { size: "md", weight: 400, className: "ck-text" });
    }
    case "Caption":
      return textNode(node, theme, CAPTION_SIZES, { size: "md", weight: 400, className: "ck-caption" });
    case "Label": {
      const style: CSSProperties = { ...text(node, theme), fontSize: TEXT_SIZES[str(node.size)] ?? "13px" };
      const weight = WEIGHTS[str(node.weight)];
      if (weight) style.fontWeight = weight;
      return <label className="ck-label" style={style} htmlFor={fieldId(node.fieldName)}>{str(node.value)}</label>;
    }
    case "Markdown":
      return <Markdown value={str(node.value)} />;
    case "Badge":
      return <Badge node={node} />;
    case "Icon":
      return <WidgetIcon name={node.name} size={iconSize(node.size, 16)} color={color(node.color, theme)} />;
    case "Image":
      return <Image node={node} />;
    case "Chart":
      return <WidgetChart node={node} theme={theme} />;
    case "Button":
      return <Button node={node} />;
    case "Input":
      return <Input node={node} />;
    case "Textarea":
      return <Textarea node={node} />;
    case "Select":
      return <Select node={node} />;
    case "DatePicker":
      return <DatePicker node={node} />;
    case "Checkbox":
      return <Checkbox node={node} />;
    case "RadioGroup":
      return <RadioGroup node={node} />;
    default:
      return null;
  }
}

function EditableText({ node, editable, sizes, weight: base }: { node: WidgetNode; editable: Record<string, unknown>; sizes: Record<string, string>; weight: number }) {
  const { theme, disabled, fieldId } = useContext(WidgetCtx);
  const style: CSSProperties = { ...text(node, theme), fontSize: sizes[str(node.size)] ?? sizes.md, fontWeight: base };
  const weight = WEIGHTS[str(node.weight)];
  if (weight) style.fontWeight = weight;
  const multi = typeof node.minLines === "number" && node.minLines > 1;
  const props = {
    className: "ck-input ck-editable",
    name: str(editable.name),
    id: fieldId(editable.name),
    defaultValue: str(node.value),
    placeholder: str(editable.placeholder),
    required: editable.required === true,
    disabled,
    style,
  };
  return multi ? <textarea rows={node.minLines as number} {...props} /> : <input type="text" {...(typeof editable.pattern === "string" ? { pattern: editable.pattern } : {})} {...props} />;
}

function Status({ status }: { status: unknown }) {
  if (!status || typeof status !== "object") return null;
  const s = status as { text?: unknown; icon?: unknown; favicon?: unknown };
  const favicon = imageSrc(s.favicon);
  return (
    <div className="ck-status">
      {favicon ? <img src={favicon} alt="" width={14} height={14} referrerPolicy="no-referrer" /> : s.icon ? <WidgetIcon name={s.icon} size={14} /> : null}
      <span>{str(s.text)}</span>
    </div>
  );
}

/**
 * In a bare WidgetCard, the root Card draws flat (`bare`: no frame, no side padding) unless it has
 * its own background or a theme of its own: then it's a tile (`tile`: background and radius only).
 */
function Card({ node, nested = false, look = "frame" }: { node: WidgetNode; nested?: boolean; look?: "frame" | "bare" | "tile" }) {
  const { theme, fire, disabled, busy, summary, usedLabel, dismissed } = useContext(WidgetCtx);
  const confirmKey = useKey();
  const cancelKey = useKey();
  // ChatKit's `collapsed`: the body folds to one row that opens it. A used root card folds the same way.
  const usedHere = nested ? null : usedLabel;
  const folds = node.collapsed === true || Boolean(usedHere) || (!nested && dismissed);
  const [open, setOpen] = useState(!folds);
  // Folding closes it; unfolding (W-27: a press whose action failed opens the card again) opens it.
  useEffect(() => {
    setOpen(!folds);
  }, [folds]);
  const line = (nested ? widgetSummary(node) : summary) || "Details";
  const flat = look === "bare";
  const style: CSSProperties = flat
    ? box({ ...node, padding: undefined, size: undefined, width: undefined, height: undefined, border: undefined, background: undefined, radius: undefined, margin: undefined }, theme)
    : { ...insets("padding", node.padding ?? 4), ...box({ ...node, padding: undefined, size: undefined, width: undefined, height: undefined }, theme) };
  const pad = flat ? "0px" : (space(typeof node.padding === "number" ? node.padding : 4) ?? "16px");
  const confirm = node.confirm && typeof node.confirm === "object" ? (node.confirm as { label?: unknown; action?: unknown }) : null;
  const cancel = node.cancel && typeof node.cancel === "object" ? (node.cancel as { label?: unknown; action?: unknown }) : null;
  const dark = node.theme === "dark" ? " ck-dark" : node.theme === "light" ? " ck-light" : "";
  const bg = flat ? undefined : background(node.background, theme);
  // `asForm` (ChatKit): a submit button that isn't in a Form and has no action of its own sends the
  // card's confirm action, required fields checked first.
  const asForm = node.asForm === true && confirm && asAction(confirm.action) ? confirm : null;
  return (
    <>
      {!nested && <Status status={node.status} />}
      <div
        className={`ck-card ck-card-${["sm", "md", "lg", "full"].includes(str(node.size)) ? str(node.size) : "md"}${look === "frame" ? "" : ` ck-card-${look}`}${dark}`}
        style={{ ...style, ...(bg ? { background: bg } : {}), "--ck-pad": pad } as CSSProperties}
        onClickCapture={
          asForm
            ? (e) => {
                const btn = (e.target as HTMLElement).closest("button[type=submit]");
                if (!btn || btn.hasAttribute("data-ck-own") || btn.closest("[data-ck-form]")) return;
                e.preventDefault();
                fire(asForm.action, str(asForm.label) || "Confirm", true, undefined, card(asForm.action, confirmKey));
              }
            : undefined
        }
      >
        {folds && (
          <button type="button" className="ck-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="ck-fold-icon" aria-hidden="true">{peekIcon(node)}</span>
            <span className="ck-fold-text">{line}</span>
            {usedHere && (
              <span className="ck-fold-used">
                <WidgetIcon name="check" size={13} />
                <span>{usedHere}</span>
              </span>
            )}
            <svg className={`ck-fold-chev${open ? " ck-open" : ""}`} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        )}
        {/* Folded, the body stays mounted (hidden): what was typed survives a fold that opens again (W-27). */}
        <div className="ck-card-body" hidden={!open}>
        {(node.children ?? []).map((c, i) => <Node key={str(c.key) || i} node={c} />)}
        {(confirm || cancel) && (
          <div className="ck-card-actions">
            {confirm && asAction(confirm.action) && (
              <button
                type="button"
                className={`ck-btn ck-btn-solid ck-size-md${busy(confirmKey) ? " ck-busy" : ""}`}
                style={{ "--ck-tone": "var(--ck-accent)", "--ck-on-tone": "var(--ck-accent-text)" } as CSSProperties}
                disabled={disabled}
                // "auto" on a card's confirm is the whole card (ChatKit); "self" is this button.
                onClick={() => fire(confirm.action, str(confirm.label) || "Confirm", true, undefined, card(confirm.action, confirmKey))}
              >
                {busy(confirmKey) && <Spinner />}
                {str(confirm.label) || "Confirm"}
              </button>
            )}
            {cancel && asAction(cancel.action) && (
              <button
                type="button"
                className={`ck-btn ck-btn-outline ck-size-md${busy(cancelKey) ? " ck-busy" : ""}`}
                style={{ "--ck-tone": "var(--ck-text)" } as CSSProperties}
                disabled={disabled}
                onClick={() => fire(cancel.action, str(cancel.label) || "Cancel", false, undefined, card(cancel.action, cancelKey))}
              >
                {busy(cancelKey) && <Spinner />}
                {str(cancel.label) || "Cancel"}
              </button>
            )}
          </div>
        )}
        </div>
      </div>
    </>
  );
}

/** A card-level action (confirm, cancel): "self" (or "none") stays on the button; otherwise the whole card. */
function card(action: unknown, key: string): string | undefined {
  const lb = asAction(action)?.loadingBehavior;
  return lb === "self" || lb === "none" ? key : undefined;
}

/** What the visitor entered in the card's named fields. */
function collect(form: HTMLFormElement): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const el of Array.from(form.elements) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]) {
    if (!el.name) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") values[el.name] = el.checked;
    else if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) values[el.name] = el.value;
    } else values[el.name] = el.value;
  }
  return values;
}

/**
 * One widget the AI showed. `onAction` is called when the visitor presses one of its actions
 * (never while `interactive` is false: history the AI isn't waiting on, the inbox, a streaming reply).
 */
export function WidgetCard({
  widget,
  interactive,
  onAction,
  onClientAction,
  onChange,
  theme = "light",
  desk = false,
  bare = false,
}: {
  widget: MessageWidget;
  interactive: boolean;
  /** May resolve with why it didn't go through (W-27: the action's widget_failed line); the card shows it. */
  onAction?: (event: WidgetActionEvent) => void | Promise<WidgetActionOutcome>;
  /** D-51: an action with `handler: "client"` (for the host page; never sent to the server). */
  onClientAction?: (event: WidgetClientEvent) => void;
  /** D-51: a field's `tool:<name>` `onChangeAction`; resolves when done (the new card arrives separately). */
  onChange?: (event: WidgetChangeEvent) => Promise<{ ok: boolean; message?: string }>;
  theme?: Theme;
  /** In the dashboard: its colour tokens instead of the widget frame's. */
  desk?: boolean;
  /**
   * The card is the answer itself, inside a host with its own surface and ~16–20px side padding
   * (the island): no outer frame, content at the host's text edge. A root Card with its own
   * background or theme stays a tile. See chatkit.css "Bare".
   */
  bare?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  // What's busy while an action is sent (`loadingBehavior`): "card", a control's key, or "quiet"
  // (nothing shows). One action at a time. A failed send (used elsewhere, socket dropped) can be retried.
  const [sending, setSending] = useState<string | null>(null);
  useEffect(() => {
    if (!sending) return;
    const t = setTimeout(() => setSending(null), 8000);
    return () => clearTimeout(t);
  }, [sending]);
  // The server's answer (the card or row marked used) ends the wait.
  useEffect(() => setSending(null), [widget.used, widget.items]);
  // D-51: field changes running (by the same keys), the latest waiting behind a running one, and why one failed.
  const [changing, setChanging] = useState<string | null>(null);
  const queued = useRef<(() => void) | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [changeError, setChangeError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const used = widget.used ?? null;
  const readOnly = !interactive || !onAction;
  const disabled = readOnly || Boolean(used) || sending === "card" || changing === "card";
  const ids = useMemo(() => itemIds(widget.root), [widget.root]);
  const uid = useMemo(() => `ck${Math.random().toString(36).slice(2, 8)}`, []);
  const summary = useMemo(() => widget.summary || widgetSummary(widget.root) || widget.name, [widget.summary, widget.root, widget.name]);
  // A card a field change replaced: draw it fresh (its fields start from the new card's values).
  const rootJson = useMemo(() => JSON.stringify(widget.root), [widget.root]);
  const version = useRef({ json: rootJson, n: 0 });
  if (version.current.json !== rootJson) version.current = { json: rootJson, n: version.current.n + 1 };
  const client = (a: WidgetActionConfig) => {
    if (readOnly || !form.current) return;
    onClientAction?.({ action: { type: a.type, ...(a.payload !== undefined ? { payload: a.payload } : {}) }, values: collect(form.current), widget: widget.name });
  };
  const runChange = (node: WidgetNode, key: string, a: WidgetActionConfig) => {
    if (!form.current || !onChange) return;
    if (changing) {
      // One at a time per card: the latest change waits and goes next.
      queued.current = () => runChange(node, key, a);
      return;
    }
    const lb = a.loadingBehavior ?? "auto";
    const scope = lb === "none" ? "quiet" : lb === "container" ? "card" : key;
    setChanging(scope);
    setChangeError(null);
    void onChange({ action: { type: a.type, ...(a.payload !== undefined ? { payload: a.payload } : {}) }, field: str(node.name), values: collect(form.current) }).then((r) => {
      setChanging(null);
      if (!r.ok) setChangeError(r.message ?? "That didn't update.");
      const next = queued.current;
      queued.current = null;
      // The server wants a short gap between runs of one card.
      if (next) setTimeout(next, 450);
    });
  };
  const ctx: Ctx = {
    theme,
    fieldId: (name) => (typeof name === "string" && name ? `${uid}-${name.replace(/[^\w-]/g, "_")}` : undefined),
    disabled,
    readOnly,
    summary,
    usedLabel: used?.label ?? null,
    dismissed,
    items: ids,
    itemState: (id) => ({ used: widget.items?.[id] ?? null, busy: false }),
    busy: (key) => sending === key || changing === key,
    fire: (action, label, check, item, self) => {
      const a = asAction(action);
      if (!a || !form.current) return;
      // W-27: dismiss folds the card here; nothing is sent and nothing is used.
      if (a.type === DISMISS) {
        setDismissed(true);
        return;
      }
      // W-17: a link opens here; nothing is sent and nothing is used.
      if (a.type === OPEN_URL) {
        const url = actionUrl(a);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // ChatKit's handler "client": the host page's, not the server's; the card isn't used.
      if (isClientAction(a)) {
        if (check && !form.current.reportValidity()) return;
        return client(a);
      }
      if (readOnly || used || sending || (item && widget.items?.[item])) return;
      if (check && !form.current.reportValidity()) return;
      // ChatKit's loadingBehavior; "auto" is the pressed control, or the card for the card's own actions.
      const lb = a.loadingBehavior ?? "auto";
      setSending(lb === "none" ? "quiet" : lb === "container" || !self ? "card" : self);
      setChangeError(null);
      const sent = onAction?.({ action: { type: a.type, ...(a.payload !== undefined ? { payload: a.payload } : {}) }, label, values: collect(form.current), ...(item ? { item } : {}) });
      void sent?.then((r) => {
        if (r.ok) return;
        setSending(null);
        if (r.message) setChangeError(r.message);
      });
    },
    change: (node, key) => {
      const a = asAction(node.onChangeAction);
      if (!a || readOnly || used) return;
      if (isClientAction(a)) return client(a);
      // Only a tool runs on a change (quietly); other types have no one to handle them here.
      if (!TOOL_ACTION.test(a.type)) return;
      // Quick changes (arrow keys through a select) settle first.
      clearTimeout(timers.current.get(key));
      timers.current.set(key, setTimeout(() => runChange(node, key, a), 250));
    },
  };
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const root = widget.root;
  const tile = Boolean(background(root.background, theme)) || ((root.theme === "dark" || root.theme === "light") && root.theme !== theme);
  if (dismissed && root.type !== "Card") return null;
  return (
    <WidgetCtx.Provider value={ctx}>
      <form ref={form} className={`ck${desk ? " ck-desk" : ""}${theme === "dark" ? " ck-dark" : ""}${bare ? " ck-bare" : ""}${used ? " ck-used" : ""}`} onSubmit={(e) => e.preventDefault()} noValidate={false} aria-label={widget.name}>
        {root.type === "Card" ? <Card key={version.current.n} node={root} look={!bare ? "frame" : tile ? "tile" : "bare"} /> : root.type === "ListView" ? (
          <Fragment key={version.current.n}>
            <Status status={root.status} />
            <div className={`ck-card ck-card-list${bare ? " ck-card-bare" : ""}`}><ListView node={root} /></div>
          </Fragment>
        ) : (
          <Container key={version.current.n} node={root} dir={root.direction === "row" ? "row" : "col"} className=" ck-basic" />
        )}
        {changeError && (
          <div className="ck-change-error" role="status">
            {changeError}
          </div>
        )}
        {used && root.type !== "Card" && (
          <div className="ck-used-note">
            <WidgetIcon name="check" size={13} />
            <span>{used.label}</span>
          </div>
        )}
      </form>
    </WidgetCtx.Provider>
  );
}

/** The icon a card stands for: its status favicon or icon, else a generic card. */
function peekIcon(root: WidgetNode): ReactNode {
  const s = root.status && typeof root.status === "object" ? (root.status as { icon?: unknown; favicon?: unknown }) : {};
  const favicon = imageSrc(s.favicon);
  if (favicon) return <img src={favicon} alt="" width={16} height={16} referrerPolicy="no-referrer" />;
  return <WidgetIcon name={hasIcon(s.icon) ? s.icon : root.type === "ListView" ? "batch" : "square-text"} size={16} />;
}

/**
 * A folded card: one slim row (~40px) with the card's icon, its one-line summary and a chevron.
 * Pressing it calls `onOpen` (the host unfolds the card).
 */
export function WidgetPeek({ widget, theme, onOpen }: { widget: MessageWidget; theme?: "light" | "dark"; onOpen: () => void }) {
  // D-76: the widget file's own one-line summary first (D-47), else a guess from the card.
  const summary = useMemo(() => widget.summary?.trim() || widgetSummary(widget.root), [widget.summary, widget.root]) || widget.name;
  return (
    <button type="button" className={`ck-peek${theme === "dark" ? " ck-dark" : ""}${widget.used ? " ck-peek-used" : ""}`} aria-label={`Show ${summary}`} onClick={onOpen}>
      <span className="ck-peek-icon" aria-hidden="true">{widget.used ? <WidgetIcon name="check" size={14} /> : peekIcon(widget.root)}</span>
      <span className="ck-peek-text">{summary}</span>
      <span className="ck-peek-chev" aria-hidden="true"><WidgetIcon name="chevron-right" size={14} /></span>
    </button>
  );
}
