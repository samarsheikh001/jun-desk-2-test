import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { SettingsCard } from "./layout.tsx";

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

type SecretSource = "worker" | "settings" | null;

/** Non-secret status from GET /workspaces/:id/trackers: whether a credential is set and where, never its value. */
export interface TrackerStatus {
  github: { repo: string | null; tokenSet: boolean; tokenSource: SecretSource; tokenHint: string | null; configured: boolean; apiUrl?: string };
  linear: { team: LinearTeam | null; keySet: boolean; keySource: SecretSource; keyHint: string | null; configured: boolean; apiUrl?: string };
}

interface TestResult {
  ok: boolean;
  reason: string;
  message: string;
  teams?: LinearTeam[];
}

/** S-08: where "Create issue" files issues (GitHub, Linear, or both). */
export function IssueTrackersPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    api<TrackerStatus>(`/workspaces/${workspaceId}/trackers`).then(setStatus, () => {});
  }, [workspaceId]);
  // Linked from the inbox's "Create issue" hint.
  useEffect(() => {
    if (status && window.location.hash === "#issue-trackers") ref.current?.scrollIntoView({ block: "start" });
  }, [status]);
  if (!status) return null;

  return (
    <>
      <SettingsCard
        title="Issue trackers"
        id="issue-trackers"
        ref={ref}
        description={<>
          Agents can turn a conversation into a GitHub or Linear issue: the AI drafts the title, steps to reproduce, failing requests and browser details, the agent edits
          it and files it, and the conversation keeps the link. The AI never files issues on its own. Issue text is masked again (emails, tokens, card numbers) before it's
          sent. Tokens you paste here are kept in the workspace's Durable Object storage (not the database) and never shown again.
          {!canEdit && " An owner or admin can change these."}
        </>}
      />
      <GitHubSection workspaceId={workspaceId} status={status} canEdit={canEdit} onChange={setStatus} />
      <LinearSection workspaceId={workspaceId} status={status} canEdit={canEdit} onChange={setStatus} />
    </>
  );
}

function SecretState({ name, set, source, hint }: { name: string; set: boolean; source: SecretSource; hint: string | null }) {
  if (!set) return <span className="error">not set</span>;
  if (source === "worker") return <span className="ok-text">✓ from the Worker secret <code>{name}</code></span>;
  return <span className="ok-text">✓ saved{hint ? <> (<code>•••• {hint}</code>)</> : null}</span>;
}

/**
 * Paste a token or key; it's saved write-only (PUT path { [field]: value }) and never shown
 * again. A Worker secret overrides it, so then there's nothing to edit here.
 */
