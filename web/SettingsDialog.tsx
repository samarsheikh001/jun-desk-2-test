import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, registerPasskey, type Me } from "./api.ts";
import { IssueTrackersPanel } from "./settings/IssueTrackersPanel.tsx";
import { AssignmentPanel, SavedRepliesPanel, TagsPanel, TopicsPanel } from "./settings/InboxPanels.tsx";
import { NotificationsPanel } from "./settings/NotificationsPanel.tsx";
import { HoursPanel, type InboxSettings } from "./settings/WidgetPanels.tsx";
import { SettingRow, SettingsCard } from "./settings/layout.tsx";
import { navigate } from "./lib/router.ts";
import { AiPanel, GitCard } from "./agent/AiPanel.tsx";
import { setThemePref, THEME_LABEL, THEME_PREFS, useThemePref } from "./lib/theme.ts";
import { useAction } from "./useAction.ts";
import {
  BugIcon, ChevronLeftIcon, CodeIcon, InboxIcon, KeyIcon, MonitorIcon, MoonIcon, NotificationIcon, SettingsIcon, SparkleIcon, SunIcon, UsersIcon, XIcon,
} from "@/components/icons";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";

interface Passkey { id: string; name: string | null; backedUp: number; createdAt: number; lastUsedAt: number | null }
type Role = "owner" | "admin" | "agent";
interface Member { id: string; name: string; email: string | null; role: Role }
interface Invite { id: string; role: Role; createdBy: string; createdAt: number; expiresAt: number }

const RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };
const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

// Town's settings dialog (D-35): a 924×720 modal, a 224px nav on the left (the sections, then the theme
// at the bottom) and one section at a time in the pane. The URL follows the
// open section (/settings/<id>, /settings = the first), so links, the back button and reloads work;
// the page you came from stays behind it.
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", Icon: SettingsIcon },
  { id: "ai", label: "AI", Icon: SparkleIcon },
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "team", label: "Team", Icon: UsersIcon },
  { id: "notifications", label: "Notifications", Icon: NotificationIcon },
  { id: "integrations", label: "Issue trackers", Icon: BugIcon },
  { id: "developer", label: "Developer", Icon: CodeIcon },
  { id: "account", label: "Passkeys", Icon: KeyIcon },
] as const;
type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

// Old one-page anchors (bookmarks, other pages' links) → the section that now holds them.
const LEGACY_HASHES: Record<string, string> = {
  "#topics": "/settings/inbox#topics",
  "#assignment": "/settings/inbox#assignment",
  "#issue-trackers": "/settings/integrations#issue-trackers",
  "#notifications": "/settings/notifications",
};

/**
 * Settings URLs whose parts moved: the widget's install panels (the Widget page's Install tab), and
 * old links to the AI settings (D-71: Settings → AI). The ChatGPT sign-in still returns to
 * /settings?chatgpt=connected. Null when the URL is still the dialog's.
 */
export function movedFromSettings(path: string, search: string, hash: string): string | null {
  if (!path.startsWith("/settings")) return null;
  const sub = path.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  if (sub === "widget") return "/appearance/install";
  if (!sub && (hash === "#ai-assistant" || new URLSearchParams(search).get("chatgpt") === "connected")) return `/settings/ai${search}`;
  return null;
}

