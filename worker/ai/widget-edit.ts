import { widgetEditInput, widgetEditPrompt, type WidgetEditTurn } from "../../shared/widget-ai.ts";
import { CHATKIT_AUTHORING_GUIDE } from "./chatkit-authoring.ts";
import { describeActions } from "../../shared/action-brief.ts";
import { actionBriefs } from "./agent-file-edit.ts";
import { parseConfig, type ConfigFiles } from "./config.ts";

// W-22: a widget edited by chat on the Agent page. One request = one answer from the model, which
// rewrites the template (shared/widget-ai.ts has the prompt and parsing). D-62: the answer streams
// straight to the browser (edit-stream.ts), which applies it and checks it (shared/edit-finish.ts);
// a result that doesn't pass comes back here once with its error. Nothing is saved: the file goes to
// the admin's draft.

/** ChatKit Studio's guide for agents (about 16k tokens) with our rules after it; built once. */
export const WIDGET_EDIT_PROMPT = widgetEditPrompt(CHATKIT_AUTHORING_GUIDE);
export const WIDGET_EDIT_MAX_TOKENS = 6000;

export class WidgetEditError extends Error {}

/** The model's input for one widget edit: the widget, the desk's actions, the chat, the request (and the last try's error). */
export function widgetEditMessage(input: {
  name: string;
  file: string;
  message: string;
  history: WidgetEditTurn[];
  files?: ConfigFiles;
  /** W-32: website actions the desk has seen (name, description, inputs). */
  siteActions?: { name: string; description: string; params: string[] }[];
  error?: { template: string; message: string };
}): string {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(input.file) as Record<string, unknown>;
  } catch {
    throw new WidgetEditError("This widget's file isn't valid JSON. Fix it in Code first.");
  }
  const template = typeof current.template === "string" ? current.template : "";
  const summary = typeof current.summary === "string" ? current.summary : null;
  const schema = typeof current.jsonSchema === "object" && current.jsonSchema !== null && !Array.isArray(current.jsonSchema) && Object.keys(current.jsonSchema).length ? (current.jsonSchema as Record<string, unknown>) : undefined;
  // W-27: the desk's actions (from the draft), so buttons and fields fit the actions they run.
  const actions = input.files ? describeActions(actionBriefs(parseConfig(input.files).config)) : undefined;
  return widgetEditInput({
    name: input.name,
    template,
    sample: current.sample,
    summary,
    ...(schema ? { schema } : {}),
    ...(actions ? { actions } : {}),
    ...(input.siteActions?.length ? { siteActions: input.siteActions.map((a) => `- ${a.name}: ${a.description}${a.params.length ? ` (inputs: ${a.params.join(", ")})` : ""}`).join("\n") } : {}),
    history: input.history,
    message: input.message,
    ...(input.error ? { error: input.error } : {}),
  });
}
