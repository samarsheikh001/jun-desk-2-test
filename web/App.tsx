import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { api, describeError, registerPasskey, signInWithPasskey, type Me } from "./api.ts";
import { Shell } from "./Shell.tsx";
import { useAction } from "./useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Card as UiCard } from "@/components/ui/card.tsx";
import { DeskIcon } from "./components/DeskIcon.tsx";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Me>("/me").then(setMe, (e) => setLoadError(describeError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const path = window.location.pathname;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  const done = () => {
    window.history.replaceState(null, "", "/inbox");
    refresh();
  };

  if (loadError) return <Card title="Can't reach Jun Desk"><p className="error">{loadError}</p></Card>;
  if (!me) return <div className="center muted">Loading…</div>;
  if (invite?.[1]) return <InvitePage token={invite[1]} onDone={done} />;
  if (path === "/recover") return <RecoverPage onDone={done} />;
  // T-11: a fresh desk goes straight to "Get started".
  if (!me.setupComplete) return <SetupPage onDone={() => { window.history.replaceState(null, "", "/welcome"); refresh(); }} />;
  if (!me.user) return <LoginPage onDone={refresh} />;
  return <Shell me={me} onSignOut={refresh} />;
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="center">
      <UiCard className="auth-card w-full max-w-[416px] gap-0 p-6">
        <div className="brand"><DeskIcon /><span>Jun Desk</span></div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </UiCard>
    </main>
  );
}

function Field({ label, hint, ...props }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <Input {...props} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const formValues = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

function SetupPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey("/setup", { token: v.token, workspaceName: v.workspaceName, name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title="Set up your desk" subtitle="Create the owner account. You'll sign in with a passkey: your fingerprint, face, or device PIN.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" hint="The SETUP_TOKEN you chose when deploying." />
        <Field label="Workspace name" name="workspaceName" required placeholder="Acme Support" />
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and finish setup"}</Button>
      </form>
    </Card>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card title="Sign in" subtitle="Use the passkey you created for this desk.">
      {error && <p className="error">{error}</p>}
      <Button disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); onDone(); })}>
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </Button>
      <p className="muted small">New here? Ask your workspace admin for an invite link. Each person creates their own passkey.</p>
      <p className="muted small">Owner lost access to every passkey? <a href="/recover">Recover with the setup token</a></p>
    </Card>
  );
}

function RecoverPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { token } = formValues(e);
    run(async () => {
      await registerPasskey("/recover", { token });
      onDone();
    });
  };
  return (
    <Card title="Recover owner access" subtitle="Enter the setup token to add a new passkey to the owner account.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Add a new passkey"}</Button>
      </form>
      <p className="muted small"><a href="/">Back to sign in</a></p>
    </Card>
  );
}

function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api<{ workspaceName: string; role: string }>(`/invites/${token}`).then(setInvite, (e) => setLoadError(describeError(e)));
  }, [token]);

  if (loadError) return <Card title="Invite not available"><p className="error">{loadError}</p></Card>;
  if (!invite) return <div className="center muted">Loading…</div>;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey(`/invites/${token}`, { name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title={`Join ${invite.workspaceName}`} subtitle={`You've been invited as ${invite.role === "admin" ? "an admin" : "an agent"}.`}>
      <form onSubmit={submit}>
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <Button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and join"}</Button>
      </form>
    </Card>
  );
}