/** Open while the URL is /settings…; `onClose` leaves it (back to the page behind). */
export function SettingsDialog({ me, path, onClose }: { me: Me; path: string; onClose: () => void }) {
  const workspace = me.memberships?.[0];
  const sub = path.replace(/^\/settings\/?/, "").split("/")[0] ?? "";
  const section = SETTINGS_SECTIONS.find((s) => s.id === sub) ?? SETTINGS_SECTIONS[0];
  // Phones show the nav as a list first (Town's mobile layout); a section URL opens straight on it.
  const [mobileList, setMobileList] = useState(!sub);
  const pane = useRef<HTMLDivElement>(null);
  const themePref = useThemePref();

  useEffect(() => {
    if (sub && !SETTINGS_SECTIONS.some((s) => s.id === sub)) return navigate("/settings", { replace: true });
    if (sub) return;
    const { hash } = window.location;
    if (LEGACY_HASHES[hash]) navigate(LEGACY_HASHES[hash], { replace: true });
  }, [sub]);
  // A new section starts at the top (an #anchor scrolls itself into view).
  useEffect(() => {
    if (!window.location.hash) pane.current?.scrollTo(0, 0);
  }, [section.id]);

  if (!workspace || !me.user) return null;
  const { workspaceId } = workspace;
  const canEdit = workspace.role !== "agent";
  const open = (id: SectionId) => {
    setMobileList(false);
    navigate(`/settings/${id}`, { replace: true });
  };

  const nextTheme = THEME_PREFS[(THEME_PREFS.indexOf(themePref) + 1) % THEME_PREFS.length]!;
  const ThemeIcon = THEME_ICON[themePref];

  const nav = (
    <>
      <span className="settings-nav-label">Settings</span>
      {SETTINGS_SECTIONS.map(({ id, label, Icon }) => (
        <button key={id} type="button" data-plain className="settings-nav-item" aria-current={id === section.id ? "page" : undefined} onClick={() => open(id)}>
          <Icon />
          <span>{label}</span>
        </button>
      ))}
    </>
  );

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="settings-dialog" showCloseButton={false} data-view={mobileList ? "list" : "section"} initialFocus={pane}>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <aside className="settings-nav" aria-label="Settings sections">
          {nav}
          <div className="settings-nav-foot">
            <button type="button" data-plain className="settings-nav-tile" onClick={() => setThemePref(nextTheme)} aria-label={`Theme: ${THEME_LABEL[themePref]} (switch to ${THEME_LABEL[nextTheme]})`}>
              <ThemeIcon />
              <span>Theme</span>
              <span className="settings-nav-tile-value">{THEME_LABEL[themePref]}</span>
            </button>
          </div>
        </aside>
        <div className="settings-pane" ref={pane} tabIndex={-1}>
          <nav className="settings-mobile-nav" aria-label="Settings sections">{nav}</nav>
          <button type="button" data-plain className="settings-back" onClick={() => setMobileList(true)}>
            <ChevronLeftIcon />
            Settings
          </button>
          <div className="settings-sections">
            <Section id={section.id} me={me} workspaceId={workspaceId} canEdit={canEdit} role={workspace.role} myId={me.user.id} />
          </div>
        </div>
        <DialogClose className="settings-close" aria-label="Close settings">
          <XIcon />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function Section({ id, me, workspaceId, canEdit, role, myId }: { id: SectionId; me: Me; workspaceId: string; canEdit: boolean; role: Role; myId: string }) {
  switch (id) {
    case "general":
      return <GeneralPanel me={me} />;
    case "ai":
      return (
        <>
          <AiPanel workspaceId={workspaceId} canEdit={canEdit} />
          <GitCard />
        </>
      );
    case "inbox":
      return (
        <>
          <AssignmentPanel workspaceId={workspaceId} canEdit={canEdit} />
          <WidgetSettings workspaceId={workspaceId} canEdit={canEdit} />
          <SavedRepliesPanel workspaceId={workspaceId} />
          <TagsPanel workspaceId={workspaceId} canEdit={canEdit} />
          <TopicsPanel workspaceId={workspaceId} canEdit={canEdit} />
        </>
      );
    case "team":
      return <TeamPanel workspaceId={workspaceId} myRole={role} myId={myId} />;
    case "notifications":
      return <NotificationsPanel workspaceId={workspaceId} />;
    case "integrations":
      return <IssueTrackersPanel workspaceId={workspaceId} canEdit={canEdit} />;
    case "developer":
      return <TokensPanel workspaceId={workspaceId} />;
    case "account":
      return <PasskeysPanel />;
  }
}

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", agent: "Agent" };

/** Town's General: who you're signed in as, in which workspace (read-only: there's no rename API yet). */
function GeneralPanel({ me }: { me: Me }) {
  const workspace = me.memberships?.[0];
  return (
    <SettingsCard title="General" description="Who you're signed in as, in which workspace.">
      <SettingRow label="Name"><span className="setting-row-value">{me.user?.name}</span></SettingRow>
      {me.user?.email && <SettingRow label="Email"><span className="setting-row-value">{me.user.email}</span></SettingRow>}
      {workspace && <SettingRow label="Workspace"><span className="setting-row-value">{workspace.workspaceName}</span></SettingRow>}
      {workspace && <SettingRow label="Role" description="Owners and admins change workspace settings; agents answer chats."><span className="setting-row-value">{ROLE_LABEL[workspace.role]}</span></SettingRow>}
    </SettingsCard>
  );
}

function PasskeysPanel() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const { busy, error, run } = useAction();
  const loadPasskeys = useCallback(async () => {
    setPasskeys((await api<{ passkeys: Passkey[] }>("/passkeys")).passkeys);
  }, []);
  useEffect(() => {
    loadPasskeys().catch(() => {});
  }, [loadPasskeys]);

  return (
    <SettingsCard
      title="Your passkeys"
      description="Add a passkey on a second device so you can't get locked out."
      action={<Button disabled={busy} onClick={() => run(async () => { await registerPasskey("/passkeys"); await loadPasskeys(); })}>Add passkey</Button>}
    >
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {passkeys.map((p) => (
          <li key={p.id}>
            <span>{p.name ?? "Passkey"} {p.backedUp ? <em className="tag">synced</em> : null}</span>
            <span className="muted small">added {date(p.createdAt)} · last used {date(p.lastUsedAt)}</span>
            {passkeys.length > 1 && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); await loadPasskeys(); })}>Remove</Button>
            )}
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

