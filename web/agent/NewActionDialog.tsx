import { useEffect, useMemo, useState } from "react";
import { stringify } from "yaml";
import { describeError } from "../api.ts";
import { looksLikeCurl, parseCurl, type CurlRequest } from "../../shared/curl.ts";
import { actionName } from "../../shared/action-try.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field as UiField, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { askOnOpen } from "./AiChat.tsx";
import { actionExamples } from "./TryAction.tsx";
import type { ActionKeys } from "./ActionKeys.tsx";
import { go, slug } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// AI-26: "New action", the one way in for people who don't write YAML. They say what the AI should be
// able to do, and paste how their system does it (a curl command from their API docs, or a few words)
// if they have it. A curl command is read here, without the AI (shared/curl.ts): the request goes in
// the new action and any key in it is kept on the desk (never in the file). Then the action's page
// opens and its AI chat gets what it should do as its first request: it writes the description, the status
// line and the details the AI asks the customer for, while they watch. Try it is next, with the
// command's own values already filled in.

const MAX_WHAT = 300;
const MAX_HOW = 1500;
const RESERVED = ["handoff", "flag_problem", "jun_done", "activate_skill", "show_widget"];

/** The new action's file from a curl command (the AI fills in the description and status). */
export function actionFile(req: CurlRequest): string {
  return stringify({
    description: "",
    status: "Working on it",
    method: req.method,
    url: req.url,
    ...(Object.keys(req.query).length ? { query: req.query } : {}),
    ...(Object.keys(req.headers).length ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
}

/** The action AI's first request. */
function firstAsk(what: string, how: string, curl: CurlRequest | null): string {
  if (curl) {
    return `New action: "${what}". I filled in the request from a curl command in our API docs. Write the description (when the AI should use this and what it returns or changes) and the short line the customer sees while it runs. Turn the values in the request that change for each customer (like an ID, an email or an order number in the address, the query or the body) into details the AI asks for, as {placeholders} with a plain description each. Keep everything else in the request as it is.`;
  }
  if (how) {
    return `New action: "${what}". How our system does it:\n${how}\n\nSet up the request from this (method, address, query, headers, body), with {placeholders} for the details the AI asks the customer for, plus the description and the short line the customer sees while it runs. Keys go in headers as {secrets.NAME}, never their values.`;
  }
  return `New action: "${what}". Write the description (when the AI should use this and what it returns or changes), the short line the customer sees while it runs, and the details the AI needs to ask the customer for. I don't have the API address yet: keep a clear placeholder address.`;
}

/** A pasted curl command, read (null when the text isn't one). */
export function useCurl(how: string): { req: CurlRequest } | { error: string } | null {
  return useMemo(() => {
    if (!looksLikeCurl(how)) return null;
    try {
      return { req: parseCurl(how) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [how]);
}

/**
 * Puts a curl command's action in the draft at `path`: its keys kept on the desk first (a key already
 * there keeps its value), and the command's values remembered for Try it.
 */
export async function addCurlAction(cfg: AgentConfig, keys: ActionKeys, path: string, req: CurlRequest): Promise<void> {
  for (const key of req.keys) {
    if (key.value && !keys.keys?.some((k) => k.name === key.name)) await keys.save(key.name, key.value);
  }
  cfg.setFile(path, actionFile(req));
  actionExamples.set(path, { url: req.url, query: req.query, ...(req.body !== undefined ? { body: req.body } : {}) });
}

/** What the desk read from a pasted curl command: the request, its keys, what it changed. */
export function CurlRead({ req }: { req: CurlRequest }) {
  return (
    <div className="agent-new-action-read" aria-live="polite">
      <p><span className="agent-new-action-method">{req.method}</span> <code>{req.url}</code></p>
      {req.keys.map((k) => (
        <p key={k.name} className="small">
          {k.value ? <>Key <code>{k.name}</code>: kept on the desk, never in the action's file.</> : <>Key <code>{k.name}</code>: add it on the action's page.</>}
        </p>
      ))}
      {req.notes.map((n) => <p key={n} className="small muted">{n}</p>)}
    </div>
  );
}

export function NewActionDialog({ open, onClose, cfg, keys, names, initial }: {
  open: boolean;
  onClose: () => void;
  cfg: AgentConfig;
  keys: ActionKeys;
  names: Set<string>;
  /** AI-27: "Create it" for an action a task's steps name: its name and the step that needs it. */
  initial?: { name: string; what: string };
}) {
  const [what, setWhat] = useState("");
  const [how, setHow] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setWhat(initial?.what ?? "");
    setHow("");
    setName(initial?.name ?? "");
    setNamed(Boolean(initial?.name));
    setError(null);
  }, [open]);

  const curl = useCurl(how);
  const req = curl && "req" in curl ? curl.req : null;
  const fileName = slug(named ? name : actionName(what), "_");
  const nameProblem = !what.trim() && !named ? null : !fileName ? "Start with a letter." : RESERVED.includes(fileName) ? "That name is taken by the AI's own actions." : names.has(fileName) ? "There's already an action with this name." : null;
  const ready = what.trim().length > 0 && !nameProblem && !(curl && "error" in curl) && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const path = `tools/${fileName}.yaml`;
      if (req) await addCurlAction(cfg, keys, path, req);
      else cfg.setFile(path, `description: ""\nstatus: Working on it\nmethod: GET\nurl: https://\n`);
      askOnOpen(path, firstAsk(what.trim(), req ? "" : how.trim(), req));
      onClose();
      go(`/agent/actions/${fileName}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="agent-new-action-dialog">
        <form className="agent-dialog-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <DialogHeader>
            <DialogTitle>New action</DialogTitle>
            <DialogDescription>Something the AI can do for your customers in your systems, like looking up an order or changing a plan. The AI sets it up; you try it before anything goes live.</DialogDescription>
          </DialogHeader>
          <UiField>
            <FieldLabel htmlFor="action-what">What should the AI be able to do?</FieldLabel>
            <Textarea id="action-what" autoFocus rows={2} maxLength={MAX_WHAT} value={what} placeholder="e.g. Look up an order by its number and tell the customer where it is" onChange={(e) => setWhat(e.target.value)} />
          </UiField>
          <UiField data-invalid={curl && "error" in curl ? true : undefined}>
            <FieldLabel htmlFor="action-how">How does your system do it? <span className="muted">(optional)</span></FieldLabel>
            <Textarea
              id="action-how"
              className="mono agent-new-action-how"
              rows={4}
              maxLength={MAX_HOW}
              value={how}
              spellCheck={false}
              placeholder={'Paste a curl command from your API docs:\ncurl https://api.acme.com/orders/1042 \\\n  -H "Authorization: Bearer sk_live_…"\n\nOr describe the request. No API yet? Leave it empty.'}
              onChange={(e) => setHow(e.target.value)}
            />
            {curl && "error" in curl ? (
              <FieldError>{curl.error}</FieldError>
            ) : req ? (
              <CurlRead req={req} />
            ) : (
              <FieldDescription>A curl command is read right here; anything else goes to the AI as notes.</FieldDescription>
            )}
          </UiField>
          <UiField data-invalid={nameProblem ? true : undefined}>
            <FieldLabel htmlFor="action-name">Name</FieldLabel>
            <Input id="action-name" className="mono" value={named ? name : fileName} maxLength={60} placeholder="look_up_order" spellCheck={false} onChange={(e) => { setNamed(true); setName(e.target.value); }} />
            {nameProblem ? <FieldError>{nameProblem}</FieldError> : <FieldDescription>Nothing changes for customers until you save.</FieldDescription>}
          </UiField>
          {error && <p className="error small" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ready}>{busy ? "Setting up…" : "Set it up"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
