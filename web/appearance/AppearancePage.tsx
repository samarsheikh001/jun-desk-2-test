import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { APPEARANCE_DEFAULTS, BUTTON_TEXT, RADIUS_MAX, SUGGESTION_LIMIT, SUGGESTIONS_MAX, TEXT_LIMITS, logoFor, textOn, widgetLook, type ButtonStyle, type IslandSurface, type LauncherStyle, type WidgetTheme } from "../../shared/appearance.ts";
import { api, ApiError } from "../api.ts";
import { useAction } from "../useAction.ts";
import { PageTabs } from "../components/PageTabs.tsx";
import { IdentityPanel, InstallPanel } from "./InstallPanels.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { previewChime } from "../lib/sound.ts";

// The Widget page: Look (/appearance) and Install (/appearance/install). /widget itself is the chat
// iframe the Worker serves, so the page keeps its old address.
export function WidgetPage({ workspaceId, workspaceName, canEdit, tab }: { workspaceId: string; workspaceName: string; canEdit: boolean; tab: "look" | "install" }) {
  return (
    <PageTabs
      title="Chat widget"
      value={tab}
      className="widget-page"
      tabs={[
        { value: "look", label: "Look", path: "/appearance", content: <LookTab workspaceId={workspaceId} workspaceName={workspaceName} canEdit={canEdit} /> },
        {
          value: "install",
          label: "Install",
          path: "/appearance/install",
          content: (
            <div className="page-settings settings-sections">
              <InstallPanel workspaceId={workspaceId} canEdit={canEdit} />
              {canEdit && <IdentityPanel workspaceId={workspaceId} />}
            </div>
          ),
        },
      ]}
    />
  );
}

// W-04 Look: settings on the left, and on the right the real widget (/widget in an
// iframe, preview mode) showing the unsaved draft, so the preview can't drift from what
// visitors get. Only the launcher button and greeting card around it are drawn here: they
// live in the loader on customers' pages (public/widget.js), and this copies its styles.

/** The appearance fields of the widget inbox's settings (what this page edits). */
interface Draft {
  displayName?: string;
  greeting?: string;
  replyTime?: string;
  placeholder?: string;
  suggestions?: string[];
  color?: string;
  position?: "left" | "right";
  theme?: WidgetTheme;
  radius?: number;
  launcher?: LauncherStyle;
  buttonStyle?: ButtonStyle;
  neon?: boolean;
  islandSurface?: IslandSurface;
  sound?: boolean;
  csat?: boolean;
  logoKey?: string;
  logoDarkKey?: string;
}

const FIELDS = ["displayName", "greeting", "replyTime", "placeholder", "suggestions", "color", "position", "theme", "radius", "launcher", "buttonStyle", "neon", "islandSurface", "sound", "csat"] as const;
const pick = (s: Draft): Draft => Object.fromEntries(FIELDS.filter((f) => s[f] !== undefined).map((f) => [f, s[f]])) as Draft;
const same = (a: Draft, b: Draft) => FIELDS.every((f) => JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null));

