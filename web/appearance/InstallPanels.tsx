import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { OpenersPanel } from "../settings/OpenersPanel.tsx";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { useAction } from "../useAction.ts";
import type { OpenerRule } from "../../shared/openers.ts";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";

// The Widget page's Install tab: the snippet, where it may run, when it reaches out first, and
// identity verification (V-03). The look is on the Look tab.

export function InstallPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [widgetKey, setWidgetKey] = useState<string | null>(null);
  const [proactive, setProactive] = useState(true);
  const [openers, setOpeners] = useState<OpenerRule[]>([]);
  const [copied, setCopied] = useState(false);
  const [domains, setDomains] = useState("");
  const [savedDomains, setSavedDomains] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: { proactive?: boolean; allowedDomains?: string[]; openers?: OpenerRule[] } } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => {
      setWidgetKey(r.inbox?.widgetKey ?? null);
      setProactive(r.inbox?.settings.proactive !== false);
      setOpeners(r.inbox?.settings.openers ?? []);
      const list = (r.inbox?.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  }, [workspaceId]);
  const saveDomains = () =>
    run(async () => {
      const r = await api<{ settings: { allowedDomains?: string[] } }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: domains } });
      const list = (r.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  const toggleProactive = async (value: boolean) => {
    setProactive(value);
    await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { proactive: value } });
  };
  if (!widgetKey) return null;

  const snippet = `<script src="${window.location.origin}/widget.js" data-key="${widgetKey}" defer></script>`;
  return (
    <>
      <SettingsCard
        title="Install the chat widget"
        description={<>Paste this into your site's <code>&lt;head&gt;</code>, before your own scripts (so page actions your code registers find it ready). The loader is tiny; the chat itself loads only when a visitor opens it. Colours, wording and the rest of its look are on the{" "}
          <a href="/appearance" onClick={(e) => { e.preventDefault(); navigate("/appearance", { replace: true }); }}>Look</a> tab.</>}
        action={<a data-slot="button" className={buttonVariants({ variant: "outline", size: "sm" })} href={`/demo.html?key=${widgetKey}`} target="_blank" rel="noreferrer">Open demo page</a>}
      >
        <div className="invite">
          <div className="row">
            <code>{snippet}</code>
            <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(snippet); setCopied(true); }}>{copied ? "Copied ✓" : "Copy"}</Button>
          </div>
        </div>
        <p className="muted">
          Cookie banner? Add <code>data-consent="required"</code>: the widget then stores nothing and doesn't show the visitor on your live list until you call <code>JunDesk.consent(true)</code>.
        </p>
      </SettingsCard>

      <SettingsCard title="Allowed websites" description="Your widget key is public, so anyone could copy the snippet. List your sites and the widget won't open, track visitors or use AI anywhere else.">
        <SettingRow label="Websites" description={<>Use <code>*.acme.com</code> for subdomains. This desk ({window.location.host}) always works for testing.</>} wide>
          <div className="row">
            <Input value={domains} onChange={(e) => setDomains(e.target.value)} disabled={!canEdit} placeholder="Any website (e.g. acme.com, *.acme.com)" aria-label="Allowed websites" style={{ flex: 1 }} />
            {canEdit && <Button size="sm" disabled={busy || domains === savedDomains} onClick={saveDomains}>Save</Button>}
          </div>
        </SettingRow>
        {error && <p className="error">{error}</p>}
      </SettingsCard>

      <SettingsCard title="Proactive help" description="When the widget reaches out first: after something breaks, or after time on a page.">
        <SettingRow label="Offer help when something breaks" description={`On the page, e.g. "Looks like your payment didn't go through. Want a hand?"`}>
          <Switch checked={proactive} disabled={!canEdit} onCheckedChange={(value) => void toggleProactive(value)} aria-label="Offer help when something breaks on the page" />
        </SettingRow>
        {canEdit && <OpenersPanel workspaceId={workspaceId} proactive={proactive} initial={openers} />}
      </SettingsCard>
    </>
  );
}

/** V-03: the secret the customer's backend signs identity tokens with. */
export function IdentityPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/identity`;
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ secret: string | null }>(base).then((r) => setSecret(r.secret), () => setSecret(null));
  }, [base]);
  if (secret === undefined) return null;
  const example = `// On your server, for the signed-in user (any JWT library; HS256):
const userToken = jwt.sign(
  { sub: user.id, email: user.email, name: user.name, attributes: { plan: user.plan },
    // Optional: the user's own key for your API, for actions that act as them ({user.secrets.API_TOKEN}).
    secrets: { API_TOKEN: user.apiToken } },
  process.env.JUN_IDENTITY_SECRET,
  { algorithm: "HS256", expiresIn: "1h" },
);
// In the page: data-user-token="<userToken>" on the script tag, or
JunDesk.identify(userToken);   // and JunDesk.logout() when they sign out`;
  return (
    <SettingsCard
      title="Identify signed-in customers"
      description={<>Your backend signs a short-lived token saying who the user is. Agents then see a verified name, email and attributes, the AI can greet them and look up <em>their</em> account
        ({"{user.id}"} in tools), and their chats follow them across devices. Without a valid token, visitors stay anonymous.</>}
      action={!secret && <Button size="sm" disabled={busy} onClick={() => run(async () => { setSecret((await api<{ secret: string }>(base, { body: {} })).secret); setShown(true); })}>Create identity secret</Button>}
    >
      {secret && (
        <>
          <div className="invite">
            <div className="row">
              <code className="small">{shown ? secret : `${secret.slice(0, 8)}${"•".repeat(24)}`}</code>
              <Button variant="outline" size="sm" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</Button>
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
            </div>
          </div>
          <pre className="code small">{example}</pre>
          <div className="row">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (confirm("Rotate the secret? Tokens signed with the old one stop working right away.")) run(async () => setSecret((await api<{ secret: string }>(base, { body: {} })).secret)); }}>Rotate secret</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (confirm("Turn off identity verification? Everyone becomes anonymous.")) run(async () => { await api(base, { method: "DELETE" }); setSecret(null); }); }}>Turn off</Button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </SettingsCard>
  );
}
