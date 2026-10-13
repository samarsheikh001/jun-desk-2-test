// D-62: what the Agent page's AI editors do with the model's whole answer, now that it streams to the
// browser (web/agent/editStream.ts): read it, apply it to the file and check the result, else say
// what failed so the model gets one more try (the server did this before). Pure.

import { agentLinks } from "./agent-links.ts";
import { parseAgentFileEdit } from "./agent-file-ai.ts";
import { parseTaskEdit } from "./task-ai.ts";
import { applyWidgetEdit, parseWidgetEdit } from "./widget-ai.ts";
import { checkExamples, MAX_WIDGET_JSON, parseWidgetFile, previewWidget, toolButtonInputs, type ToolButtonInputs } from "./widgets.ts";

export interface EditResult {
  reply: string;
  /** The whole new file (the one sent, when nothing changed). */
  file: string;
  changed: boolean;
  /** AI-27: other files the change writes (a task's actions), path → whole new file. */
  others?: Record<string, string>;
}

/** How many answers an edit gets: the first, and one more with what was wrong. */
export const EDIT_ATTEMPTS = 2;

/** The reply so far, while the answer streams: the text inside <reply>, without a half-written tag. */
export function liveReply(partial: string): string {
  const start = partial.indexOf("<reply>");
  if (start < 0) return "";
  const rest = partial.slice(start + "<reply>".length);
  const end = rest.indexOf("</reply>");
  return (end < 0 ? rest.replace(/<\/?[a-z]*$/i, "") : rest.slice(0, end)).replace(/\s+/g, " ").trimStart();
}

/** W-27: buttons whose action would run without a required input, said in the reply. */
function inputsNote(buttons: ToolButtonInputs[], reply: string): string {
  const gaps = buttons.filter((b) => b.missing.length);
  if (!gaps.length) return reply;
  const parts = gaps.map((b) => `"${b.label}" runs ${b.tool} without ${b.missing.map((m) => (m.like ? `${m.name} (the field ${m.like} isn't named ${m.name})` : m.name)).join(", ")}`);
  return `${reply} Note: ${parts.join("; ")}.`;
}

/**
 * W-22: a widget edit from the model's answer. The new file must parse, draw its example data and
 * (W-30) keep its example data and states fitting its parameters; `failed` goes back to the model.
 */
export function finishWidgetEdit(
  input: { name: string; file: string },
  answer: string,
  inputsOf?: (tool: string) => Record<string, { required: boolean }> | null,
): { result: EditResult } | { failed: { template: string; message: string } } {
  const current = JSON.parse(input.file) as Record<string, unknown>;
  const template = typeof current.template === "string" ? current.template : "";
  const summary = typeof current.summary === "string" ? current.summary : null;
  const schema = typeof current.jsonSchema === "object" && current.jsonSchema !== null && !Array.isArray(current.jsonSchema) && Object.keys(current.jsonSchema).length ? current.jsonSchema : undefined;
  let edit;
  try {
    edit = parseWidgetEdit(answer);
  } catch (error) {
    return { failed: { template: "(see your sample)", message: (error as Error).message } };
  }
  if (!edit) return { failed: { template: "(none)", message: "The answer had no <template>…</template>." } };
  const changed =
    edit.template.trim() !== template.trim() ||
    (edit.sample !== undefined && JSON.stringify(edit.sample) !== JSON.stringify(current.sample)) ||
    (edit.summary !== undefined && edit.summary !== (summary ?? "")) ||
    (edit.schema !== undefined && JSON.stringify(edit.schema) !== JSON.stringify(schema ?? null));
  if (!changed) return { result: { reply: edit.reply, file: input.file, changed: false } };
  const file = applyWidgetEdit(input.file, edit);
  try {
    if (file.length > MAX_WIDGET_JSON * 2) throw new Error("The widget is too big.");
    const tree = previewWidget(input.name, file);
    checkExamples(parseWidgetFile(input.name, file));
    return { result: { reply: inputsOf ? inputsNote(toolButtonInputs(tree, inputsOf), edit.reply) : edit.reply, file, changed: true } };
  } catch (error) {
    return { failed: { template: edit.template, message: (error as Error).message } };
  }
}

/**
 * W-24: an action or procedure edit from the model's answer: done when nothing changed, else the
 * new file to check like a save (the config checker, on the server), or what failed.
 */
export function readAgentFileEdit(text: string, answer: string): { result: EditResult } | { check: { reply: string; file: string } } | { failed: { file: string; problems: string[] } } {
  const edit = parseAgentFileEdit(answer);
  if (!edit) return { failed: { file: "(none)", problems: ["The answer had no <file>…</file>."] } };
  if (edit.file.trim() === text.trim()) return { result: { reply: edit.reply, file: text, changed: false } };
  return { check: edit };
}

/** W-27: a procedure's steps that name actions the desk doesn't have, said in the reply (once). */
export function withMissingNote(files: Record<string, string>, name: string, reply: string): string {
  const missing = (agentLinks(files).procedureMissing[name] ?? []).filter((m) => !reply.includes(m));
  if (!missing.length) return reply;
  const list = missing.map((m) => `@${m}`).join(", ");
  return `${reply} ${missing.length === 1 ? `${list} isn't an action yet` : `${list} aren't actions yet`}: create ${missing.length === 1 ? "it" : "them"} under "What it uses", or ask me to.`;
}

/**
 * AI-27: a task edit from the model's answer: the files that actually change (its procedure, its
 * actions, new actions). `check` still has to pass the config checker with the whole draft.
 */
export function readTaskEdit(procedurePath: string, draft: Record<string, string>, answer: string): { result: EditResult } | { check: { reply: string; files: Record<string, string>; cards: { name: string; brief: string }[] } } | { failed: { file: string; problems: string[] } } {
  const edit = parseTaskEdit(answer, procedurePath);
  if (!edit) return { failed: { file: "(none)", problems: ["The answer had no <reply> and no <file path=\"…\">…</file>."] } };
  const files = Object.fromEntries(Object.entries(edit.files).filter(([p, t]) => (draft[p] ?? "").trim() !== t.trim()));
  // AI-30: only cards the desk doesn't have yet are made.
  const cards = edit.cards.filter((c) => draft[`widgets/${c.name}.widget`] === undefined);
  if (!Object.keys(files).length && !cards.length) return { result: { reply: edit.reply, file: draft[procedurePath] ?? "", changed: false } };
  return { check: { reply: edit.reply, files, cards } };
}
