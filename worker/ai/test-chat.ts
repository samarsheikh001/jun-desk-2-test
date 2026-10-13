import { rankActions, sanitizeActions, withRiskOverrides, type MessageAction, type PageAction, type SeenPageAction } from "../../shared/actions.ts";
import type { Message } from "../../shared/protocol.ts";
import type { TestCall, TestChatEvent, TestPress, TestReply, TestTurn } from "../../shared/test-chat.ts";
import { matchWidgetAction, PAGE_ACTION_BUTTON, renderActionLine, TOOL_ACTION, toolActionInput, type MessageWidget, type WidgetActionMeta } from "../../shared/widgets.ts";
import { compileTemplate } from "../../shared/jinja.ts";
import { runTool, type ToolAction } from "./tools.ts";
import { loadToolSecrets } from "../lib/tool-secrets.ts";
import { asksForHuman, resolveCitations } from "./agent.ts";
import type { AgentConfig, ToolUser } from "./config.ts";
import type { AgentModel } from "./providers.ts";
import { runAgent } from "./run.ts";

// AI-29: one reply in a task page's test chat (shared/test-chat.ts). The draft's config, the chat so
// far, and the same runAgent as live chats; what the customer would see streams back. Nothing is
// stored. Safe mode (the default): look-ups run for real, changes (POST) are answered without being
// made (tools.ts `pretend`). Website actions the desk has seen are offered as on a page; one the AI
// asks for is shown, and the next turn sees it as done, as a test case does.

/** How much of a call's output the test chat shows. */
const MAX_CALL_OUTPUT = 600;

function message(seq: number, body: string, authorType: Message["authorType"], meta: Message["meta"] = {}): Message {
  return { id: `test_${seq}`, seq, authorType, authorId: null, authorName: null, body, attachments: [], clientMsgId: `test:${seq}`, createdAt: Date.now(), internal: false, meta };
}

/** The website actions the desk has seen, as a page would send them (inputs as text; their real types aren't known). */
export function seenAsPageActions(seen: SeenPageAction[]): PageAction[] {
  return sanitizeActions(
    seen.map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: { type: "object", properties: Object.fromEntries(a.params.map((p) => [p, { type: "string" }])) },
      ...(a.risk ? { risk: a.risk } : {}),
      ...(a.widget ? { widget: a.widget } : {}),
    })),
  );
}

/** AI-30: a press's card, matched like a live press (`matchWidgetAction`): what the button does and what's kept of the fields. */
export function pressOf(turns: TestTurn[], press: TestPress): { widget: MessageWidget; meta: WidgetActionMeta; label: string } | null {
  const turn = turns[press.turn];
  const widget = turn?.role === "ai" ? turn.reply.widgets.find((w) => w.id === press.widgetId) : undefined;
  if (!widget) return null;
  const match = matchWidgetAction(widget.root, press.action, press.values, press.item);
  if (!match) return null;
  return {
    widget,
    label: match.label,
    meta: {
      widgetId: widget.id,
      widget: widget.name,
      type: match.action.type,
      ...(match.action.payload !== undefined ? { payload: match.action.payload } : {}),
      ...(Object.keys(match.values).length ? { values: match.values } : {}),
      ...(match.item ? { item: match.item } : {}),
      ...(press.tool ? { tool: { name: press.tool.name, status: press.tool.status, output: press.tool.output, ...(press.tool.done ? { done: press.tool.done } : {}) } } : {}),
    },
  };
}

/** The chat so far as conversation history: earlier replies with their cards, presses as live, website actions as done. */
export function testHistory(turns: TestTurn[], pageActions: PageAction[]): Message[] {
  return turns.map((t, i) => {
    if (t.role === "customer") {
      const press = t.press ? pressOf(turns, t.press) : null;
      return press ? message(i + 1, press.label, "visitor", { widgetAction: press.meta }) : message(i + 1, t.text, "visitor");
    }
    const r = t.reply;
    const meta: Message["meta"] = r.widgets.length ? { widgets: r.widgets } : {};
    const asked = r.pageAction ? pageActions.find((a) => a.name === r.pageAction!.name) : undefined;
    if (asked && r.pageAction) {
      // As if the customer confirmed and the page ran it: the next turn sees it as done.
      const card: MessageAction = {
        runId: `run_test_${i}`,
        id: asked.id,
        name: asked.name,
        tool: asked.tool,
        description: asked.description,
        risk: asked.risk === "auto" ? "auto" : "confirm",
        params: asked.params,
        required: asked.required,
        input: r.pageAction.input,
        missing: [],
        status: "ok",
        result: "done",
        canUndo: false,
      };
      meta.action = card;
    }
    return message(i + 1, r.text, "ai", meta);
  });
}

const callOf = (a: ToolAction): TestCall => ({
  tool: a.tool,
  status: a.status,
  httpStatus: a.httpStatus,
  output: a.output.length > MAX_CALL_OUTPUT ? `${a.output.slice(0, MAX_CALL_OUTPUT)}…` : a.output,
  ...(a.pretended ? { pretended: true as const } : {}),
});

type RunTestInput = { env: Env; workspaceId: string; workspaceName: string; model: AgentModel; config: AgentConfig; turns: TestTurn[]; real: boolean; user: ToolUser | null; page: string | null; seen: SeenPageAction[] };

/**
 * AI-30: a pressed button, before any AI turn, as the Conversation object does it: `tool:` runs the
 * action (pretended in the safe mode) and its own done / failed line may answer; `page:` asks for the
 * website action (no AI turn); anything else goes to the AI. Null: let the AI answer.
 */
