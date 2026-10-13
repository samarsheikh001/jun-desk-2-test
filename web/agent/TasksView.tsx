import { useEffect, useMemo, useState, type ReactNode } from "react";
import { stringify } from "yaml";
import { agentLinks, widgetPageButtons } from "../../shared/agent-links.ts";
import { cardControls, previewWidget } from "../../shared/widgets.ts";
import type { SeenPageAction } from "../../shared/actions.ts";
import { taskName } from "../../shared/action-try.ts";
import { curlActionName } from "../../shared/curl.ts";
import { describeError } from "../api.ts";
import { editFrontmatter, readFrontmatter, readYaml, setBody } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field as UiField, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { PlusIcon } from "../components/icons.tsx";
import { Advanced, Field, ItemIndex, Problems, SKILL, TextList, TOOL, Unreadable, go, humanize, slug } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";
import { MentionText, useMentionActions } from "./MentionText.tsx";
import { FileStudio } from "./FileStudio.tsx";
import { askOnOpen } from "./AiChat.tsx";
import { setupProblems, useActionKeys, type ActionKeys } from "./ActionKeys.tsx";
import { addCurlAction, CurlRead, NewActionDialog, useCurl } from "./NewActionDialog.tsx";
import { TryAction } from "./TryAction.tsx";
import { useSeenPageActions } from "./WebsiteActions.tsx";

// /agent/tasks[/<name>] (AI-27, D-67): a task is one job the AI does for customers, like a refund or a
// plan change. It's a procedure, skills/<name>/SKILL.md (when it applies, the steps, and folded away
// how the customer's app can open a chat with it, AI-20), shown with what its steps use: each action
// with whether it's set up, what it shows and Try it, and Create it for a name that isn't one yet.
// Its AI chat edits the steps and those actions together (shared/task-ai.ts). The word "procedure"
// stays in the files and the docs only. Old /agent/procedures links forward here (AgentPage.tsx).

export function TasksView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const [adding, setAdding] = useState(false);
  const keys = useActionKeys(cfg);
  const items = Object.keys(cfg.draft)
    .map((path) => ({ path, name: SKILL.exec(path)?.[1] }))
    .filter((x): x is { path: string; name: string } => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ path, name }) => ({ id: name, path, label: humanize(name), sub: (readFrontmatter(cfg.draft[path]!).data?.description as string | undefined) ?? "" }));
  const current = selected === null ? null : (items.find((i) => i.id === selected) ?? null);
  // A task that's gone (removed, discarded, another version): back to the list.
  const gone = selected !== null && current === null && cfg.state !== null;
  useEffect(() => {
    if (gone) go("/agent/tasks");
  }, [gone]);

  if (current) {
    return (
      <FileStudio
        key={current.path}
        cfg={cfg}
        canEdit={canEdit}
        path={current.path}
        title={current.label}
        kind="procedure"
        back={{ path: "/agent/tasks", label: "All tasks" }}
        form={<TaskForm cfg={cfg} canEdit={canEdit} path={current.path} name={current.id} keys={keys} />}
      />
    );
  }
  return (
    <>
      <ItemIndex
        cfg={cfg}
        items={items}
        base="/agent/tasks"
        onAdd={() => setAdding(true)}
        addLabel="New task"
        canEdit={canEdit}
        noun="tasks"
        empty={{ title: "Teach the AI a job", text: "A task is one thing the AI does for customers from start to finish, like a refund or a plan change: when it applies, the steps, and the actions it uses." }}
      />
      <NewTaskDialog open={adding} onClose={() => setAdding(false)} cfg={cfg} keys={keys} taken={new Set(items.map((i) => i.id))} />
    </>
  );
}

