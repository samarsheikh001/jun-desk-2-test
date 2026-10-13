// W-24: edit an action (tools/<name>.yaml) or a procedure (skills/<name>/SKILL.md) by chatting, as
// widgets are edited (W-22). The admin asks for a change in plain words; the model rewrites the whole
// file; the result must pass the agent's config checker (worker/ai/config.ts) before it reaches the
// unsaved draft. Pure: which files can be edited, the prompts, the request, parsing the answer.

import { describeActions, type ActionBrief } from "./action-brief.ts";
import type { WidgetEditTurn } from "./widget-ai.ts";

export type AgentFileKind = "action" | "procedure";

const ACTION_FILE = /^tools\/([a-z][a-z0-9_]*)\.ya?ml$/;
const PROCEDURE_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;

/** What kind of file the chat edits, and its name; null for files it doesn't edit. */
export function agentFileKind(path: string): { kind: AgentFileKind; name: string } | null {
  const action = ACTION_FILE.exec(path)?.[1];
  if (action) return { kind: "action", name: action };
  const procedure = PROCEDURE_FILE.exec(path)?.[1];
  if (procedure) return { kind: "procedure", name: procedure };
  return null;
}

export const ACTION_FORMAT = `An action is a YAML file: one HTTP request to the business's own API that the support AI may call.

Keys (no others are allowed):
- description (required): what it does and returns, and when the AI should use it. The AI reads only this to decide.
- status: what the customer sees while it runs, one short line of plain text without {placeholders}, like "Checking your order" (at most 60 characters).
- method: GET (default) or POST.
- url: https://… The path and query may use {placeholders}. Required, unless the action only shows a widget: then leave url out and nothing is called (the widget shows with its example data and the inputs the AI fills in).
- headers, query: maps of text. Keys go only in headers, never in the url or query: the business's own as {secrets.NAME} (UPPER_SNAKE_CASE; an admin pastes it on the action's page, or a developer sets the Worker secret JUN_SECRET_NAME), or, to act as the signed-in customer with their own key, {user.secrets.NAME} (from the secrets claim of their identity token). Never ask anyone to paste a key into a file.
- input: the details the AI asks the customer for, each { type: string | number | integer | boolean, description, required (default true), enum: [allowed values] }. Every {name} placeholder must be an input, {user.id} / {user.email} / {user.name} / {user.<attribute>} (the signed-in customer, verified by the website; never asked for), or {secrets.NAME}.
- body: with POST only, a map sent as JSON; values may be "{placeholders}".
- pick: a list of top-level response fields the AI sees (less noise).
- mock: a canned response used by tests instead of calling the API.
- pages: a list of page paths like "/orders/*" where it's offered (none means everywhere).
- widget: the name of a widget (widgets/<name>.widget) that shows a successful result to the customer.
- widget_done, widget_failed: only when a widget's button runs this action (not when the AI calls it). One short line each for the customer, a Jinja template over the fields they entered and, for widget_done, the JSON result, like "Thanks {{ name }}, we'll call you today." widget_done: the card folds to it, and the AI doesn't answer the press (unless the action also shows a widget). widget_failed: the card stays open with it so they can try again.

Example:
description: Look up an order by its number. Returns status, order date and total.
status: Checking your order
method: GET
url: https://api.example.com/orders/{orderNumber}
headers:
  Authorization: Bearer {secrets.ACME_API_KEY}
input:
  orderNumber:
    type: string
    description: The order number, like A-1042
pick: [status, orderedOn, total]
mock: { status: delivered, orderedOn: "2026-09-02", total: "$49.00" }

An action that changes something (a refund, a plan change) should say in its description that the AI must only call it after the customer clearly says yes.`;

export const PROCEDURE_FORMAT = `A procedure is a SKILL.md file: the steps the support AI follows in one situation.

It starts with YAML frontmatter between --- lines:
- name (required): exactly the folder's name.
- description (required, at most 1024 characters): when this procedure applies, in the customer's terms. The AI reads only this to decide when to follow it.
- Optional, only for a chat the business's app opens on purpose (JunDesk.open({ intent })): intent (a short lowercase name like cancel), opening (one line the chat opens with), replies (a list of short answers to that opening), exit (a short button label like "Cancel anyway"). Don't add these unless asked.
Below the frontmatter: the steps, as a numbered list in plain words. Refer to an action as @ and its exact name (like @lookup_order), say when to ask the customer, when to wait for a clear yes, and when to hand over to a person.

Example:
---
name: refund
description: The customer asks for a refund, their money back, or to cancel a charge.
---
1. Ask for the order or invoice number if they haven't given it.
2. Check the order with @lookup_order.
3. Explain that refunds are reviewed by the billing team within one business day.
4. Hand off to a person with the order number in the reason.`;

