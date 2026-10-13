import { useState } from "react";
import { MAX_DELAY_S, MAX_OPENER_HINT, MAX_OPENER_TEXT, MAX_OPENERS, MIN_DELAY_S, patternError, type OpenerRule } from "../../shared/openers.ts";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";

// P-01 page openers (owners/admins): "after 20 s on /pricing, offer a chat". Mounted once the
// inbox settings have loaded; `initial` only seeds the form.

interface Draft {
  id?: string;
  path: string;
  delay: string;
  ai: boolean;
  text: string;
  hint: string;
}

const toDraft = (r: OpenerRule): Draft => ({ id: r.id, path: r.path, delay: String(r.delay), ai: r.text === null, text: r.text ?? "", hint: r.hint ?? "" });
const toRule = (d: Draft) => ({ id: d.id, path: d.path.trim(), delay: Number(d.delay), text: d.ai ? null : d.text, hint: d.ai ? d.hint : undefined });

export function OpenersPanel({ workspaceId, proactive, initial }: { workspaceId: string; proactive: boolean; initial: OpenerRule[] }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => initial.map(toDraft));
  const [saved, setSaved] = useState(() => JSON.stringify(initial.map(toDraft)));
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();

  const change = (i: number, patch: Partial<Draft>) => setDrafts((list) => list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const save = () =>
    run(async () => {
      const r = await api<{ settings: { openers?: OpenerRule[] } }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { openers: drafts.map(toRule) } });
      const next = (r.settings.openers ?? []).map(toDraft);
      setDrafts(next);
      setSaved(JSON.stringify(next));
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  const dirty = JSON.stringify(drafts) !== saved;

  return (
    <div className="settings-group openers">
      <h3>Page openers</h3>
      <p className="muted small">
        Offer a chat after someone has spent a while on a page, e.g. 30 seconds on <code>/pricing</code>. Only time with the tab in view counts. A visitor sees at most one card per page
        load (an error nudge wins), never while the chat is open, and nothing before cookie consent. Paths: <code>/pricing</code> is that page, <code>/docs/*</code> is /docs and
        everything under it, <code>*/billing</code> any path ending in /billing, <code>*</code> every page. The first matching opener wins.
      </p>
      {!proactive && <p className="small openers-off">Turned off: openers show only when "Offer help" above is on.</p>}
      {drafts.length === 0 && <p className="muted small">No page openers yet.</p>}
      {drafts.map((d, i) => {
        const pathProblem = d.path.trim() ? patternError(d.path.trim()) : null;
        return (
          <div className="opener-rule" key={d.id ?? `new-${i}`}>
            <div className="row opener-when">
              <label className="field">
                <span className="small">Page</span>
                <Input value={d.path} onChange={(e) => change(i, { path: e.target.value })} placeholder="/pricing" aria-invalid={Boolean(pathProblem)} />
              </label>
              <label className="field opener-delay">
                <span className="small">After (seconds)</span>
                <Input type="number" min={MIN_DELAY_S} max={MAX_DELAY_S} value={d.delay} onChange={(e) => change(i, { delay: e.target.value })} />
              </label>
              <label className="field">
                <span className="small">Message</span>
                <NativeSelect value={d.ai ? "ai" : "text"} onChange={(e) => change(i, { ai: e.target.value === "ai" })}>
                  <NativeSelectOption value="text">Fixed text</NativeSelectOption>
                  <NativeSelectOption value="ai">Let the AI write it</NativeSelectOption>
                </NativeSelect>
              </label>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setDrafts((list) => list.filter((_, j) => j !== i))} aria-label={`Remove opener ${i + 1}`}>Remove</Button>
            </div>
            {pathProblem && <small className="error">{pathProblem}</small>}
            {d.ai ? (
              <Input value={d.hint} maxLength={MAX_OPENER_HINT} onChange={(e) => change(i, { hint: e.target.value })} placeholder="Optional: what to offer, e.g. help choosing between Team and Business" />
            ) : (
              <Input value={d.text} maxLength={MAX_OPENER_TEXT} onChange={(e) => change(i, { text: e.target.value })} placeholder="Comparing plans? Happy to help you pick one." />
            )}
            {d.ai && <small className="muted">The AI writes one friendly line from the page's title and your hint (the same line for everyone on that page; a generic line if the AI is off).</small>}
          </div>
        );
      })}
      <div className="row">
        <Button variant="outline" size="sm" disabled={busy || drafts.length>= MAX_OPENERS} onClick={() => setDrafts((list) => [...list, { path: "", delay: "30", ai: false, text: "", hint: "" }])}>
          Add opener
        </Button>
        <span className="spacer" />
        {done && <span className="muted small">Saved ✓</span>}
        <Button size="sm" disabled={busy || !dirty} onClick={save}>Save openers</Button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
