import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { SettingRow, SettingsCard } from "./layout.tsx";

interface SavedReplyRow { id: string; title: string; body: string }
interface TagRow { id: string; name: string; conversations: number }

/** I-06: the team's saved replies. Any member can add and edit them. */
export function SavedRepliesPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/saved-replies`;
  const [replies, setReplies] = useState<SavedReplyRow[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setReplies((await api<{ savedReplies: SavedReplyRow[] }>(base)).savedReplies), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { title: String(form.get("title")), body: String(form.get("body")) };
    run(async () => {
      if (editing === "new") await api(base, { body });
      else await api(`${base}/${editing}`, { method: "PATCH", body });
      setEditing(null);
      await load();
    });
  };

  const current = editing && editing !== "new" ? replies.find((r) => r.id === editing) : undefined;
  return (
    <SettingsCard
      title="Saved replies"
      description={<>Answers your team sends often. Type <code>/</code> in the reply box to search them. <code>{"{first_name}"}</code> becomes the customer's first name and{" "}
        <code>{"{agent_name}"}</code> yours.</>}
      action={editing === null && <Button variant="outline" size="sm" onClick={() => setEditing("new")}>New saved reply</Button>}
    >
      {editing !== null && (
        <form className="stack" onSubmit={save} key={editing}>
          <Input name="title" required maxLength={80} placeholder="Title, e.g. Refund policy" aria-label="Saved reply title" defaultValue={current?.title ?? ""} />
          <Textarea name="body" required maxLength={5000} rows={4} placeholder="Hi {first_name}, …" aria-label="Saved reply text" defaultValue={current?.body ?? ""} />
          <div className="row">
            <Button disabled={busy}>Save</Button>
            <Button variant="outline" type="button" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
      {replies.length > 0 && (
        <ul className="list">
          {replies.map((r) => (
            <li key={r.id} className="row">
              <span className="strong">{r.title}</span>
              <span className="muted small clip">{r.body}</span>
              <span className="spacer" />
              <Button variant="outline" size="sm" onClick={() => setEditing(r.id)}>Edit</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/${r.id}`, { method: "DELETE" }); await load(); })}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      {editing === null && replies.length === 0 && <p className="muted">No saved replies yet.</p>}
    </SettingsCard>
  );
}

