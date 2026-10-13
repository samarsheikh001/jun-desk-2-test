import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { Card } from "@/components/ui/card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

// T-11: first-run "Get started". Each step does the one thing it needs right here, and ticks
// itself off from the desk's real state (so doing it in Settings counts too).

type Step = "account" | "knowledge" | "ai" | "brand" | "install" | "team";

export interface Onboarding {
  steps: Record<Step, boolean>;
  widgetKey: string | null;
  installedOn: string | null;
  dismissed: boolean;
}

export const STEP_ORDER: Step[] = ["account", "knowledge", "ai", "brand", "install", "team"];

export function useOnboarding(workspaceId: string) {
  const [state, setState] = useState<Onboarding | null>(null);
  const load = useCallback(async () => setState(await api<Onboarding>(`/workspaces/${workspaceId}/onboarding`)), [workspaceId]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  return { state, reload: load };
}

function StepCard({ n, title, done, optional, children }: { n: number; title: string; done: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <Card className={`panel step ${done ? "done" : ""}`}>
      <div className="row">
        <span className="step-n">{done ? "✓" : n}</span>
        <h2>{title}</h2>
        {optional && <span className="muted small">optional</span>}
      </div>
      <div className="step-body">{children}</div>
    </Card>
  );
}

export function WelcomePage({ workspaceId, workspaceName, onboarding, reload }: { workspaceId: string; workspaceName: string; onboarding: Onboarding | null; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [color, setColor] = useState("#2f5bea");

  // Crawls and the first install finish in the background: keep the checklist fresh.
  useEffect(() => {
    const timer = setInterval(() => reload().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!onboarding) return <div className="content muted">Loading…</div>;
  const s = onboarding.steps;
  const doneCount = STEP_ORDER.filter((k) => s[k]).length;
  const snippet = onboarding.widgetKey ? `<script src="${window.location.origin}/widget.js" data-key="${onboarding.widgetKey}" defer></script>` : "";

  const addSite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url"));
    run(async () => {
      await api(`/workspaces/${workspaceId}/knowledge/websites`, { body: { url } });
      await reload();
    });
  };
  const turnOnAi = () =>
    run(async () => {
      const current = await api<{ settings: { provider: string; model: string | null; monthlyReplyCap: number } }>(`/workspaces/${workspaceId}/ai`);
      await api(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { ...current.settings, enabled: true } });
      await reload();
    });
  const saveColor = () =>
    run(async () => {
      await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { color } });
      await reload();
    });
  const invite = () =>
    run(async () => {
      setInviteUrl((await api<{ url: string }>(`/workspaces/${workspaceId}/invites`, { body: { role: "agent" } })).url);
      await reload();
    });
  const finish = () =>
    run(async () => {
      await api(`/workspaces/${workspaceId}/onboarding/dismiss`, { body: {} });
      await reload();
      navigate("/inbox");
    });

  return (
    <main className="content">
      <Card className="panel">
        <div className="row">
          <h2>Welcome to {workspaceName}'s desk</h2>
          <span className="spacer" />
          <span className="tag">{doneCount} of {STEP_ORDER.length} done</span>
        </div>
        <p className="muted small">A few minutes to an AI that answers from your docs on your own site. Each step ticks itself off, and you can come back here any time from the top bar.</p>
        <div className="progress"><span style={{ width: `${(doneCount / STEP_ORDER.length) * 100}%` }} /></div>
      </Card>

      <StepCard n={1} title="Create your account" done={s.account}>
        <p className="muted small">Done: you're signed in with a passkey. Keep your setup token somewhere safe; it's how you get back in if you lose every passkey.</p>
      </StepCard>

      <StepCard n={2} title="Add your docs" done={s.knowledge}>
        {s.knowledge ? (
          <p className="muted small">Your knowledge is indexed. Add more or check what was read under <a href="/knowledge" onClick={(e) => { e.preventDefault(); navigate("/knowledge"); }}>Knowledge</a>.</p>
        ) : (
          <>
            <p className="muted small">The AI only answers from what's here, with citations. Paste your help center or docs site; we read its sitemap and re-sync daily. Snippets for anything else are under Knowledge.</p>
            <form className="row" onSubmit={addSite}>
              <Input name="url" type="url" required placeholder="https://docs.yourcompany.com" aria-label="Docs URL" style={{ flex: 1 }} />
              <Button disabled={busy}>Add website</Button>
            </form>
            <p className="muted small">Crawling takes a minute or two; this step ticks itself off when pages are indexed.</p>
          </>
        )}
      </StepCard>

      <StepCard n={3} title="Turn on the AI assistant" done={s.ai}>
        {s.ai ? (
          <p className="muted small">On. It answers new chats first and hands off to your team when it can't help. How it talks, its tasks and actions are on the <a href="/agent" onClick={(e) => { e.preventDefault(); navigate("/agent"); }}>Agent</a> page; provider, model and monthly cap on its <a href="/settings/ai" onClick={(e) => { e.preventDefault(); navigate("/settings/ai"); }}>Settings</a> tab.</p>
        ) : (
          <>
            <p className="muted small">Uses Workers AI out of the box (no API key, included with Cloudflare). You can switch to OpenAI later on the <a href="/settings/ai" onClick={(e) => { e.preventDefault(); navigate("/settings/ai"); }}>Agent page's Settings</a> tab.</p>
            <Button disabled={busy} onClick={turnOnAi}>Turn on the AI</Button>
          </>
        )}
      </StepCard>

      <StepCard n={4} title="Make the widget yours" done={s.brand} optional>
        {s.brand ? (
          <p className="muted small">Branded. Logo, greeting and side are on the <a href="/appearance" onClick={(e) => { e.preventDefault(); navigate("/appearance"); }}>Chat widget</a> page; business hours in <a href="/settings/inbox" onClick={(e) => { e.preventDefault(); navigate("/settings/inbox"); }}>Settings → Inbox</a>.</p>
        ) : (
          <div className="row">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Brand colour" />
            <Button variant="outline" disabled={busy} onClick={saveColor}>Use this colour</Button>
            <span className="muted small">More (logo, greeting) on the <a href="/appearance" onClick={(e) => { e.preventDefault(); navigate("/appearance"); }}>Chat widget</a> page.</span>
          </div>
        )}
      </StepCard>

      <StepCard n={5} title="Put it on your site" done={s.install}>
        <p className="muted small">Paste this in your site's <code>&lt;head&gt;</code>, before your own scripts. It's tiny; the chat loads only when someone opens it. Allowed websites, proactive help and identity verification are on the Widget page's <a href="/appearance/install" onClick={(e) => { e.preventDefault(); navigate("/appearance/install"); }}>Install</a> tab.</p>
        <div className="invite">
          <div className="row">
            <code className="small">{snippet}</code>
            <Button size="sm" onClick={async () => { await navigator.clipboard?.writeText(snippet); setCopied(true); }}>{copied ? "Copied ✓" : "Copy"}</Button>
          </div>
        </div>
        {s.install ? (
          <p className="small">✓ Seen on <code>{onboarding.installedOn}</code>.</p>
        ) : (
          <p className="muted small">
            Not seen on a site yet; this ticks itself off the first time your page loads it. Meanwhile, try it on the{" "}
            <a href={`/demo.html?key=${onboarding.widgetKey}`} target="_blank" rel="noreferrer">demo page</a>.
          </p>
        )}
      </StepCard>

      <StepCard n={6} title="Invite your team" done={s.team} optional>
        {inviteUrl ? (
          <div className="invite">
            <span className="small">Send this link to a teammate (works once, for 7 days):</span>
            <code className="small">{inviteUrl}</code>
          </div>
        ) : s.team ? (
          <p className="muted small">Team invited. Manage people and roles in Settings.</p>
        ) : (
          <Button variant="outline" disabled={busy} onClick={invite}>Create an invite link</Button>
        )}
      </StepCard>

      {error && <p className="error">{error}</p>}
      <div className="row">
        <Button onClick={finish} disabled={busy}>{doneCount === STEP_ORDER.length ? "All set, go to the inbox" : "Hide this, go to the inbox"}</Button>
      </div>
    </main>
  );
}