function CredentialField({ label, placeholder, path, field, source, onSaved }: {
  label: string;
  placeholder: string;
  path: string;
  field: string;
  source: SecretSource;
  onSaved: (next: TrackerStatus) => void;
}) {
  const [value, setValue] = useState("");
  const { busy, error, run } = useAction();
  if (source === "worker") return null;
  const put = (v: string | null) =>
    run(async () => {
      const next = await api<TrackerStatus>(path, { method: "PUT", body: { [field]: v } });
      setValue("");
      onSaved(next);
    });
  return (
    <div className="field">
      <span className="small strong">{label}</span>
      <div className="row tracker-row">
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={source ? "Paste a new one to replace it" : placeholder} aria-label={label} autoComplete="off" spellCheck={false} />
        <Button size="sm" disabled={busy || !value.trim()} onClick={() => put(value)}>Save</Button>
        {source === "settings" && <Button variant="outline" size="sm" disabled={busy} onClick={() => put(null)}>Remove</Button>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

type SectionProps = { workspaceId: string; status: TrackerStatus; canEdit: boolean; onChange: (s: TrackerStatus) => void };

function GitHubSection({ workspaceId, status, canEdit, onChange }: SectionProps) {
  const base = `/workspaces/${workspaceId}/github`;
  const { github } = status;
  const [repo, setRepo] = useState(github.repo ?? "");
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAction();
  const save = () =>
    run(async () => {
      setTest(null);
      const next = await api<TrackerStatus>(base, { method: "PUT", body: { repo: repo.trim() || null } });
      onChange(next);
      setRepo(next.github.repo ?? "");
    });

  return (
    <SettingsCard
      className="trackers-panel"
      id="github"
      title="GitHub"
      description="Issues go to one repository."
      action={<span className={`tag ${github.configured ? "" : "tag-warn"}`}>{github.configured ? "Connected" : "Not set up"}</span>}
    >
      <div className="tracker">
      <dl className="env small">
        <dt>Token</dt>
        <dd><SecretState name="GITHUB_TOKEN" set={github.tokenSet} source={github.tokenSource} hint={github.tokenHint} /></dd>
        <dt>Repository</dt>
        <dd>{github.repo ? <code>{github.repo}</code> : <span className="muted">not set</span>}</dd>
        {github.apiUrl && (<><dt>API</dt><dd><code>{github.apiUrl}</code></dd></>)}
      </dl>
      {canEdit && (
        <>
          <CredentialField label="Token" placeholder="github_pat_…" path={`${base}/token`} field="token" source={github.tokenSource} onSaved={(next) => {
            onChange(next);
            // Check it straight away, when there's a repository to check against.
            if (next.github.repo) run(async () => setTest(await api<TestResult>(`${base}/test`, { body: {} })));
          }} />
          <div className="field">
            <span className="small strong">Repository</span>
            <div className="row tracker-row">
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name, e.g. acme/web-app" aria-label="GitHub repository" spellCheck={false} />
              <Button size="sm" disabled={busy || repo.trim() === (github.repo ?? "")} onClick={save}>Save</Button>
              <Button variant="outline" size="sm" disabled={busy || !github.repo} onClick={() => run(async () => setTest(await api<TestResult>(`${base}/test`, { body: {} })))}>Test connection</Button>
            </div>
          </div>
          {test && <p className={`small ${test.ok ? "ok-text" : "error"}`} role="status">{test.ok ? "✓ " : ""}{test.message}</p>}
          {error && <p className="error small">{error}</p>}
          <details className="small tracker-help" open={!github.configured}>
            <summary>How to connect GitHub</summary>
            <ol>
              <li>
                On GitHub, create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained personal access token</a>: Repository access → <em>Only select repositories</em> → this repository; Permissions → <em>Issues: Read and write</em>.
              </li>
              <li>Paste it in Token above and save. (Or set it as the Worker secret <code>GITHUB_TOKEN</code>, which takes priority.)</li>
              <li>Save the repository, then Test connection.</li>
            </ol>
          </details>
        </>
      )}
      </div>
    </SettingsCard>
  );
}

function LinearSection({ workspaceId, status, canEdit, onChange }: SectionProps) {
  const base = `/workspaces/${workspaceId}/linear`;
  const { linear } = status;
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAction();
  const testConnection = () =>
    run(async () => {
      const result = await api<TestResult>(`${base}/test`, { body: {} });
      setTest(result);
      setTeams(result.teams ?? []);
    });
  const choose = (id: string) =>
    run(async () => {
      const team = id ? teams.find((t) => t.id === id) ?? null : null;
      onChange(await api<TrackerStatus>(base, { method: "PUT", body: { team } }));
    });
  // The saved team stays selectable before the list is loaded.
  const options = linear.team && !teams.some((t) => t.id === linear.team!.id) ? [linear.team, ...teams] : teams;

  return (
    <SettingsCard
      className="trackers-panel"
      id="linear"
      title="Linear"
      description="Issues go to one team."
      action={<span className={`tag ${linear.configured ? "" : "tag-warn"}`}>{linear.configured ? "Connected" : "Not set up"}</span>}
    >
      <div className="tracker">
      <dl className="env small">
        <dt>API key</dt>
        <dd><SecretState name="LINEAR_API_KEY" set={linear.keySet} source={linear.keySource} hint={linear.keyHint} /></dd>
        <dt>Team</dt>
        <dd>{linear.team ? <>{linear.team.name} <code>{linear.team.key}</code></> : <span className="muted">not set</span>}</dd>
        {linear.apiUrl && (<><dt>API</dt><dd><code>{linear.apiUrl}</code></dd></>)}
      </dl>
      {canEdit && (
        <>
          <CredentialField label="API key" placeholder="lin_api_…" path={`${base}/key`} field="apiKey" source={linear.keySource} onSaved={(next) => {
            onChange(next);
            // Loads the teams for the picker.
            if (next.linear.keySet) testConnection();
          }} />
          <div className="field">
            <span className="small strong">Team</span>
            <div className="row tracker-row">
              <NativeSelect value={linear.team?.id ?? ""} disabled={busy || options.length === 0} onChange={(e) => choose(e.target.value)} aria-label="Linear team">
                <NativeSelectOption value="">{options.length ? "No team (Linear off)" : "Test connection to load teams"}</NativeSelectOption>
                {options.map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>{t.name} ({t.key})</NativeSelectOption>
                ))}
              </NativeSelect>
              <Button variant="outline" size="sm" disabled={busy || !linear.keySet} onClick={testConnection}>Test connection</Button>
            </div>
          </div>
          {test && <p className={`small ${test.ok ? "ok-text" : "error"}`} role="status">{test.ok ? "✓ " : ""}{test.message}</p>}
          {error && <p className="error small">{error}</p>}
          <details className="small tracker-help" open={!linear.configured}>
            <summary>How to connect Linear</summary>
            <ol>
              <li>In Linear, go to Settings → Security &amp; access → Personal API keys and create a key (one that can create issues in the team you want).</li>
              <li>Paste it in API key above and save. (Or set it as the Worker secret <code>LINEAR_API_KEY</code>, which takes priority.)</li>
              <li>Pick the team new issues go to.</li>
            </ol>
          </details>
        </>
      )}
      </div>
    </SettingsCard>
  );
}
