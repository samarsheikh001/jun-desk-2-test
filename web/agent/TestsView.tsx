import { useState } from "react";
import { editYaml, freshName, readYaml, type Edit } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardContent, CardHeader } from "@/components/ui/card.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { PlusIcon, TrashIcon } from "../components/icons.tsx";
import { PixelLoader } from "../components/PixelLoader.tsx";
import { CodeEditor, EVAL, Field, FilePicker, Problems, TOOL, Unreadable, WIDGET, humanize, setCodeView, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent/tests: the cases of every evals/*.yaml in one list, each a form (what the customer says,
// what a good reply does), and "Run tests" that grades the unsaved draft like `jun eval` does.

const NEW_FILE = "evals/tests.yaml";

const OUTCOMES = [
  { value: "", label: "Anything" },
  { value: "answer", label: "Answers" },
  { value: "handoff", label: "Hands over to a person" },
  { value: "escalate", label: "Flags a problem for the team" },
  { value: "action", label: "Offers an action on the page" },
];

type Data = Record<string, unknown>;
const isRecord = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

interface Result {
  pass: boolean;
  failures: string[];
  reply: string;
}

export function TestsView({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [tally, setTally] = useState<{ passed: number; failed: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const code = useCodeView();

  const files = Object.keys(cfg.draft).filter((p) => EVAL.test(p)).sort();
  const tools = Object.keys(cfg.draft).map((p) => TOOL.exec(p)?.[1]).filter((t): t is string => Boolean(t));
  const widgets = Object.keys(cfg.draft).map((p) => WIDGET.exec(p)?.[1]).filter((w): w is string => Boolean(w));
  const cases = files.flatMap((file) => {
    const data = readYaml(cfg.draft[file]!);
    return Array.isArray(data) ? data.map((c, index) => ({ file, index, data: isRecord(c) ? c : {} })) : [];
  });
  const unreadable = files.filter((f) => !Array.isArray(readYaml(cfg.draft[f]!)));

  const add = () => {
    const file = files.find((f) => Array.isArray(readYaml(cfg.draft[f]!))) ?? NEW_FILE;
    const name = freshName("New test", cases.map((c) => String(c.data.name ?? "")), " ");
    const value = { name, message: "", expect: { outcome: "answer" } };
    cfg.setFile(file, file in cfg.draft ? editYaml(cfg.draft[file]!, { op: "push", path: [], value }) : editYaml("[]\n", { op: "push", path: [], value }));
  };

  const run = async () => {
    setRunning(true);
    setRunError(null);
    setResults({});
    setTally(null);
    try {
      const response = await fetch(`/api${cfg.base}/eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ files: cfg.draft, cases: true, replay: false, sample: 0 }),
      });
      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? `Couldn't run the tests (${response.status}).`);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; file?: string; name?: string; pass?: boolean; failures?: string[]; result?: { reply: string }; message?: string; cases?: { passed: number; failed: number } };
          if (event.type === "case") setResults((r) => ({ ...r, [`${event.file}#${event.name}`]: { pass: Boolean(event.pass), failures: event.failures ?? [], reply: event.result?.reply ?? "" } }));
          if (event.type === "error") setRunError(event.message ?? "A test couldn't run.");
          if (event.type === "done" && event.cases) setTally(event.cases);
        }
      }
    } catch (error) {
      setRunError((error as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="agent-form agent-tests">
      <div className="agent-item-head">
        <p className="muted small agent-tests-intro">
          Write what a customer might say and what a good reply does. Run them after a change, before you save, to check the AI still gets these right. Your unsaved changes are what's tested.
        </p>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={add}>
            <PlusIcon /> New test
          </Button>
        )}
        <Button size="sm" disabled={running || cases.length === 0 || cfg.issues.length > 0} onClick={run} title={cfg.issues.length ? "Fix the problems first" : undefined}>
          {running ? "Running…" : "Run tests"}
        </Button>
      </div>
      {running && <p className="small"><PixelLoader label="Running tests" /></p>}
      {tally && (
        <p className="row agent-tally">
          <Badge variant="secondary" className="agent-pass">{tally.passed} passed</Badge>
          {tally.failed > 0 && <Badge variant="destructive">{tally.failed} failed</Badge>}
        </p>
      )}
      {runError && <p className="error small">{runError}</p>}
      {code ? (
        <TestsCode cfg={cfg} canEdit={canEdit} files={files} picked={picked} onPick={setPicked} results={results} />
      ) : (
        <>
          {unreadable.map((f) => <Unreadable key={f} />)}
          {files.flatMap((f) => cfg.issuesFor(f)).length > 0 && <Problems issues={files.flatMap((f) => cfg.issuesFor(f))} />}
          {cases.length === 0 && <p className="muted agent-blank">No tests yet. Add one for each question you never want the AI to get wrong.</p>}
          {cases.map((c) => (
            <TestCase
              key={`${c.file}#${c.index}`}
              data={c.data}
              result={results[`${c.file}#${String(c.data.name ?? `case ${c.index + 1}`)}`]}
              tools={tools}
              widgets={widgets}
              canEdit={canEdit}
              edit={(...edits) => cfg.setFile(c.file, editYaml(cfg.draft[c.file]!, ...edits.map((e) => (e.op === "set" ? { ...e, path: [c.index, ...e.path] } : e))))}
              remove={() => {
                const next = editYaml(cfg.draft[c.file]!, { op: "remove", path: [], index: c.index });
                cfg.setFile(c.file, Array.isArray(readYaml(next)) && (readYaml(next) as unknown[]).length === 0 ? undefined : next);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** Code: the test files as text (a picker when there are several), and the last run's results by name. */
function TestsCode({ cfg, canEdit, files, picked, onPick, results }: {
  cfg: AgentConfig;
  canEdit: boolean;
  files: string[];
  picked: string | null;
  onPick: (path: string) => void;
  results: Record<string, Result>;
}) {
  if (!files.length) return <p className="muted agent-blank">No tests yet. New test starts a file.</p>;
  const path = picked && files.includes(picked) ? picked : files[0]!;
  const ran = Object.entries(results).filter(([key]) => key.startsWith(`${path}#`));
  return (
    <>
      {files.length > 1 && <FilePicker files={files} value={path} onChange={onPick} />}
      <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
      {ran.length > 0 && (
        <ul className="agent-run-list small">
          {ran.map(([key, r]) => (
            <li key={key}>
              <Badge variant={r.pass ? "secondary" : "destructive"} className={r.pass ? "agent-pass" : undefined}>{r.pass ? "Passed" : "Failed"}</Badge>{" "}
              {key.slice(path.length + 1)}
              {r.failures.map((f, i) => <div key={i} className="error">{f}</div>)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TestCase({ data, result, tools, widgets, canEdit, edit, remove }: {
  data: Data;
  result: Result | undefined;
  tools: string[];
  widgets: string[];
  canEdit: boolean;
  edit: (...edits: Edit[]) => void;
  remove: () => void;
}) {
  const expect = isRecord(data.expect) ? data.expect : {};
  const messages = typeof data.message === "string" ? [data.message] : Array.isArray(data.messages) ? data.messages.map(String) : [""];
  const setMessages = (next: string[]) =>
    next.length <= 1
      ? edit({ op: "set", path: ["messages"], value: "" }, { op: "set", path: ["message"], value: next[0] ?? "", keep: true })
      : edit({ op: "set", path: ["message"], value: "" }, { op: "set", path: ["messages"], value: next });
  const expectTools = Array.isArray(expect.tools) ? expect.tools.map(String) : [];
  const codeOnly = ["actions", "intent", "page"].filter((k) => data[k] !== undefined);

  return (
    <Card className={`agent-test${result ? (result.pass ? " pass" : " fail") : ""}`}>
      <CardHeader className="agent-test-head">
        <Input className="agent-test-name" aria-label="Test name" value={String(data.name ?? "")} readOnly={!canEdit} onChange={(e) => edit({ op: "set", path: ["name"], value: e.target.value })} />
        {result && <Badge variant={result.pass ? "secondary" : "destructive"} className={result.pass ? "agent-pass" : undefined}>{result.pass ? "Passed" : "Failed"}</Badge>}
        {canEdit && (
          <Button variant="ghost" size="icon-sm" aria-label="Remove test" onClick={remove}>
            <TrashIcon />
          </Button>
        )}
      </CardHeader>
      <CardContent className="agent-test-body">
        {messages.map((m, i) => (
          <Field key={i} label={i === 0 ? "The customer says" : "Then says"}>
            <div className="agent-textlist-row">
              <Textarea rows={2} aria-label={i === 0 ? "The customer says" : "Then says"} value={m} readOnly={!canEdit} placeholder="e.g. How do I export my data?" onChange={(e) => setMessages(messages.map((x, j) => (j === i ? e.target.value : x)))} />
              {canEdit && i > 0 && (
                <Button variant="ghost" size="icon-sm" aria-label="Remove message" onClick={() => setMessages(messages.filter((_, j) => j !== i))}>
                  <TrashIcon />
                </Button>
              )}
            </div>
          </Field>
        ))}
        {canEdit && (
          <Button variant="ghost" size="sm" className="agent-textlist-add" onClick={() => setMessages([...messages, ""])}>
            <PlusIcon /> Add a follow-up message
          </Button>
        )}
        <div className="agent-test-grid">
          <Field label="The AI should">
            <NativeSelect aria-label="The AI should" value={String(expect.outcome ?? "")} disabled={!canEdit} onChange={(e) => edit({ op: "set", path: ["expect", "outcome"], value: e.target.value })}>
              {OUTCOMES.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          {widgets.length > 0 && (
            <Field label="And show this widget">
              <NativeSelect aria-label="And show this widget" value={String(expect.widget ?? "")} disabled={!canEdit} onChange={(e) => edit({ op: "set", path: ["expect", "widget"], value: e.target.value })}>
                <NativeSelectOption value="">No widget needed</NativeSelectOption>
                {widgets.map((w) => <NativeSelectOption key={w} value={w}>{humanize(w)}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
          )}
        </div>
        <Field label="A good reply…" hint="Checked by a second AI, so write it plainly.">
          <Textarea rows={2} aria-label="A good reply" value={String(expect.criteria ?? "")} readOnly={!canEdit} placeholder="e.g. Explains Settings → Export and says it's emailed as a CSV." onChange={(e) => edit({ op: "set", path: ["expect", "criteria"], value: e.target.value })} />
        </Field>
        {tools.length > 0 && (
          <Field label="Uses these actions">
            <div className="agent-checks">
              {tools.map((t) => (
                <label key={t} className="small">
                  <Checkbox
                    checked={expectTools.includes(t)}
                    disabled={!canEdit}
                    onCheckedChange={(on) => edit({ op: "set", path: ["expect", "tools"], value: on ? [...expectTools, t] : expectTools.filter((x) => x !== t) })}
                  />
                  {humanize(t)}
                </label>
              ))}
            </div>
          </Field>
        )}
        {codeOnly.length > 0 && (
          <p className="muted small">
            Also set in <button type="button" className="link-button" onClick={() => setCodeView(true)}>Code</button>: {codeOnly.join(", ")}.
          </p>
        )}
        {result && (
          <div className="agent-test-result small">
            <div className="muted">The AI replied:</div>
            <p>{result.reply || "(no reply)"}</p>
            {result.failures.map((f, i) => <div key={i} className="error">{f}</div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
