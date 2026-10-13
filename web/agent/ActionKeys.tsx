import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { actionSetupProblems, secretRefs, userSecretRefs } from "../../shared/action-setup.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { readYaml } from "../lib/agentFiles.ts";
import type { AgentConfig } from "./useAgentConfig.ts";
import { Field } from "./parts.tsx";

// AI-24: the keys actions use. {secrets.NAME} is the business's own key: pasted here (kept in the
// workspace hub, never in the agent's files or D1) or set by a developer as the Worker secret
// JUN_SECRET_NAME (that one wins). {user.secrets.NAME} is the signed-in customer's own key, from the
// `secrets` claim of their identity token. An action that isn't set up yet is flagged here and on its
// card, and the AI doesn't get it (shared/action-setup.ts).

export interface ActionKey {
  name: string;
  source: "worker" | "desk";
  last4?: string;
}

export interface ActionKeys {
  keys: ActionKey[] | null;
  isSet: (name: string) => boolean;
  save: (name: string, value: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
}

/** The workspace's action keys, by name (never their values). */
export function useActionKeys(cfg: AgentConfig): ActionKeys {
  const base = `${cfg.base.replace(/\/agent$/, "")}/action-secrets`;
  const [keys, setKeys] = useState<ActionKey[] | null>(null);
  const load = useCallback(async () => setKeys((await api<{ secrets: ActionKey[] }>(base)).secrets), [base]);
  useEffect(() => {
    load().catch(() => setKeys([]));
  }, [load]);
  return {
    keys,
    // Until the list loads, nothing is flagged.
    isSet: (name) => keys === null || keys.some((k) => k.name === name),
    save: async (name, value) => {
      await api(`${base}/${name}`, { method: "PUT", body: { value } });
      await load();
    },
    remove: async (name) => {
      await api(`${base}/${name}`, { method: "DELETE" });
      await load();
    },
  };
}

type Data = Record<string, unknown>;
const isRecord = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

function fields(text: string): { description: string; url: string; headers: Record<string, string> } | null {
  const data = readYaml(text);
  if (!isRecord(data)) return null;
  const headers = isRecord(data.headers) ? Object.fromEntries(Object.entries(data.headers).map(([k, v]) => [k, String(v ?? "")])) : {};
  return { description: typeof data.description === "string" ? data.description : "", url: typeof data.url === "string" ? data.url : "", headers };
}

/** What keeps the action in this file from working; [] when it's ready (or the file doesn't parse). */
export function setupProblems(text: string, keys: ActionKeys): string[] {
  const f = fields(text);
  return f ? actionSetupProblems(f, keys.isSet) : [];
}

/** At the top of an action's form: why the AI won't use it yet. */
export function SetupNotice({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <div className="agent-setup-warn" role="note">
      <strong>The AI won't use this action yet.</strong>
      <ul>
        {problems.map((p) => <li key={p}>{p}</li>)}
      </ul>
    </div>
  );
}

/** The keys this action's headers use, each with where it comes from; the business's own can be pasted here. */
export function KeysField({ text, keys, canEdit }: { text: string; keys: ActionKeys; canEdit: boolean }) {
  const f = fields(text);
  if (!f) return null;
  const headerValues = Object.values(f.headers);
  const own = secretRefs(headerValues);
  const customers = userSecretRefs(headerValues);
  if (!own.length && !customers.length) return null;
  return (
    <Field label="Keys" hint="What its headers send to prove it's allowed. A key pasted here is saved right away, never in the agent's files, and only its last 4 characters are shown.">
      <div className="agent-keys">
        {own.map((name) => <KeyRow key={name} name={name} keys={keys} canEdit={canEdit} />)}
        {customers.map((name) => (
          <div key={`u:${name}`} className="agent-key">
            <code>{name}</code>
            <span className="agent-key-state">The customer's own, from their sign-in (the <code>secrets</code> claim of their identity token)</span>
          </div>
        ))}
      </div>
    </Field>
  );
}

function KeyRow({ name, keys, canEdit }: { name: string; keys: ActionKeys; canEdit: boolean }) {
  const found = keys.keys?.find((k) => k.name === name);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      setValue("");
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (keys.keys === null) return null;
  const asking = !found || (editing && found.source === "desk");
  return (
    <div className="agent-key">
      <code>{name}</code>
      {asking && canEdit ? (
        <form
          className="agent-key-paste"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void run(() => keys.save(name, value));
          }}
        >
          <Input type="password" aria-label={`Key ${name}`} value={value} autoComplete="off" spellCheck={false} placeholder="Paste the key" onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>Save</Button>
          {found && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          )}
        </form>
      ) : !found ? (
        <span className="agent-key-state missing">Not added yet. An owner or admin can paste it here.</span>
      ) : found.source === "worker" ? (
        <span className="agent-key-state">Set by your developer (Worker secret <code>JUN_SECRET_{name}</code>)</span>
      ) : (
        <>
          <span className="agent-key-state">Added · ends in {found.last4}</span>
          {canEdit && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>Replace</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => keys.remove(name))}>Remove</Button>
            </>
          )}
        </>
      )}
      {error && <span className="agent-key-error small">{error}</span>}
    </div>
  );
}