/** I-07: rename or delete tags (owners and admins). Tags are created from a conversation. */
export function TagsPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/tags`;
  const [tags, setTags] = useState<TagRow[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setTags((await api<{ tags: TagRow[] }>(base)).tags), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <SettingsCard title="Tags" description={`Add tags from a conversation's header ("+ Tag") and filter the inbox by them. Visitors never see tags.`}>
      {error && <p className="error small">{error}</p>}
      {tags.length === 0 ? (
        <p className="muted">No tags yet.</p>
      ) : (
        <ul className="list">
          {tags.map((t) => (
            <li key={t.id} className="row">
              <span className="chip tag-chip">{t.name}</span>
              <span className="muted small">{t.conversations} conversation{t.conversations === 1 ? "" : "s"}</span>
              <span className="spacer" />
              {canEdit && (
                <>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { const name = window.prompt("Rename tag", t.name); if (name && name !== t.name) run(async () => { await api(`${base}/${t.id}`, { method: "PATCH", body: { name } }); await load(); }); }}>
                    Rename
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); })}>Delete</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

interface TopicRow { id: string; name: string; conversations: number }

/**
 * A-02: the AI's topic labels. Owners and admins rename, merge (move the conversations, delete
 * the source) and delete them (those conversations get labelled again later), or label now.
 */
export function TopicsPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/topics`;
  const [topics, setTopics] = useState<TopicRow[] | null>(null);
  const [max, setMax] = useState(40);
  const [merging, setMerging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const ref = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    const r = await api<{ topics: TopicRow[]; max: number }>(base);
    setTopics(r.topics);
    setMax(r.max);
  }, [base]);
  useEffect(() => {
    load().catch(() => setTopics([]));
  }, [load]);
  const loaded = topics !== null;
  useEffect(() => {
    if (loaded && window.location.hash === "#topics") ref.current?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const labelNow = () =>
    run(async () => {
      setNotice(null);
      const r = await api<{ labeled: number; unlabeled: number; skipped?: "ai_off" | "cap_reached" }>(`${base}/label`, { body: {} });
      setNotice(
        r.skipped === "ai_off"
          ? "AI replies are off, so nothing was labelled."
          : r.skipped === "cap_reached"
            ? "The monthly AI cap is reached, so nothing was labelled."
            : r.labeled === 0 && r.unlabeled === 0
              ? "Nothing to label: every quiet chat has a topic."
              : `Labelled ${r.labeled} conversation${r.labeled === 1 ? "" : "s"}.`,
      );
      await load();
    });

  return (
    <SettingsCard
      title="Topics"
      id="topics"
      ref={ref}
      description={`The AI gives each chat a short topic once it's resolved or quiet for 10 minutes, reusing these when one fits (up to ${max}). See them on the Dashboard and filter the inbox by them. Visitors never see topics.`}
      action={canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={labelNow}>{busy ? "Working…" : "Label now"}</Button>}
    >
      {notice && <p className="ok-text small">{notice}</p>}
      {error && <p className="error small">{error}</p>}
      {topics === null ? null : topics.length === 0 ? (
        <p className="muted">No topics yet.</p>
      ) : (
        <ul className="list">
          {topics.map((t) => (
            <li key={t.id}>
              <span>
                <span className="strong">{t.name}</span> <span className="muted small nums">· {t.conversations} conversation{t.conversations === 1 ? "" : "s"}</span>
              </span>
              {canEdit && merging === t.id ? (
                <span className="topic-actions">
                  <NativeSelect
                    aria-label={`Merge ${t.name} into`}
                    defaultValue=""
                    disabled={busy}
                    onChange={(e) => {
                      const into = e.target.value;
                      if (into) run(async () => { await api(`${base}/${t.id}/merge`, { body: { into } }); setMerging(null); await load(); });
                    }}
                  >
                    <NativeSelectOption value="" disabled>Merge into…</NativeSelectOption>
                    {topics.filter((o) => o.id !== t.id).map((o) => <NativeSelectOption key={o.id} value={o.id}>{o.name}</NativeSelectOption>)}
                  </NativeSelect>
                  <Button variant="outline" size="sm" onClick={() => setMerging(null)}>Cancel</Button>
                </span>
              ) : canEdit && (
                <span className="topic-actions">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { const name = window.prompt("Rename topic", t.name); if (name && name !== t.name) run(async () => { await api(`${base}/${t.id}`, { method: "PATCH", body: { name } }); await load(); }); }}>
                    Rename
                  </Button>
                  {topics.length > 1 && <Button variant="outline" size="sm" disabled={busy} onClick={() => setMerging(t.id)}>Merge</Button>}
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Delete "${t.name}"? Its ${t.conversations} conversation${t.conversations === 1 ? "" : "s"} will be labelled again later.`)) { run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); }); } }}>
                    Delete
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

interface Assignment { mode: "manual" | "round_robin"; capacity: number }

/** I-02: who new chats that need a person go to. */
export function AssignmentPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/inbox`;
  const [saved, setSaved] = useState<Assignment | null>(null);
  const [mode, setMode] = useState<Assignment["mode"]>("manual");
  const [capacity, setCapacity] = useState("0");
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ inbox: { settings: { assignment?: Assignment } } | null }>(base).then((r) => {
      const a = r.inbox?.settings.assignment ?? { mode: "manual", capacity: 0 };
      setSaved(a);
      setMode(a.mode);
      setCapacity(String(a.capacity));
    }, () => {});
  }, [base]);
  if (!saved) return null;
  const changed = mode !== saved.mode || Number(capacity) !== saved.capacity;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(async () => {
      const next = (await api<{ settings: { assignment: Assignment } }>(base, { method: "PATCH", body: { assignment: { mode, capacity: Number(capacity) } } })).settings.assignment;
      setSaved(next);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  };

  return (
    <SettingsCard title="Assignment" id="assignment" description="Who gets a chat when the AI hands it to the team, or when a new chat comes in while the AI is off.">
      <form onSubmit={save}>
        <div className="settings-choices" role="radiogroup" aria-label="Assignment">
          <label className="settings-choice">
            <input type="radio" name="mode" checked={mode === "manual"} onChange={() => setMode("manual")} disabled={!canEdit} />
            <span><span className="setting-row-label">Manual</span><span className="setting-row-desc">Chats wait in Unassigned until someone takes them.</span></span>
          </label>
          <label className="settings-choice">
            <input type="radio" name="mode" checked={mode === "round_robin"} onChange={() => setMode("round_robin")} disabled={!canEdit} />
            <span><span className="setting-row-label">Round robin</span><span className="setting-row-desc">Give each chat to the next teammate who has the dashboard open.</span></span>
          </label>
        </div>
        {mode === "round_robin" && (
          <SettingRow label="Most open chats per teammate" description="0 = no limit." htmlFor="assign-capacity">
            <Input id="assign-capacity" type="number" min={0} max={100} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} disabled={!canEdit} />
          </SettingRow>
        )}
        {mode === "round_robin" && <p className="muted">If nobody's online or everyone is at the limit, the chat stays in Unassigned. Assigning someone by hand always wins.</p>}
        {error && <p className="error small">{error}</p>}
        {canEdit && (
          <div className="row">
            <Button disabled={busy || !changed}>Save</Button>
            {done && <span className="ok-text small">Saved</span>}
          </div>
        )}
      </form>
    </SettingsCard>
  );
}
