// AI-27: a task's AI chat. A task is a procedure (skills/<name>/SKILL.md: when it applies, the steps)
// with the actions its steps use (tools/<name>.yaml). One request may change the procedure, change
// those actions and create new ones, so the admin sets up the whole job in one place. The answer
// carries one <file path="…"> per file it writes; the browser checks them all together like a save
// (shared/edit-finish.ts) before they reach the draft. Pure.

import { ACTION_FORMAT, ACTION_RULES, PROCEDURE_FORMAT, type AgentFileContext } from "./agent-file-ai.ts";
import { describeActions } from "./action-brief.ts";
import type { WidgetEditTurn } from "./widget-ai.ts";

/** An action file a task's answer may write. */
export const TASK_ACTION_FILE = /^tools\/([a-z][a-z0-9_]*)\.yaml$/;
/** AI-30: a new card's name, as in widgets/<name>.widget (lowercase, a letter first). */
const CARD_NAME = /^[a-z][a-z0-9_-]{0,59}$/;

export const TASK_EDIT_PROMPT = `You set up a task for a customer support desk's AI agent. A task is one job the AI does for customers, like a refund or a plan change: a procedure (when it applies, and the steps) plus the actions its steps use. The admin asks for one change at a time. You may change the procedure, change the actions it uses, and create new actions.

${PROCEDURE_FORMAT}

${ACTION_FORMAT}

Rules:
- Make exactly the change asked for and keep everything else as it is, word for word: comments, the order of keys, and the other steps with their numbering and sub-points (renumber only when you add or remove a step).
- Write for the people who run support: plain words, short sentences.
- Whenever a step can be done with one of the desk's actions (listed with their inputs), name it in that step as @name instead of describing what to do by hand.
- Before a step that uses an action, make sure the AI has the action's required inputs: add a step to ask the customer for the ones they may not have given yet, in plain words. Never ask for what an action already knows about the signed-in customer.
- Before an action that changes something (POST), the AI must tell the customer what will happen and wait for a clear yes. A lookup (GET) needs no yes.
- An action that shows a widget already shows its result to the customer: don't repeat that result in the steps.
- If a step needs an action the desk doesn't have, create it: write its file as tools/<snake_case_name>.yaml and name it in the step as @snake_case_name. Never invent API addresses, keys or response fields the business didn't give: use a clear placeholder address (https://api.example.com/…) and say in the reply that it needs the real one.
${ACTION_RULES}
- Other tasks may use the same actions: change an existing action only when the request needs it.
- Widgets (AI-30): when the customer should see something as a widget, a card in the chat (an order's details, a list, a choice to make with buttons), the action that shows it names the widget with widget: <snake_case_name>: one of the desk's widgets if one fits, else a new one. For a new widget, don't write its file: add a <card name="snake_case_name"> block describing it in plain words: what it shows (which fields of the action's result, with an example of that data) and each button and what it runs: one of the desk's actions as tool:<name> (its fields named after that action's inputs), an action on the customer's website as page:<name>, a link as open_url. The desk builds the widget from your description. A widget that only shows something, with nothing to call, is an action with no url and widget: <name>.
- Write only the files you change or create. If the request can't be done, write no file and say why in the reply.

Answer in exactly this shape, nothing before or after:
<reply>One or two short sentences for the admin: what you changed.</reply>
<file path="skills/NAME/SKILL.md">
the whole new file
</file>
<file path="tools/NAME.yaml">
the whole new file
</file>
<card name="NAME">what the new card shows and what its buttons do (only for a new card)</card>
(one <file> block per file you change or create, one <card> block per new card)`;

/** The user message: the task's files, what else the desk has, the chat so far, the request, a failed try. */
export function taskEditInput(input: {
  name: string;
  path: string;
  text: string;
  /** The actions this task uses (or the request names), as files the model may change. */
  actions: Record<string, string>;
  context: AgentFileContext;
  history: WidgetEditTurn[];
  message: string;
  error?: { file: string; problems: string[] };
}): string {
  const list = (items: { name: string; description: string }[]) => items.map((i) => `- ${i.name}: ${i.description || "(no description)"}`).join("\n") || "(none)";
  const own = Object.entries(input.actions);
  const parts = [
    `Task: ${input.name}. Its procedure file:\n<file path="${input.path}">\n${input.text}\n</file>`,
    own.length ? `Actions this task uses (you may change them):\n${own.map(([p, t]) => `<file path="${p}">\n${t}\n</file>`).join("\n")}` : "Actions this task uses: none yet.",
    `All the desk's actions:\n${describeActions(input.context.actions)}`,
    `The desk's other tasks:\n${list(input.context.procedures)}`,
    `The desk's widgets: ${input.context.widgets.join(", ") || "(none)"}`,
  ];
  const history = input.history.slice(-12);
  if (history.length) parts.push(`Earlier in this chat:\n${history.map((t) => `${t.role === "user" ? "Admin" : "You"}: ${t.text}`).join("\n")}`);
  parts.push(`The admin asks: ${input.message}`);
  if (input.error) {
    parts.push(`Your last answer didn't pass the checks. Its files were:\n${input.error.file}\nProblems:\n${input.error.problems.map((p) => `- ${p}`).join("\n")}\nFix them and answer again in the same shape.`);
  }
  return parts.join("\n\n");
}

/**
 * The model's answer: its reply and the files it wrote, only the task's own procedure and action
 * files (anything else is dropped and named in `ignored`). Null when it has no reply and no file.
 */
export function parseTaskEdit(text: string, procedurePath: string): { reply: string; files: Record<string, string>; cards: { name: string; brief: string }[]; ignored: string[] } | null {
  const body = text.replace(/^\s*```[a-z]*\n?|```\s*$/g, "");
  const files: Record<string, string> = {};
  const ignored: string[] = [];
  for (const m of body.matchAll(/<file path="([^"]+)">\n?([\s\S]*?)\n?<\/file>/g)) {
    const path = m[1]!.trim();
    const clean = m[2]!.replace(/^```[a-z]*\n|\n```$/g, "");
    if (path !== procedurePath && !TASK_ACTION_FILE.test(path)) {
      ignored.push(path);
      continue;
    }
    if (clean.trim()) files[path] = clean.endsWith("\n") ? clean : `${clean}\n`;
  }
  // AI-30: new cards, described; the desk's widget editor builds them.
  const cards: { name: string; brief: string }[] = [];
  for (const m of body.matchAll(/<card name="([^"]+)">([\s\S]*?)<\/card>/g)) {
    const name = m[1]!.trim();
    const brief = m[2]!.trim();
    if (CARD_NAME.test(name) && brief && !cards.some((c) => c.name === name)) cards.push({ name, brief: brief.slice(0, 1500) });
  }
  const replyMatch = /<reply>([\s\S]*?)<\/reply>/.exec(body)?.[1];
  if (replyMatch === undefined && !Object.keys(files).length && !cards.length) return null;
  const reply = (replyMatch ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || "Done.";
  return { reply, files, cards, ignored };
}

/** A failed try's files, as the retry shows them to the model. */
export function taskFilesText(files: Record<string, string>): string {
  return Object.entries(files).map(([p, t]) => `<file path="${p}">\n${t}</file>`).join("\n") || "(no files)";
}