const PROCEDURE_RULES = `- Whenever a step can be done with one of the desk's actions (listed with their inputs), use it: name it as @name in that step instead of describing what to do by hand.
- Before a step that uses an action, make sure the AI has the action's required inputs: add a step to ask the customer for the ones they may not have given yet, in plain words ("ask for their order number"). Never ask for what an action already knows about the signed-in customer. Where an input has a fixed list of values, use one of them exactly.
- Before an action that changes something (POST), the AI must tell the customer what will happen and wait for a clear yes. A lookup (GET) needs no yes: the AI just uses it.
- An action that shows a widget already shows its result to the customer: don't repeat that result in the steps.
- Use only the actions listed. If a step needs an action the desk doesn't have, still write it as @a_snake_case_name and say in the reply that this action needs to be created.`;

export const ACTION_RULES = `- Keep the input names that procedures and widgets already use (listed under "This action is used by"): renaming one breaks them. If the change needs a rename, say so in the reply.
- A widget's button fills inputs from the card's fields of the same name: keep input names and field names in step.`;

/** The system prompt for one kind of file. */
export function agentFileEditPrompt(kind: AgentFileKind): string {
  const what = kind === "action" ? "an action" : "a procedure";
  return `You edit ${what} for a customer support desk's AI agent. The admin asks for one change at a time.

${kind === "action" ? ACTION_FORMAT : PROCEDURE_FORMAT}

Rules:
- Make exactly the change asked for and keep everything else as it is, word for word: comments, the order of keys, and the other steps with their numbering and sub-points (renumber only when you add or remove a step).
- Write for the people who run support: plain words, short sentences. Never invent API addresses, secrets or fields the business didn't give: if the change needs one, keep a clear placeholder (like https://api.example.com/…) and say so in the reply.
- Use the desk's other actions, procedures and widgets by their exact names when they're relevant (an action in a procedure's steps as @name).
${kind === "procedure" ? PROCEDURE_RULES : ACTION_RULES}
- If the request isn't about this ${kind} or can't be done in this format, leave the file unchanged and say why in the reply.

Answer in exactly this shape, nothing before or after:
<reply>One or two short sentences for the admin: what you changed.</reply>
<file>
the whole new file
</file>`;
}

export interface AgentFileContext {
  /** W-27: every action with its inputs (not the one being edited). */
  actions: ActionBrief[];
  procedures: { name: string; description: string }[];
  widgets: string[];
  /** W-27: for an action, what uses it ("procedure cancellation", "widget seat_quote (Add seats)"). */
  usedBy?: string[];
}

/** The user message: the file, what else the desk has, the chat so far, the request, a failed attempt's problems. */
export function agentFileEditInput(input: {
  kind: AgentFileKind;
  name: string;
  path: string;
  text: string;
  context: AgentFileContext;
  history: WidgetEditTurn[];
  message: string;
  error?: { file: string; problems: string[] };
}): string {
  const list = (items: { name: string; description: string }[]) => items.map((i) => `- ${i.name}: ${i.description || "(no description)"}`).join("\n") || "(none)";
  const parts = [
    `${input.kind === "action" ? "Action" : "Procedure"}: ${input.name} (file ${input.path})`,
    `Current file:\n<file>\n${input.text}\n</file>`,
    `The desk's actions:\n${describeActions(input.context.actions)}`,
    `The desk's procedures:\n${list(input.context.procedures)}`,
    `The desk's widgets: ${input.context.widgets.join(", ") || "(none)"}`,
  ];
  if (input.kind === "action") parts.push(`This action is used by: ${input.context.usedBy?.length ? input.context.usedBy.join("; ") : "nothing yet"}`);
  const history = input.history.slice(-12);
  if (history.length) parts.push(`Earlier in this chat:\n${history.map((t) => `${t.role === "user" ? "Admin" : "You"}: ${t.text}`).join("\n")}`);
  parts.push(`The admin asks: ${input.message}`);
  if (input.error) {
    parts.push(`Your last answer didn't pass the checks. Its file was:\n<file>\n${input.error.file}\n</file>\nProblems:\n${input.error.problems.map((p) => `- ${p}`).join("\n")}\nFix them and answer again in the same shape.`);
  }
  return parts.join("\n\n");
}

/** The model's answer, or null when it has no file. */
export function parseAgentFileEdit(text: string): { reply: string; file: string } | null {
  const body = text.replace(/^\s*```[a-z]*\n?|```\s*$/g, "");
  const file = /<file>\n?([\s\S]*?)\n?<\/file>/.exec(body)?.[1];
  if (!file?.trim()) return null;
  const reply = (/<reply>([\s\S]*?)<\/reply>/.exec(body)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || "Done.";
  // A model sometimes fences the file inside the tag.
  const clean = file.replace(/^```[a-z]*\n|\n```$/g, "");
  return { reply, file: clean.endsWith("\n") ? clean : `${clean}\n` };
}