function TeamPanel({ workspaceId, myRole, myId }: { workspaceId: string; myRole: Role; myId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteRole, setInviteRole] = useState<"agent" | "admin">("agent");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const canInvite = myRole === "owner" || myRole === "admin";
  const base = `/workspaces/${workspaceId}`;

  const load = useCallback(async () => {
    setMembers((await api<{ members: Member[] }>(`${base}/members`)).members);
    if (canInvite) setInvites((await api<{ invites: Invite[] }>(`${base}/invites`)).invites);
  }, [base, canInvite]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const createInvite = () =>
    run(async () => {
      setCopied(false);
      setInviteUrl((await api<{ url: string }>(`${base}/invites`, { body: { role: inviteRole } })).url);
      await load();
    });

  const copy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  };

  return (
    <>
      <SettingsCard
        title="Members"
        description={<>Each person signs in with their own passkey.{myRole === "owner" && " Admins can invite and manage agents; only you can manage admins."}</>}
      >
        {error && <p className="error">{error}</p>}
        <ul className="list">
          {members.map((m) => {
            const manageable = RANK[myRole] > RANK[m.role];
            return (
              <li key={m.id}>
                <span>{m.name}{m.id === myId && <span className="muted"> (you)</span>}</span>
                <span className="muted small">{m.email}</span>
                {manageable ? (
                  <>
                    <NativeSelect
                      value={m.role}
                      disabled={busy}
                      aria-label={`Role for ${m.name}`}
                      onChange={(e) => run(async () => { await api(`${base}/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }); await load(); })}
                    >
                      <NativeSelectOption value="agent">agent</NativeSelectOption>
                      {myRole === "owner" && <NativeSelectOption value="admin">admin</NativeSelectOption>}
                    </NativeSelect>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (!confirm(`Remove ${m.name}? They'll be signed out and lose access.`)) return; run(async () => { await api(`${base}/members/${m.id}`, { method: "DELETE" }); await load(); }); }}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <em className="tag">{m.role}</em>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {canInvite && (
        <SettingsCard title="Invite people" description="Invite links work once and expire after 7 days.">
          <SettingRow label="Role" description="What the person can do once they join.">
            <div className="row">
              <NativeSelect value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "agent" | "admin")} aria-label="Invite role">
                <NativeSelectOption value="agent">Agent</NativeSelectOption>
                {myRole === "owner" && <NativeSelectOption value="admin">Admin</NativeSelectOption>}
              </NativeSelect>
              <Button disabled={busy} onClick={createInvite}>Create invite link</Button>
            </div>
          </SettingRow>
          {inviteUrl && (
            <div className="invite">
              <span className="small">Send this link to the person you're inviting. It's shown only once.</span>
              <div className="row">
                <code>{inviteUrl}</code>
                <Button size="sm" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="settings-group">
              <h3>Pending invites</h3>
              <ul className="list">
                {invites.map((i) => (
                  <li key={i.id}>
                    <span>{i.role === "admin" ? "Admin" : "Agent"} invite</span>
                    <span className="muted small">by {i.createdBy} · expires {date(i.expiresAt)}</span>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" }); await load(); })}>Revoke</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SettingsCard>
      )}
    </>
  );
}

interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Personal API tokens for the `jun` CLI (pull, push, eval). */
function TokensPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/tokens`;
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setTokens((await api<{ tokens: TokenRow[] }>(base)).tokens), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name"));
    run(async () => {
      setCreated((await api<{ token: string }>(base, { body: { name } })).token);
      form.reset();
      await load();
    });
  };

  return (
    <SettingsCard
      title="API tokens"
      id="api-tokens"
      description={<>For the <code>jun</code> CLI: keep the agent in git, run evals and push changes (<code>npm run jun -- login {window.location.origin}</code> in your Jun Desk checkout). A token acts as you, for this workspace's agent config only.</>}
    >
      {created && (
        <div className="invite">
          <span className="small strong">Copy it now: it won't be shown again.</span>
          <code className="small">{created}</code>
          <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(created); }}>Copy</Button>
        </div>
      )}
      <form className="settings-inline-form" onSubmit={create}>
        <Input name="name" placeholder="Token name, e.g. laptop or GitHub Actions" aria-label="Token name" required maxLength={80} />
        <Button disabled={busy}>Create token</Button>
      </form>
      {error && <p className="error small">{error}</p>}
      {tokens.length > 0 && (
        <ul className="list">
          {tokens.map((t) => (
            <li key={t.id} className="row">
              <span className="strong">{t.name}</span>
              <span className="muted small">created {new Date(t.createdAt).toLocaleDateString()} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
              <span className="spacer" />
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); })}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/** I-10 hours (the widget's look, W-04, is on the Widget page). */
function WidgetSettings({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [inbox, setInbox] = useState<{ widgetKey: string; settings: InboxSettings } | null>(null);
  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: InboxSettings } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => setInbox(r.inbox), () => {});
  }, [workspaceId]);
  if (!inbox) return null;
  return <HoursPanel workspaceId={workspaceId} settings={inbox.settings} canEdit={canEdit} onSaved={(settings) => setInbox({ ...inbox, settings })} />;
}