function LookTab({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const [widgetKey, setWidgetKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<Draft>({});
  const [draft, setDraft] = useState<Draft>({});
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: Draft } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => {
      if (!r.inbox) return;
      setWidgetKey(r.inbox.widgetKey);
      setSaved(r.inbox.settings);
      setDraft(pick(r.inbox.settings));
    }, () => {});
  }, [workspaceId]);

  const edit = (patch: Draft) => {
    setDraft((d) => ({ ...d, ...patch }));
    setStatus(null);
  };
  const dirty = !same(draft, saved);
  const logoUrl = widgetKey && saved.logoKey ? `/api/widget/${widgetKey}/logo?v=${saved.logoKey}` : null;
  const logoDarkUrl = widgetKey && saved.logoDarkKey ? `/api/widget/${widgetKey}/logo-dark?v=${saved.logoDarkKey}` : null;
  const look = useMemo(() => widgetLook(draft as Record<string, unknown>, workspaceName, logoUrl, logoDarkUrl), [draft, workspaceName, logoUrl, logoDarkUrl]);

  const save = () =>
    run(async () => {
      // Empty text and no suggestions clear those fields back to their defaults.
      const body = {
        ...draft,
        displayName: draft.displayName ?? "",
        greeting: draft.greeting ?? "",
        replyTime: draft.replyTime ?? "",
        placeholder: draft.placeholder ?? "",
        suggestions: draft.suggestions ?? [],
        csat: draft.csat !== false,
        neon: draft.neon !== false,
        sound: draft.sound !== false,
      };
      const r = await api<{ settings: Draft }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body });
      setSaved(r.settings);
      setDraft(pick(r.settings));
      setStatus("Saved. Visitors see it within a minute; no need to change the snippet.");
    });

  // W-21: `logo-dark` is the same control for the logo used on dark surfaces.
  const uploadLogo = (file: File, dark = false) =>
    run(async () => {
      const response = await fetch(`/api/workspaces/${workspaceId}/inbox/${dark ? "logo-dark" : "logo"}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Jun-Upload": "1" },
        body: file,
        credentials: "same-origin",
      });
      const json = (await response.json().catch(() => ({}))) as { settings?: Draft; error?: { code: string; message: string } };
      if (!response.ok) throw new ApiError(json.error?.code ?? "http_error", json.error?.message ?? "Upload failed.");
      setSaved((s) => ({ ...s, logoKey: json.settings!.logoKey, logoDarkKey: json.settings!.logoDarkKey }));
    });
  const removeLogo = (dark = false) =>
    run(async () => {
      const r = await api<{ settings: Draft }>(`/workspaces/${workspaceId}/inbox/${dark ? "logo-dark" : "logo"}`, { method: "DELETE" });
      setSaved((s) => ({ ...s, logoKey: r.settings.logoKey, logoDarkKey: r.settings.logoDarkKey }));
    });

  // W-15: the AI drafts questions from the knowledge base into the draft; nothing is saved until Save.
  const draftSuggestions = () =>
    run(async () => {
      const r = await api<{ suggestions: string[] }>(`/workspaces/${workspaceId}/inbox/suggestions/draft`, { method: "POST", body: {} });
      edit({ suggestions: r.suggestions });
      setStatus("Drafted from your knowledge. Edit them, then Save.");
    });

  const off = !canEdit || busy;
  const suggestions = draft.suggestions ?? [];

  return (
    <div className="appear-page">
      <aside className="appear-controls" aria-label="Widget look">
        <div className="appear-heading">
          <h2>Preview</h2>
          <div className="segmented" role="group" aria-label="Preview">
            <Button variant="ghost" size="sm" className={open ? "active" : ""} aria-pressed={open} onClick={() => setOpen(true)}>Chat</Button>
            <Button variant="ghost" size="sm" className={open ? "" : "active"} aria-pressed={!open} onClick={() => setOpen(false)}>Closed</Button>
          </div>
        </div>
        <ScrollArea className="appear-scroll" contentClassName="appear-body">
          {!canEdit && <p className="muted small">Only owners and admins can change the widget's look.</p>}

          <section className="appear-group">
            <h2>Brand</h2>
            <Field label="Name shown in the chat" htmlFor="appear-name">
              <Input id="appear-name" value={draft.displayName ?? ""} placeholder={workspaceName} maxLength={TEXT_LIMITS.displayName} disabled={off} onChange={(e) => edit({ displayName: e.target.value })} />
            </Field>
            <Field label="Logo" hint="In the chat header. PNG, JPEG, WebP or GIF, up to 512 KB. Saved as soon as you pick it." htmlFor="appear-logo">
              <div className="appear-logo">
                {logoUrl ? <img src={logoUrl} alt="Current logo" /> : <span className="appear-logo-empty" aria-hidden="true" />}
                {canEdit && <Input id="appear-logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />}
                {canEdit && logoUrl && <Button variant="outline" size="sm" disabled={busy} onClick={() => removeLogo()}>Remove</Button>}
              </div>
            </Field>
            <Field label="Logo on dark backgrounds" hint="Optional. Used on the dark island and dark theme. Leave empty to use the logo above." htmlFor="appear-logo-dark">
              <div className="appear-logo dark">
                {logoDarkUrl ? <img src={logoDarkUrl} alt="Current logo on dark backgrounds" /> : <span className="appear-logo-empty" aria-hidden="true" />}
                {canEdit && <Input id="appear-logo-dark" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f, true); e.target.value = ""; }} />}
                {canEdit && logoDarkUrl && <Button variant="outline" size="sm" disabled={busy} onClick={() => removeLogo(true)}>Remove</Button>}
              </div>
            </Field>
            <Field label="Theme" hint="Auto follows each visitor's light or dark system setting." htmlFor="appear-theme">
              <NativeSelect id="appear-theme" value={look.theme} disabled={off} onChange={(e) => edit({ theme: e.target.value as WidgetTheme })}>
                <NativeSelectOption value="auto">Auto</NativeSelectOption>
                <NativeSelectOption value="light">Light</NativeSelectOption>
                <NativeSelectOption value="dark">Dark</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label="Brand colour" hint="The launcher, the card's buttons and the send button. Text on it switches between dark and white to stay readable." htmlFor="appear-color">
              <div className="appear-color">
                <input type="color" value={look.color} disabled={off} onChange={(e) => edit({ color: e.target.value })} aria-label="Pick a brand colour" />
                <Input id="appear-color" value={draft.color ?? APPEARANCE_DEFAULTS.color} maxLength={7} spellCheck={false} disabled={off} onChange={(e) => edit({ color: e.target.value.trim() })} aria-invalid={!/^#[0-9a-f]{6}$/i.test(draft.color ?? APPEARANCE_DEFAULTS.color)} />
              </div>
            </Field>
          </section>

          <section className="appear-group">
            <h2>Shape and placement</h2>
            <Field label="Corner rounding" hint="The chat window, message bubbles and buttons." htmlFor="appear-radius">
              <div className="appear-range">
                <input id="appear-radius" type="range" min={0} max={RADIUS_MAX} step={1} value={look.radius} disabled={off} onChange={(e) => edit({ radius: Number(e.target.value) })} />
                <output htmlFor="appear-radius">{look.radius}px</output>
              </div>
            </Field>
            <Field label="Side of the page" htmlFor="appear-side">
              <NativeSelect id="appear-side" value={look.position} disabled={off} onChange={(e) => edit({ position: e.target.value as "left" | "right" })}>
                <NativeSelectOption value="right">Right</NativeSelectOption>
                <NativeSelectOption value="left">Left</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field
              label="Closed state"
              hint={
                look.launcher === "bar"
                  ? "An \"Ask anything…\" bar instead of a button, showing your suggested questions. The chat opens above it on dark glass. Theme and rounding don't apply to it."
                  : look.launcher === "island"
                    ? "A small pill at the bottom centre that changes shape with each moment: it opens into a question box, shrinks to a status line while the assistant works, grows around the answer, and offers help as one line. Uses your brand colour and rounding; the side doesn't apply. \"/\" opens it."
                    : "The greeting card shows your greeting above the button until the visitor dismisses it or opens the chat (once per visit)."
              }
              htmlFor="appear-launcher"
            >
              <NativeSelect id="appear-launcher" value={look.launcher} disabled={off} onChange={(e) => { edit({ launcher: e.target.value as LauncherStyle }); setOpen(false); }}>
                <NativeSelectOption value="button">Chat button only</NativeSelectOption>
                <NativeSelectOption value="card">Greeting card</NativeSelectOption>
                <NativeSelectOption value="bar">Ask bar</NativeSelectOption>
                <NativeSelectOption value="island">Island</NativeSelectOption>
              </NativeSelect>
            </Field>
            {look.launcher === "button" && (
              <Field label="Button shows" hint={look.logoUrl ? "Your logo, or the words." : "Your logo once you upload one (a chat bubble until then), or the words."} htmlFor="appear-button">
                <NativeSelect id="appear-button" value={look.buttonStyle} disabled={off} onChange={(e) => edit({ buttonStyle: e.target.value as ButtonStyle })}>
                  <NativeSelectOption value="logo">Company logo</NativeSelectOption>
                  <NativeSelectOption value="text">"{BUTTON_TEXT}"</NativeSelectOption>
                </NativeSelect>
              </Field>
            )}
            {look.launcher === "island" && (
              <Field label="Island colour" hint={look.islandSurface === "dark" ? "Near-black with white text on every page, whatever the theme." : "Follows the Theme above, like the rest of the widget."} htmlFor="appear-island">
                <NativeSelect id="appear-island" value={look.islandSurface} disabled={off} onChange={(e) => edit({ islandSurface: e.target.value as IslandSurface })}>
                  <NativeSelectOption value="dark">Dark (like Dynamic Island)</NativeSelectOption>
                  <NativeSelectOption value="page">Match the page theme</NativeSelectOption>
                </NativeSelect>
              </Field>
            )}
            {look.launcher === "island" && (
              <label className="appear-switch">
                <Switch checked={draft.neon !== false} disabled={off} onCheckedChange={(checked) => edit({ neon: checked })} />
                <span>Neon border (a slowly turning multi-colour glow around the island)</span>
              </label>
            )}
            <label className="appear-switch">
              <Switch checked={draft.sound !== false} disabled={off} onCheckedChange={(checked) => edit({ sound: checked })} />
              <span>Play a sound for new replies (a soft chime for a teammate's reply, and for the AI's while the chat is closed or the visitor is on another tab)</span>
            </label>
            {/* Hear it here: the same chime the widget plays. Type "button": this sits in the settings form. */}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={previewChime}>Test sound</Button>
            </div>
          </section>

          <section className="appear-group">
            <h2>Wording</h2>
            <p className="muted small">Leave a field empty to use the text shown in it.</p>
            <Field label="Greeting" htmlFor="appear-greeting">
              <Input id="appear-greeting" value={draft.greeting ?? ""} placeholder={APPEARANCE_DEFAULTS.greeting} maxLength={TEXT_LIMITS.greeting} disabled={off} onChange={(e) => edit({ greeting: e.target.value })} />
            </Field>
            <Field label="Reply time" hint="Under the name in the header (outside business hours it says when you're back instead)." htmlFor="appear-reply">
              <Input id="appear-reply" value={draft.replyTime ?? ""} placeholder={APPEARANCE_DEFAULTS.replyTime} maxLength={TEXT_LIMITS.replyTime} disabled={off} onChange={(e) => edit({ replyTime: e.target.value })} />
            </Field>
            <Field label="Message box placeholder" htmlFor="appear-placeholder">
              <Input id="appear-placeholder" value={draft.placeholder ?? ""} placeholder={APPEARANCE_DEFAULTS.placeholder} maxLength={TEXT_LIMITS.placeholder} disabled={off} onChange={(e) => edit({ placeholder: e.target.value })} />
            </Field>
            <Field label="Suggested questions" hint={`One per line, up to ${SUGGESTIONS_MAX}. Shown under the greeting; tapping one sends it.`} htmlFor="appear-suggestions">
              <Textarea
                id="appear-suggestions"
                rows={4}
                value={suggestions.join("\n")}
                placeholder={"How much does it cost?\nHow do I invite my team?"}
                disabled={off}
                onChange={(e) => edit({ suggestions: e.target.value.split("\n").slice(0, SUGGESTIONS_MAX).map((q) => q.slice(0, SUGGESTION_LIMIT)) })}
              />
              {canEdit && (
                <div className="appear-draft">
                  <Button variant="outline" size="sm" disabled={busy} onClick={draftSuggestions}>Draft from your knowledge</Button>
                  <span className="muted small">Replaces the questions above; nothing changes for visitors until you Save.</span>
                </div>
              )}
            </Field>
          </section>

          <section className="appear-group">
            <h2>After the chat</h2>
            <label className="appear-switch">
              <Switch checked={draft.csat !== false} disabled={off} onCheckedChange={(checked) => edit({ csat: checked })} />
              <span>Ask "How did we do?" when a conversation is resolved</span>
            </label>
          </section>
        </ScrollArea>
        {canEdit && (
          <div className="appear-actions">
            <Button disabled={busy || !dirty} onClick={save}>Save</Button>
            <Button variant="outline" disabled={busy} onClick={() => edit({ displayName: "", greeting: "", replyTime: "", placeholder: "", suggestions: [], color: APPEARANCE_DEFAULTS.color, position: "right", theme: "auto", radius: APPEARANCE_DEFAULTS.radius, launcher: APPEARANCE_DEFAULTS.launcher, buttonStyle: "logo", neon: true, islandSurface: APPEARANCE_DEFAULTS.islandSurface, sound: APPEARANCE_DEFAULTS.sound, csat: true })}>Reset to defaults</Button>
            <span className={error ? "error small" : "muted small"} role="status">{error ?? status ?? (dirty ? "Unsaved changes" : "")}</span>
          </div>
        )}
      </aside>
      {widgetKey && <Preview widgetKey={widgetKey} look={look} open={open} onOpen={setOpen} />}
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="appear-field">
      <label htmlFor={htmlFor}>{label}</label>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}

/** The real widget frame with the draft look (it draws the bar and the closed card itself), plus a copy of the loader's button. */
function Preview({ widgetKey, look, open, onOpen }: { widgetKey: string; look: ReturnType<typeof widgetLook>; open: boolean; onOpen: (open: boolean) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The frame asks for the look when it's ready (also after reloading itself).
  const lookRef = useRef(look);
  lookRef.current = look;
  const openRef = useRef(open);
  openRef.current = open;
  const post = useCallback((message: unknown) => frame.current?.contentWindow?.postMessage(message, window.location.origin), []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; id?: string } | null;
      if (data?.type === "jun:ready") {
        post({ type: "jun:preview", look: lookRef.current });
        post({ type: openRef.current ? "jun:open" : "jun:close" });
      }
      if (data?.type === "jun:close") onOpen(false);
      // The bar and the card open themselves, and size and place their frame like the loader does.
      if (data?.type === "jun:open") onOpen(true);
      if (data?.type === "jun:css" && frame.current) {
        frame.current.style.cssText = String((data as { css?: unknown }).css ?? "");
        frame.current.dataset.sized = "";
      }
      // No host page here, so no debug context: answer at once instead of letting it time out.
      if (data?.type === "jun:context-request") post({ type: "jun:context", id: data.id, context: undefined });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, onOpen]);

  useEffect(() => post({ type: "jun:preview", look }), [look, post]);
  useEffect(() => post({ type: open ? "jun:open" : "jun:close" }), [open, post]);
  const button = look.launcher === "button";
  // Changing the launcher, or closing a chat opened from the button: drop the size the frame gave
  // itself (the frame sends its own again). The bar and the card keep theirs when they close: they
  // send their closed size and clip with the close, and wiping it would leave a full, white frame.
  const launcher = useRef(look.launcher);
  useEffect(() => {
    const changed = launcher.current !== look.launcher;
    launcher.current = look.launcher;
    if (frame.current && (changed || (button && !open))) {
      frame.current.style.cssText = "";
      delete frame.current.dataset.sized;
    }
  }, [look.launcher, open, button]);
  const brand = { "--c": look.color, "--t": textOn(look.color), "--r": `${look.radius}px` } as CSSProperties;
  // As the loader: on a dark button colour, the logo for dark backgrounds (W-21).
  const buttonLogo = logoFor(look, textOn(look.color) === "#ffffff");
  return (
    <div className="appear-preview" aria-label="Preview">
      <div className={`appear-stage ${look.position} ${look.theme} ${look.launcher}`} style={brand}>
        <iframe
          ref={frame}
          className="appear-frame"
          title="Widget preview"
          src={`/widget?key=${encodeURIComponent(widgetKey)}&preview=1&persist=0`}
          hidden={!open && button}
        />
        {/* The open chat takes the button's corner, as on a website. */}
        {button && !open && (
          <button className={`appear-launcher${look.buttonStyle === "text" ? " txt" : ""}`} aria-label="Open chat" aria-expanded={false} onClick={() => onOpen(true)}>
            {look.buttonStyle === "text" ? (
              <span>{BUTTON_TEXT}</span>
            ) : buttonLogo ? (
              <img src={buttonLogo} alt="" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" />
              </svg>
            )}
          </button>
        )}
      </div>
      <p className="appear-note muted small">This is the real widget with your unsaved changes. Messages you send here start real chats in your inbox.</p>
    </div>
  );
}