async function runPress(input: RunTestInput, press: TestPress, pageActions: PageAction[]): Promise<{ reply: TestReply } | { tool: NonNullable<TestPress["tool"]>; call: TestCall; widget: MessageWidget | null } | null> {
  const found = pressOf(input.turns, press);
  if (!found) return { reply: { text: "", widgets: [], calls: [], pressed: { failed: "That card doesn't offer this button (the card changed since)." } } };
  const { meta } = found;
  const tool = TOOL_ACTION.exec(meta.type)?.[1];
  if (tool) {
    const spec = input.config.tools.find((t) => t.name === tool);
    if (!spec) return { reply: { text: "", widgets: [], calls: [], pressed: { failed: `There's no action called ${tool}.` } } };
    const actionInput = toolActionInput({ type: meta.type, ...(meta.payload !== undefined ? { payload: meta.payload } : {}) }, meta.values ?? {}, spec.input);
    const { action, widget, result } = await runTool(
      spec,
      actionInput,
      { secrets: await loadToolSecrets(input.env, input.workspaceId), user: input.user, widgets: input.config.widgets, ...(input.real ? {} : { pretend: (s) => s.method === "POST" }) },
      `wt${Date.now().toString(36)}`,
    );
    const ok = action.status === "ok";
    const values = meta.values ?? {};
    const done = ok && spec.widgetDone ? renderActionLine(compileTemplate(spec.widgetDone), values, result) : "";
    const failed = !ok && spec.widgetFailed ? renderActionLine(compileTemplate(spec.widgetFailed), values, undefined) : "";
    const call = callOf(action);
    const ran = { name: action.tool, status: action.status, output: action.output, ...(done && !widget ? { done } : {}) };
    // Its widget_failed line: the card opens again with it (a real chat sends nothing).
    if (failed) return { reply: { text: "", widgets: [], calls: [call], pressed: { tool: ran, failed } } };
    // Its widget_done line answers the press, unless the action also shows a card (then the AI answers with it).
    if (done && !widget) return { reply: { text: "", widgets: [], calls: [call], pressed: { tool: ran, done } } };
    return { tool: ran, call, widget };
  }
  const page = PAGE_ACTION_BUTTON.exec(meta.type)?.[1];
  if (page) {
    const action = pageActions.find((a) => a.name === page);
    if (!action) return { reply: { text: "", widgets: [], calls: [], pressed: { failed: `Your website hasn't offered ${page} yet, so the card would say it isn't available.` } } };
    const actionInput = toolActionInput({ type: meta.type, ...(meta.payload !== undefined ? { payload: meta.payload } : {}) }, meta.values ?? {}, action.params);
    return { reply: { text: "", widgets: [], calls: [], pageAction: { name: action.name, input: actionInput } } };
  }
  return null;
}

export async function runTestChat(input: RunTestInput, emit: (event: TestChatEvent) => void): Promise<{ inputTokens: number; outputTokens: number }> {
  const allActions = withRiskOverrides(seenAsPageActions(input.seen), input.config.websiteActionRisk, input.config.websiteActionStatus);
  // AI-30: the last turn may be a button's press.
  const last = input.turns.at(-1);
  let pressRun: { tool: NonNullable<TestPress["tool"]>; call: TestCall; widget: MessageWidget | null } | null = null;
  if (last?.role === "customer" && last.press) {
    const ran = await runPress(input, last.press, allActions);
    if (ran && "reply" in ran) {
      emit({ type: "done", reply: ran.reply });
      return { inputTokens: 0, outputTokens: 0 };
    }
    if (ran) {
      pressRun = ran;
      last.press.tool = ran.tool;
      if (ran.widget) emit({ type: "step", step: { id: "press", label: "Done", state: "done", widget: ran.widget } });
    }
  }
  const history = testHistory(input.turns, allActions);
  const question = history.at(-1)?.body ?? "";
  // The live desk's shortcut: asking for a person hands off without asking the AI.
  if (!last || last.role !== "customer" || !last.press) {
    if (asksForHuman(question)) {
      emit({ type: "done", reply: { text: "", handoff: "The customer asked for a person.", widgets: [], calls: [] } });
      return { inputTokens: 0, outputTokens: 0 };
    }
  }
  const result = await runAgent({
    env: input.env,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    model: input.model,
    config: input.config,
    history,
    user: input.user,
    pagePath: input.page,
    pageActions: rankActions(allActions, question),
    ...(input.real ? {} : { pretend: (spec) => spec.method === "POST" }),
    ...(pressRun?.widget ? { shownWidgets: 1 } : {}),
    onVisible: (text) => emit({ type: "text", text }),
    onStep: (step) => emit({ type: "step", step }),
  });
  const { text, sources } = resolveCitations(result.outcome.text, result.hits);
  const reply: TestReply = {
    text,
    ...(result.outcome.kind === "handoff" ? { handoff: result.outcome.reason } : {}),
    ...(result.outcome.kind === "answer" && result.outcome.escalate ? { escalate: result.outcome.escalate } : {}),
    widgets: [...(pressRun?.widget ? [pressRun.widget] : []), ...result.widgets],
    calls: [...(pressRun ? [pressRun.call] : []), ...result.actions.map(callOf)],
    ...(result.pageAction ? { pageAction: { name: result.pageAction.action.name, input: result.pageAction.input } } : {}),
    ...(sources.length ? { sources } : {}),
    ...(pressRun ? { pressed: { tool: pressRun.tool } } : {}),
  };
  emit({ type: "done", reply });
  return result.usage;
}
