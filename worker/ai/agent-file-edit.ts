import type { ActionBrief } from "../../shared/action-brief.ts";
import { agentFileEditInput, agentFileEditPrompt, agentFileKind, type AgentFileContext } from "../../shared/agent-file-ai.ts";
import { agentLinks } from "../../shared/agent-links.ts";
import type { WidgetEditTurn } from "../../shared/widget-ai.ts";
import { TASK_EDIT_PROMPT, taskEditInput } from "../../shared/task-ai.ts";
import { parseConfig, type AgentConfig, type ConfigFiles } from "./config.ts";

// W-24: an action or a procedure edited by chat on the Agent page, like a widget (W-22,
// widget-edit.ts). One request = one answer from the model, which rewrites the file (prompts in
// shared/agent-file-ai.ts). D-62: the answer streams to the browser (edit-stream.ts), which checks
// the whole draft with the new file like a save (POST …/agent/validate) and asks once more with the
// problems if it doesn't pass. Nothing is saved: the file goes to the admin's draft.

export const AGENT_FILE_EDIT_MAX_TOKENS = 4000;

export class AgentFileEditError extends Error {}

/** W-27: each action as the AI editors see it: what it does, its inputs, what it changes and shows. */
export function actionBriefs(config: Pick<AgentConfig, "tools" | "widgets">): ActionBrief[] {
  // W-29: the AI's own tool for cards it fills in itself, when any card allows it.
  const fillable = config.widgets.filter((w) => w.aiFill).map((w) => w.name);
  const showWidget: ActionBrief[] = fillable.length
    ? [{ name: "show_widget", description: `Shows the customer a card the AI fills in itself from what it knows (never account data it doesn't have). Cards: ${fillable.join(", ")}.`, method: "GET", customer: false, inputs: [{ name: "widget", type: "string", required: true, enum: fillable }, { name: "data", type: "string", required: true, description: "The card's data" }] }]
    : [];
  return config.tools.map((t): ActionBrief => ({
    name: t.name,
    description: t.description,
    method: t.method,
    inputs: Object.entries(t.input).map(([name, i]) => ({ name, type: i.type, required: i.required, ...(i.enum ? { enum: i.enum } : {}), ...(i.description ? { description: i.description } : {}) })),
    customer: JSON.stringify([t.url, t.headers, t.query, t.body ?? null]).includes("{user."),
    ...(t.widget ? { widget: t.widget } : {}),
  })).concat(showWidget);
}

/** What else the desk has, so the model can name actions, procedures and widgets correctly. */
function contextOf(files: ConfigFiles, path: string, target: { kind: string; name: string }): AgentFileContext {
  const { config } = parseConfig(files);
  const context: AgentFileContext = {
    actions: actionBriefs(config).filter((a) => !(target.kind === "action" && a.name === target.name)),
    procedures: config.skills.filter((s) => `skills/${s.name}/SKILL.md` !== path).map((s) => ({ name: s.name, description: s.description })),
    widgets: config.widgets.map((w) => w.name),
  };
  if (target.kind === "action") {
    const links = agentLinks(files);
    context.usedBy = [
      ...(links.actionUsedBy[target.name] ?? []).map((p) => `procedure ${p}`),
      ...(links.actionRunFrom[target.name] ?? []).map((w) => `a button in widget ${w}`),
    ];
  }
  return context;
}

/** The model's prompt and input for one action or procedure edit (and the last try's problems). */
export function agentFileEditMessages(input: { path: string; files: ConfigFiles; message: string; history: WidgetEditTurn[]; error?: { file: string; problems: string[] } }): { system: string; user: string } {
  const target = agentFileKind(input.path);
  if (!target) throw new AgentFileEditError("Only actions and procedures can be edited here.");
  const text = input.files[input.path];
  if (text === undefined) throw new AgentFileEditError("That file isn't in the draft.");
  const context = contextOf(input.files, input.path, target);
  return {
    system: agentFileEditPrompt(target.kind),
    user: agentFileEditInput({ ...target, path: input.path, text, context, history: input.history, message: input.message, ...(input.error ? { error: input.error } : {}) }),
  };
}

/** AI-27: a task's answer may write several files (its procedure and actions), so it gets more room. */
export const TASK_EDIT_MAX_TOKENS = 8000;

/**
 * AI-27: the prompt and input for one change to a task: its procedure plus the actions its steps use
 * (and any the request names with @), which the model may change, and new actions it may create.
 */
export function taskEditMessages(input: { path: string; files: ConfigFiles; message: string; history: WidgetEditTurn[]; error?: { file: string; problems: string[] } }): { system: string; user: string } {
  const target = agentFileKind(input.path);
  if (target?.kind !== "procedure") throw new AgentFileEditError("A task's chat edits its procedure (skills/<name>/SKILL.md).");
  const text = input.files[input.path];
  if (text === undefined) throw new AgentFileEditError("That file isn't in the draft.");
  const links = agentLinks(input.files);
  const named = [...input.message.matchAll(/@([a-z][a-z0-9_]*)/g)].map((m) => m[1]!);
  const actions: Record<string, string> = {};
  for (const name of new Set([...(links.procedureUses[target.name] ?? []), ...named])) {
    const path = `tools/${name}.yaml`;
    if (input.files[path] !== undefined) actions[path] = input.files[path]!;
  }
  return {
    system: TASK_EDIT_PROMPT,
    user: taskEditInput({ name: target.name, path: input.path, text, actions, context: contextOf(input.files, input.path, target), history: input.history, message: input.message, ...(input.error ? { error: input.error } : {}) }),
  };
}