function TaskForm({ cfg, canEdit, path, name, keys }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string; keys: ActionKeys }) {
  const text = cfg.draft[path] ?? "";
  const { data, body } = readFrontmatter(text);
  const set = (next: string) => cfg.setFile(path, next);
  const field = (key: string, value: unknown) => set(editFrontmatter(text, { op: "set", path: [key], value }));
  const actions = useMentionActions(cfg);
  const str = (key: string) => (typeof data?.[key] === "string" ? (data[key] as string) : "");
  const replies = Array.isArray(data?.replies) ? (data.replies as unknown[]).map(String) : [];
  const intent = str("intent");

  return (
    <div className="agent-form">
      {data === null ? (
        <Unreadable />
      ) : (
        <Field label="When should the AI do this?" hint="The AI reads this to pick the right task." htmlFor="proc-when">
          <Textarea id="proc-when" rows={2} value={str("description")} readOnly={!canEdit} placeholder="e.g. The customer asks to change their plan." onChange={(e) => field("description", e.target.value)} />
        </Field>
      )}
      <Field label="Steps" hint="What the AI does, in order. Say what it may offer, and when it should hand over to a person. Type @ to name an action." htmlFor="proc-steps">
        <MentionText id="proc-steps" className="mention-boxed" value={body} readOnly={!canEdit} onChange={(next) => set(setBody(text, next))} actions={actions} />
      </Field>
      <TaskUses cfg={cfg} canEdit={canEdit} name={name} body={body} keys={keys} />
      {data !== null && (
        <Advanced title="Start it from a button in your app" defaultOpen={Boolean(intent)}>
          <p className="muted small">
            For example a Cancel button that opens the chat on this task. Your developer calls{" "}
            <code>JunDesk.open({`{ intent: "${intent || name}" }`})</code> with the name below.
          </p>
          <Field label="Name your app uses" htmlFor="proc-intent">
            <Input id="proc-intent" value={intent} readOnly={!canEdit} placeholder={name} maxLength={40} onChange={(e) => field("intent", e.target.value.toLowerCase())} />
          </Field>
          {intent && (
            <>
              <Field label="First message" hint="Shown before the customer types anything." htmlFor="proc-opening">
                <Input id="proc-opening" value={str("opening")} readOnly={!canEdit} maxLength={300} placeholder="e.g. Sorry to see you go. What's the main reason?" onChange={(e) => field("opening", e.target.value)} />
              </Field>
              <Field label="Quick replies" hint="Buttons under the first message.">
                <TextList values={replies} onChange={(next) => field("replies", next)} placeholder="e.g. Too expensive" label="Quick reply" addLabel="Add a reply" disabled={!canEdit} max={8} />
              </Field>
              <Field label="Leave button" hint="Always on screen, so the customer can finish without talking to the AI." htmlFor="proc-exit">
                <Input id="proc-exit" value={str("exit")} readOnly={!canEdit} maxLength={40} placeholder="e.g. Cancel anyway" onChange={(e) => field("exit", e.target.value)} />
              </Field>
            </>
          )}
        </Advanced>
      )}
      <Problems issues={cfg.issuesFor(path)} />
    </div>
  );
}

type Data = Record<string, unknown>;
const isRecord = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

/** The step that names `action`, without its number: what a new action for it should do. */
function stepFor(body: string, action: string): string {
  const line = body.split("\n").find((l) => l.includes(action)) ?? "";
  return line.replace(/^\s*(\d+[.)]|[-*])\s*/, "").replace(new RegExp(`(\\s+(with|using|via|use|call|run)(\\s+the)?)?\\s*\`?@?${action}\`?`, "g"), "").replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
}

/** A link to a page on the desk. */
function Go({ to, children }: { to: string; children: ReactNode }) {
  return <a href={to} onClick={(e) => { e.preventDefault(); go(to); }}>{children}</a>;
}

/**
 * AI-28: a card a task shows, and what each of its buttons does: runs an action of the desk's (linked;
 * whether it's set up), runs an action on the customer's website (`page:`; whether the desk has seen
 * their site offer it), goes to the website's own code (`handler: "client"`; the desk can't check
 * it), opens a link, or tells the AI what was picked.
 */
