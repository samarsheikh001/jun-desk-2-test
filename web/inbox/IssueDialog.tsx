import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ISSUE_BODY_MAX, ISSUE_IMAGES_MAX, ISSUE_TITLE_MAX, type IssueImage } from "../../shared/issues.ts";
import type { ConversationIssue, IssueProvider } from "../../shared/protocol.ts";
import { api, describeError } from "../api.ts";
import { formatSize } from "../lib/thread.ts";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { PixelLoader } from "@/components/PixelLoader.tsx";

interface Draft {
  title: string;
  body: string;
  source: "ai" | "template";
  notice: string | null;
}

/** What filing returns: the issue, and how many images didn't make it (S-14). */
export interface FiledIssue {
  issue: ConversationIssue;
  imagesFailed?: number;
  notice?: string;
}

interface ImageList {
  images: IssueImage[];
  githubPrivate: boolean | null;
}

/**
 * S-14: which images start ticked. Linear gets real uploads (private to the Linear workspace);
 * GitHub only gets links to the desk's file URLs, so only for a repo known to be private.
 */
function defaultImages(provider: IssueProvider, list: ImageList): Set<string> {
  if (provider === "github" && list.githubPrivate !== true) return new Set();
  return new Set(list.images.slice(-ISSUE_IMAGES_MAX).map((i) => i.key));
}

const LAST_PROVIDER = "jun.issueProvider";
const NAMES: Record<IssueProvider, string> = { github: "GitHub", linear: "Linear" };

/** The configured trackers, in a stable order. */
export function configuredProviders(trackers: TrackerStatus | null): IssueProvider[] {
  if (!trackers) return [];
  return (["github", "linear"] as const).filter((p) => trackers[p].configured);
}

function rememberedProvider(available: IssueProvider[]): IssueProvider {
  try {
    const last = window.localStorage.getItem(LAST_PROVIDER);
    if (last === "github" || last === "linear") {
      if (available.includes(last)) return last;
    }
  } catch {
    // storage blocked: fall back to the first one
  }
  return available[0]!;
}

/**
 * S-08: "Create issue". The AI drafts, the agent edits, picks GitHub or Linear (when both are set
 * up) and files it. Nothing is sent to a tracker until they press Create issue.
 */