function CardUse({ cfg, widget, keys, seen }: { cfg: AgentConfig; widget: string; keys: ActionKeys; seen: SeenPageAction[] | null }) {
  const text = cfg.draft[`widgets/${widget}.widget`];
  const controls = useMemo(() => {
    if (text === undefined) return null;
    try {
      return cardControls(previewWidget(widget, text)).filter((c) => c.does.kind !== "dismiss");
    } catch {
      // No example data to draw it with: its website buttons, from the template.
      return widgetPageButtons(text).map((name) => ({ label: "A button", does: { kind: "page" as const, name } }));
    }
  }, [text, widget]);
  if (text === undefined) {
    return <p className="agent-use-problem small">Shows <code>{widget}</code>, but there's no widget with that name.</p>;
  }
  return (
    <div className="agent-use-card">
      <p className="agent-use-card-name">Widget: <Go to={`/agent/widgets/${widget}`}>{humanize(widget)}</Go></p>
      {controls && controls.length > 0 ? (
        <ul className="agent-use-buttons">
          {controls.map((c, i) => {
            const d = c.does;
            let what: ReactNode;
            let state: { ok: boolean; text: string } | null = null;
            if (d.kind === "tool") {
              const actionText = cfg.draft[`tools/${d.name}.yaml`] ?? cfg.draft[`tools/${d.name}.yml`];
              what = <>runs your action <Go to={`/agent/actions/${d.name}`}>{humanize(d.name)}</Go></>;
              state = actionText === undefined ? { ok: false, text: "No such action" } : setupProblems(actionText, keys).length ? { ok: false, text: "Not set up" } : { ok: true, text: "Ready" };
            } else if (d.kind === "page") {
              what = <>runs <code>{d.name}</code> on your website</>;
              if (seen) state = seen.some((a) => a.name === d.name) ? { ok: true, text: "Seen on your site" } : { ok: false, text: "Your site hasn't offered it yet" };
            } else if (d.kind === "client") {
              what = <>is handled by your website's own code (the desk can't check it)</>;
            } else if (d.kind === "link") {
              what = <>opens a link</>;
            } else {
              what = <>tells the AI what was picked</>;
            }
            return (
              <li key={i}>
                <span>
                  <strong>{c.label}</strong> {what}
                </span>
                {state && <span className="agent-use-state" data-ready={state.ok || undefined}>{state.text}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small">It has no buttons.</p>
      )}
    </div>
  );
}

/**
 * AI-27: what a task's steps use: its actions (set up? what they show? Try it), website actions, and
 * names that aren't actions yet. AI-28: cards too: the card an action shows, the cards the AI fills in
 * itself (@show_widget), each with what its buttons do; a card named in the steps as if it were an
 * action says how the AI can show it.
 */
function TaskUses({ cfg, canEdit, name, body, keys }: { cfg: AgentConfig; canEdit: boolean; name: string; body: string; keys: ActionKeys }) {
  const links = useMemo(() => agentLinks(cfg.draft), [cfg.draft]);
  const seen = useSeenPageActions(cfg);
  const [trying, setTrying] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; what: string } | null>(null);
  const uses = links.procedureUses[name] ?? [];
  const missing = links.procedureMissing[name] ?? [];
  // W-31: a name the customer's website registers is a website action, not a missing one.
  const site = missing.map((m) => seen?.find((a) => a.name === m)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  // AI-28: a card's name written like an action (@theme_picker) isn't something the AI can run.
  const namedCards = missing.filter((m) => links.widgets.includes(m) && !site.some((a) => a.name === m));
  const absent = missing.filter((m) => !site.some((a) => a.name === m) && !namedCards.includes(m));
  const actionNames = new Set(links.actions);
  // W-29: the AI's own show_widget fills in the cards that allow it.
  const fillsCards = /(^|[^\w])show_widget\b/.test(body);
  const fillable = links.widgets.filter((w) => /"aiFill"\s*:\s*true/.test(cfg.draft[`widgets/${w}.widget`] ?? ""));

  return (
    <Field label="What it uses" hint="The actions and widgets its steps use. Each action has to be set up before the AI can use it; try it to see what it returns.">
      <div className="agent-uses">
        {uses.map((action) => {
          const path = cfg.draft[`tools/${action}.yaml`] !== undefined ? `tools/${action}.yaml` : `tools/${action}.yml`;
          const text = cfg.draft[path] ?? "";
          const data = readYaml(text);
          const method = isRecord(data) && typeof data.method === "string" ? data.method.toUpperCase() : "GET";
          const widget = isRecord(data) && typeof data.widget === "string" && data.widget ? data.widget : null;
          // W-28: no address: nothing is called, it only shows its card.
          const cardOnly = isRecord(data) && !(typeof data.url === "string" && data.url.trim()) && Boolean(widget);
          const problems = setupProblems(text, keys);
          const open = trying === action;
          return (
            <div key={action} className="agent-use">
              <div className="agent-use-head">
                <span className="agent-use-name"><Go to={`/agent/actions/${action}`}>{humanize(action)}</Go></span>
                <span className="agent-use-kind">{cardOnly ? "Shows a widget (calls nothing)" : method === "POST" ? "Makes a change" : "Looks up"}</span>
                {!cardOnly && !widget && <span className="agent-use-shows">Answers in words</span>}
                <span className="agent-use-state" data-ready={problems.length ? undefined : true}>{problems.length ? "Not set up" : "Ready"}</span>
                <Button size="sm" variant="ghost" className="agent-use-try" aria-expanded={open} onClick={() => setTrying(open ? null : action)}>{open ? "Close" : "Try it"}</Button>
              </div>
              {problems.length > 0 && <p className="agent-use-problem small">{problems[0]} <Go to={`/agent/actions/${action}`}>Set it up</Go></p>}
              {widget && <CardUse cfg={cfg} widget={widget} keys={keys} seen={seen} />}
              {open && <TryAction cfg={cfg} canEdit={canEdit} path={path} name={action} compact />}
            </div>
          );
        })}
        {fillsCards && (
          <div className="agent-use">
            <div className="agent-use-head">
              <span className="agent-use-name">Widgets the AI fills in</span>
              <span className="agent-use-kind">Shows a widget (calls nothing)</span>
              <span className="agent-use-state" data-ready={fillable.length ? true : undefined}>{fillable.length ? "Ready" : "No widget allows it"}</span>
            </div>
            {fillable.length ? (
              fillable.map((w) => <CardUse key={w} cfg={cfg} widget={w} keys={keys} seen={seen} />)
            ) : (
              <p className="agent-use-problem small">The steps use show_widget, but no widget has "The AI can fill this widget itself" switched on. Turn it on in a widget's Details on the <Go to="/agent/widgets">Widgets</Go> page.</p>
            )}
          </div>
        )}
        {namedCards.map((w) => (
          <div key={w} className="agent-use">
            <div className="agent-use-head">
              <span className="agent-use-name">{humanize(w)}</span>
              <span className="agent-use-kind">A widget</span>
              <span className="agent-use-state">Can't be shown like this</span>
            </div>
            <p className="agent-use-problem small">
              The steps name this widget like an action, but the AI shows a widget through an action that shows it, or by filling it in itself: switch on "The AI can fill this widget itself" in the widget's Details and write @show_widget in the step.
            </p>
            <CardUse cfg={cfg} widget={w} keys={keys} seen={seen} />
          </div>
        ))}
        {site.map((a) => (
          <div key={a.name} className="agent-use">
            <div className="agent-use-head">
              <span className="agent-use-name">{humanize(a.name)}</span>
              <span className="agent-use-kind">On your website</span>
              <span className="agent-use-shows">{a.description}</span>
            </div>
          </div>
        ))}
        {absent.map((m) => (
          <div key={m} className="agent-use agent-use-missing">
            <span>
              The steps use <code>{m}</code>, which isn't an action yet. The AI can't do that step until it exists.
            </span>
            {canEdit && /^[a-z][a-z0-9_]*$/.test(m) && (
              <Button type="button" variant="outline" size="sm" onClick={() => setCreating({ name: m, what: stepFor(body, m) })}>
                <PlusIcon /> Create it
              </Button>
            )}
          </div>
        ))}
        {!uses.length && !site.length && !absent.length && !namedCards.length && !fillsCards && (
          <p className="muted small">Its steps don't use an action or a widget yet. Type @ in a step to pick one, or ask the AI to "add the action this needs".</p>
        )}
      </div>
      <NewActionDialog open={creating !== null} onClose={() => setCreating(null)} cfg={cfg} keys={keys} names={actionNames} {...(creating ? { initial: creating } : {})} />
    </Field>
  );
}

const MAX_WHEN = 300;
const MAX_WHAT = 600;
const MAX_HOW = 1500;

/** The task AI's first request. */
function firstAsk(when: string, what: string, how: string, action: string | null): string {
  const parts = [`Set up this new task. When it applies: "${when}". What the AI should do: "${what}".`];
  if (action) {
    parts.push(`I created the action @${action} from a curl command in our API docs; its request still has example values. Fill in its description and the short line the customer sees while it runs, and turn the values that change for each customer (like an ID, an email or an order number) into details the AI asks for, as {placeholders} with a plain description each. Keep the rest of its request as it is.`);
  } else if (how) {
    parts.push(`How our system does it:\n${how.slice(0, 800)}`);
  }
  parts.push("Write the steps as a short numbered list in plain words, using the desk's actions where they fit. If a step needs an action the desk doesn't have, create it.");
  return parts.join("\n\n");
}

/** AI-27: "New task": when, what, and (optionally) how the business's system does it; the AI writes the rest. */
function NewTaskDialog({ open, onClose, cfg, keys, taken }: { open: boolean; onClose: () => void; cfg: AgentConfig; keys: ActionKeys; taken: Set<string> }) {
  const [when, setWhen] = useState("");
  const [what, setWhat] = useState("");
  const [how, setHow] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setWhen("");
    setWhat("");
    setHow("");
    setName("");
    setNamed(false);
    setError(null);
  }, [open]);
  const curl = useCurl(how);
  const req = curl && "req" in curl ? curl.req : null;
  const folder = slug(named ? name : taskName(when), "-");
  const nameProblem = !when.trim() && !named ? null : !folder ? "Use letters or numbers." : taken.has(folder) ? "There's already a task with this name." : null;
  const ready = when.trim().length > 0 && what.trim().length > 0 && !nameProblem && !(curl && "error" in curl) && !busy;

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      let action: string | null = null;
      if (req) {
        const base = curlActionName(req) || "new_action";
        action = base;
        for (let n = 2; Object.keys(cfg.draft).some((p) => TOOL.exec(p)?.[1] === action); n++) action = `${base}_${n}`;
        await addCurlAction(cfg, keys, `tools/${action}.yaml`, req);
      }
      const path = `skills/${folder}/SKILL.md`;
      // The admin's own words are the first steps; the AI rewrites them.
      cfg.setFile(path, `---\n${stringify({ name: folder, description: when.trim() })}---\n${what.trim()}\n`);
      askOnOpen(path, firstAsk(when.trim(), what.trim(), req ? "" : how.trim(), action));
      onClose();
      go(`/agent/tasks/${folder}`);
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
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>One job the AI does for customers, like a refund or a plan change. The AI writes the steps and sets up what they need; you try it before anything goes live.</DialogDescription>
          </DialogHeader>
          <UiField>
            <FieldLabel htmlFor="task-when">When should the AI do this?</FieldLabel>
            <Textarea id="task-when" autoFocus rows={2} maxLength={MAX_WHEN} value={when} placeholder="e.g. The customer asks where their order is" onChange={(e) => setWhen(e.target.value)} />
          </UiField>
          <UiField>
            <FieldLabel htmlFor="task-what">What should it do?</FieldLabel>
            <Textarea id="task-what" rows={3} maxLength={MAX_WHAT} value={what} placeholder="e.g. Ask for the order number, look it up, and tell them the status and the delivery date. If it's late, offer to pass it to the team." onChange={(e) => setWhat(e.target.value)} />
          </UiField>
          <UiField data-invalid={curl && "error" in curl ? true : undefined}>
            <FieldLabel htmlFor="task-how">How does your system do it? <span className="muted">(optional)</span></FieldLabel>
            <Textarea
              id="task-how"
              className="mono agent-new-action-how"
              rows={3}
              maxLength={MAX_HOW}
              value={how}
              spellCheck={false}
              placeholder={"Paste a curl command from your API docs, or describe the request.\nNo API, or not sure? Leave it empty."}
              onChange={(e) => setHow(e.target.value)}
            />
            {curl && "error" in curl ? <FieldError>{curl.error}</FieldError> : req ? <CurlRead req={req} /> : <FieldDescription>A curl command becomes the task's action, with any key in it kept on the desk.</FieldDescription>}
          </UiField>
          <UiField data-invalid={nameProblem ? true : undefined}>
            <FieldLabel htmlFor="task-name">Name</FieldLabel>
            <Input id="task-name" className="mono" value={named ? name : folder} maxLength={60} placeholder="order-status" spellCheck={false} onChange={(e) => { setNamed(true); setName(e.target.value); }} />
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