export function IssueDialog({ conversationId, trackers, onClose, onCreated }: { conversationId: string; trackers: TrackerStatus; onClose: () => void; onCreated: (filed: FiledIssue) => void }) {
  const available = configuredProviders(trackers);
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<IssueProvider>(() => rememberedProvider(available));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("bug");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<ImageList | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // One key per dialog: a retried or double-clicked Create never files twice.
  const clientId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    let cancelled = false;
    api<Draft>(`/conversations/${conversationId}/issue-draft`, { body: {} }).then(
      (d) => {
        if (cancelled) return;
        setDraft(d);
        setTitle(d.title);
        setBody(d.body);
      },
      (e: unknown) => !cancelled && setError(describeError(e)),
    );
    api<ImageList>(`/conversations/${conversationId}/issue-images`).then(
      (list) => {
        if (cancelled) return;
        setImages(list);
        setPicked(defaultImages(provider, list));
      },
      () => !cancelled && setImages({ images: [], githubPrivate: null }),
    );
    return () => {
      cancelled = true;
    };
    // The provider's defaults apply once the list loads; pick() resets them on a switch.
  }, [conversationId]);

  const pick = (next: IssueProvider) => {
    setProvider(next);
    // A switch resets the ticks to that tracker's safe default (a public repo starts unticked).
    if (images) setPicked(defaultImages(next, images));
    try {
      window.localStorage.setItem(LAST_PROVIDER, next);
    } catch {
      // not remembered; fine
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const names = provider === "github" ? labels.split(",").map((l) => l.trim()).filter(Boolean) : [];
      const chosen = (images?.images ?? []).filter((i) => picked.has(i.key)).map((i) => i.key);
      onCreated(await api<FiledIssue>(`/conversations/${conversationId}/issues`, { body: { provider, title, body, labels: names, clientId, images: chosen } }));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const target = provider === "github" ? trackers.github.repo : trackers.linear.team ? `${trackers.linear.team.name} (${trackers.linear.team.key})` : "";
  return (
    <dialog ref={dialog} className="issue-dialog" aria-labelledby="issue-dialog-title" onClose={onClose} onCancel={(e) => busy && e.preventDefault()}>
      {/* The dialog's scroller (it was the dialog itself). Focus is always inside the form, so no extra tab stop. */}
      <ScrollArea viewportProps={{ tabIndex: -1 }}>
      <form onSubmit={submit}>
        <div className="row">
          <h2 id="issue-dialog-title">Create issue</h2>
          <span className="spacer" />
          {available.length > 1 ? (
            <span className="segmented" role="radiogroup" aria-label="Where to file it">
              {available.map((p) => (
                <Button key={p} variant="ghost" size="sm" type="button" role="radio" aria-checked={provider === p} className={provider === p ? "active" : ""} disabled={busy} onClick={() => pick(p)}>
                  {NAMES[p]}
                </Button>
              ))}
            </span>
          ) : (
            <span className="muted small">{NAMES[provider]}</span>
          )}
        </div>
        <p className="muted small issue-target">
          Files to <code>{target}</code>
        </p>
        {!draft ? (
          error ? (
            <p className="error small">{error}</p>
          ) : (
            <p className="muted issue-drafting" role="status"><span className="typing" aria-hidden="true"><PixelLoader /></span> Drafting from the conversation and the visitor's browser…</p>
          )
        ) : (
          <>
            <p className="muted small">
              {draft.source === "ai" ? "Drafted by the AI from the conversation and the masked browser details. Check it: it's filed exactly as written." : draft.notice}
            </p>
            <label className="field">
              <span>Title</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ISSUE_TITLE_MAX} required autoFocus />
            </label>
            <label className="field">
              <span>Description <span className="muted small">(Markdown)</span></span>
              <Textarea className="issue-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={ISSUE_BODY_MAX} spellCheck={false} />
            </label>
            {provider === "github" && (
              <label className="field">
                <span>Labels <span className="muted small">(comma-separated; GitHub only applies labels that exist)</span></span>
                <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, billing" />
              </label>
            )}
            {images && images.images.length > 0 && (
              <IssueImages
                provider={provider}
                repo={trackers.github.repo}
                list={images}
                picked={picked}
                disabled={busy}
                toggle={(key) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else if (next.size < ISSUE_IMAGES_MAX) next.add(key);
                    return next;
                  })
                }
              />
            )}
            {error && <p className="error small">{error}</p>}
          </>
        )}
        <div className="row issue-actions">
          <span className="muted small">Visitors never see this.</span>
          <span className="spacer" />
          <Button variant="outline" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</Button>
          <Button disabled={!draft || busy || !title.trim()}>{busy ? "Creating…" : `Create in ${NAMES[provider]}`}</Button>
        </div>
      </form>
      </ScrollArea>
    </dialog>
  );
}

/** S-14: the conversation's images as thumbnails with checkboxes, and where they'll end up. */
function IssueImages({ provider, repo, list, picked, disabled, toggle }: { provider: IssueProvider; repo: string | null; list: ImageList; picked: Set<string>; disabled: boolean; toggle: (key: string) => void }) {
  const full = picked.size >= ISSUE_IMAGES_MAX;
  const exposed = provider === "github" && list.githubPrivate !== true;
  return (
    <fieldset className="issue-images">
      <legend>
        Screenshots <span className="muted small">{picked.size} of {list.images.length} selected{list.images.length > ISSUE_IMAGES_MAX ? ` (up to ${ISSUE_IMAGES_MAX})` : ""}</span>
      </legend>
      {exposed ? (
        <p className="issue-images-warning small" role="note">
          ⚠ {list.githubPrivate === false ? `${repo} is public.` : `Couldn't check whether ${repo} is private.`} GitHub can't store images for us, so they're added as links to this desk.
          Anyone who can see this repo can open these images.
        </p>
      ) : (
        <p className="muted small">
          {provider === "linear" ? "Uploaded to Linear with the issue: only your Linear workspace can see them." : `Added as links to this desk's file URLs. ${repo} is private, but anyone with the link can open an image.`}
        </p>
      )}
      <ul>
        {list.images.map((image) => {
          const checked = picked.has(image.key);
          return (
            <li key={image.key}>
              <label className={checked ? "checked" : ""} title={image.name}>
                <input type="checkbox" checked={checked} disabled={disabled || (!checked && full)} onChange={() => toggle(image.key)} aria-label={`Include ${image.name}`} />
                <img src={`/api/files/${encodeURIComponent(image.key)}`} alt="" loading="lazy" />
                <span className="issue-image-meta">{image.from === "visitor" ? "Visitor" : image.internal ? "Team note" : "Agent"} · {formatSize(image.size)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
