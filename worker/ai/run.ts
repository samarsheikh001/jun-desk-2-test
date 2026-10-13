import { isStepCount, jsonSchema, streamText, tool, type ToolSet } from "ai";
import { actionInputSchema, DONE_TOOL, matchesPage, type PageAction } from "../../shared/actions.ts";
import type { AiStep, Message } from "../../shared/protocol.ts";
import type { MessageWidget } from "../../shared/widgets.ts";
import { FLAG_TOOL, HANDOFF_TOOL, INLINE_SKILLS_MAX_CHARS, replyOutcome, searchQuery, systemPrompt, toChatMessages, type ReplyDecisions, type ReplyOutcome } from "./agent.ts";
import { intentSkill, type AgentConfig, type ToolSpec, type ToolUser } from "./config.ts";
import type { AgentModel } from "./providers.ts";
import { ReplyText } from "./reply-text.ts";
import { searchKnowledge, type SearchHit } from "./search.ts";
import { httpTools, showWidgetTool, type ToolAction } from "./tools.ts";
import { loadToolSecrets } from "../lib/tool-secrets.ts";
import { actionSetupProblems } from "../../shared/action-setup.ts";
import { SHOW_WIDGET_TOOL } from "../../shared/widgets.ts";

// One AI reply, from conversation history to a parsed outcome. Shared by the live
// Conversation DO and the eval runner (AI-19), so evals test exactly what visitors get.

export const MAX_TOOL_STEPS = 5;

export interface RunInput {
  env: Env;
  workspaceId: string;
  workspaceName: string;
  model: AgentModel;
  config: AgentConfig;
  history: Message[];
  technical?: string[];
  /** Called with what the visitor may see so far (control lines held back), and the knowledge it may cite. */
  onVisible?: (visible: string, hits: SearchHit[]) => void;
  onAction?: (action: ToolAction) => void;
  /** Visitor-safe progress of each HTTP tool call (its `status:` label only). Live chats only. */
  onStep?: (step: AiStep) => void;
  /** Use tools' mock responses (evals). */
  mockTools?: boolean;
  /** AI-29: a test chat's safe mode: calls it returns true for are answered, not made (tools.ts `pretend`). */
  pretend?: (spec: ToolSpec) => boolean;
  timezone?: string;
  /** Evals use 0 so a diff reflects the config change, not sampling noise. */
  temperature?: number;
  /** The customer, when the host app verified who they are (V-03). */
  user?: ToolUser | null;
  /** AI-20: the intent the host app opened the chat with (its skill and built-in rules join the prompt). */
  intent?: string | null;
  /**
   * AI-21: the actions on the customer's page right now (already sanitized). Each becomes a tool
   * without `execute`, so the model calling one ends the turn: the page runs it, not the Worker.
   */
  pageActions?: PageAction[];
  /** AI-21: the path of the page the customer is on; tools with `pages:` are offered only where they match. */
  pagePath?: string | null;
  /** AI-21: this turn follows a page action that just ran (or failed), with no new visitor message. */
  followUp?: { name: string; status: "ok" | "error"; result: string | null; card?: boolean } | null;
  /** W-17: cards already shown with this reply (a card button's tool ran before the turn), so no words is still an answer. */
  shownWidgets?: number;
}

export interface RunResult {
  raw: string;
  outcome: ReplyOutcome;
  hits: SearchHit[];
  actions: ToolAction[];
  /** AI-21: the page action the model chose (the first, if it tried several) with the inputs it gave. */
  pageAction: { action: PageAction; input: Record<string, unknown> } | null;
  /** W-09: cards the customer saw (tool results with `widget:`), in call order. */
  widgets: MessageWidget[];
  usage: { inputTokens: number; outputTokens: number };
}

/** A tool call's arguments as an object (some providers hand them over as a JSON string). */
function callArgs(input: unknown): Record<string, unknown> {
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

/** A JSON schema for one string parameter. */
const oneString = (name: string, description: string) =>
  jsonSchema<Record<string, string>>({ type: "object", properties: { [name]: { type: "string", description } }, required: [name], additionalProperties: false });

function today(timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date());
  }
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { config } = input;
  const hits = await searchKnowledge(input.env, input.workspaceId, searchQuery(input.history));
  const actions: ToolAction[] = [];
  const onAction = (action: ToolAction) => {
    actions.push(action);
    input.onAction?.(action);
  };

  // Tools scoped to pages (AI-21) are offered only on a matching page; without a known page, only unscoped ones.
  const secrets = await loadToolSecrets(input.env, input.workspaceId);
  // AI-24: an action that isn't set up (a key not added, an example address, the starter text) could
  // only fail or be misused, so the AI doesn't get it. Tests on canned responses still do.
  const toolSpecs = config.tools
    .filter((t) => !t.pages || matchesPage(t.pages, input.pagePath))
    .filter((t) => input.mockTools || !actionSetupProblems(t, (name) => secrets(name) !== undefined).length);
  const widgets: MessageWidget[] = [];
  const tools: ToolSet = httpTools(toolSpecs, {
    secrets,
    mock: Boolean(input.mockTools),
    ...(input.pretend ? { pretend: input.pretend } : {}),
    onAction,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    user: input.user ?? null,
    widgets: config.widgets,
    onWidget: (widget) => widgets.push(widget),
  });
  // W-29: cards the AI may fill in itself.
  const fillable = config.widgets.filter((w) => w.aiFill);
  if (fillable.length) {
    tools[SHOW_WIDGET_TOOL] = showWidgetTool(fillable, { onAction, ...(input.onStep ? { onStep: input.onStep } : {}), onWidget: (widget) => widgets.push(widget) });
  }
  const skillChars = config.skills.reduce((n, s) => n + s.instructions.length + s.description.length, 0);
  const skillCatalog = skillChars > INLINE_SKILLS_MAX_CHARS;
  if (skillCatalog) {
    tools.activate_skill = tool({
      description: "Load the full steps of a procedure by name before following it.",
      inputSchema: jsonSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string", enum: config.skills.map((s) => s.name) } },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: async ({ name }) => {
        const skill = config.skills.find((s) => s.name === name);
        onAction({ tool: "activate_skill", input: { name }, output: skill ? "loaded" : "unknown procedure", status: skill ? "ok" : "error", httpStatus: null, durationMs: 0 });
        return skill ? skill.instructions : `No procedure named ${name}.`;
      },
    });
  }

  // AI-21: page actions are tools without execute. The SDK stops the loop when one is called;
  // the DO hands the call to the widget, which runs it on the page.
  const pageActions = input.pageActions ?? [];
  const pageActionByTool = new Map(pageActions.map((a) => [a.tool, a]));
  for (const action of pageActions) {
    tools[action.tool] = tool({ description: action.description, inputSchema: jsonSchema<Record<string, unknown>>(actionInputSchema(action)) });
  }
  // A turn after a page action must decide: the next action, or DONE_TOOL (nothing more to do).
  // Left free, models sometimes announce the next step ("I'll find Siloso Beach next") and stop,
  // which ends the chain; with a tool call required, stopping is an explicit choice.
  const decide = Boolean(input.followUp && pageActions.length);
  if (decide) {
    // Its message is the reply: with a tool call required, models put their closing words in the call
    // and write no text (an empty reply would read as "couldn't answer" and hand off).
    tools[DONE_TOOL] = tool({
      description: "Call this when the customer's request needs no further page action. `message` is your reply to them: one short sentence confirming what was done, or saying what failed and what to try.",
      inputSchema: jsonSchema<{ message: string }>({ type: "object", properties: { message: { type: "string", description: "Your reply to the customer." } }, required: ["message"], additionalProperties: false }),
    });
  }

  // The model's decisions about the conversation (see HANDOFF_TOOL in agent.ts), read from its
  // tool calls, never searched for in the text. Handoff has no execute: calling it ends the turn.
  // Flagging runs, so the model can flag first and then explain in the next step: some models
  // (Workers AI's Mistral) don't write text and call a tool in the same response.
  const decisions: ReplyDecisions = { handoff: null, flag: null };
  tools[HANDOFF_TOOL] = tool({
    // The when-to is here as well as in the prompt: Mistral otherwise wrote "a member of our team will
    // help" without calling it, and the chat stayed with the AI.
    description:
      "Hand this chat to a person on the team. Call it when the customer asks for a person, or needs something only staff can do (refunds, account, email or billing changes, cancellations, data deletion) that no other tool or page action covers, or when you can't help. Don't tell them a teammate will help without calling it: calling it is what brings one in, and the customer is told.",
    inputSchema: oneString("reason", "Why, in a few words, for the team."),
  });
  if (input.technical?.length) {
    tools[FLAG_TOOL] = tool({
      description: "Flag a problem seen in the customer's browser (an error or failed request) to the engineers. Call it first, then tell the customer what failed.",
      inputSchema: oneString("summary", "One line for engineers: what failed, where, when."),
      execute: async ({ summary }) => {
        decisions.flag = typeof summary === "string" ? summary : "";
        onAction({ tool: FLAG_TOOL, input: { summary: decisions.flag }, output: "flagged", status: "ok", httpStatus: null, durationMs: 0 });
        return "Flagged for the engineers. Now tell the customer plainly what failed and when, and that the team has it. Don't repeat anything you already said.";
      },
    });
  }

  const system = systemPrompt({
    workspaceName: input.workspaceName,
    persona: config.persona,
    handoffTopics: config.handoffTopics,
    skills: config.skills,
    skillCatalog,
    tools: toolSpecs.map((t) => ({ name: t.name, description: t.description })),
    hits,
    technical: input.technical ?? [],
    today: today(input.timezone),
    ...(input.user ? { customer: input.user } : {}),
    ...(input.intent ? { intent: { name: input.intent, skill: intentSkill(config, input.intent) } } : {}),
    pageActions,
    ...(input.followUp ? { followUp: input.followUp } : {}),
  });

  const result = streamText({
    model: input.model.model,
    ...input.model.prompt(system),
    messages: toChatMessages(input.history),
    tools,
    stopWhen: [
      isStepCount(MAX_TOOL_STEPS),
      // Flagging runs so a model can flag first and explain next; one that already explained in the
      // same step is done (given the tool's result, Mistral wrote its whole reply again).
      ({ steps }) => {
        const last = steps.at(-1);
        return Boolean(last?.text.trim() && last.toolCalls.some((call) => call.toolName === FLAG_TOOL));
      },
    ],
    ...(decide ? { toolChoice: "required" as const } : {}),
    maxOutputTokens: 1200,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });

  // Text from several steps (before and after tool calls) reads as one reply; see ReplyText.
  const reply = new ReplyText();
  let raw = "";
  let shown = "";
  let pageAction: RunResult["pageAction"] = null;
  let done: string | null = null;
  for await (const part of result.fullStream) {
    if (part.type === "start-step") {
      reply.startStep();
    } else if (part.type === "text-start") {
      if (reply.startItem(part.id)) console.warn("[ai] a second message item in one step replaced the first", JSON.stringify(part.providerMetadata ?? {}));
    } else if (part.type === "tool-call" && pageActionByTool.has(part.toolName)) {
      // One action per reply: the first call counts, the rest are ignored (the turn ends anyway).
      if (!pageAction) pageAction = { action: pageActionByTool.get(part.toolName)!, input: callArgs(part.input) };
    } else if (part.type === "tool-call" && part.toolName === DONE_TOOL) {
      const message = callArgs(part.input).message;
      done = typeof message === "string" ? message.trim() : "";
    } else if (part.type === "tool-call" && part.toolName === HANDOFF_TOOL) {
      const reason = callArgs(part.input).reason;
      decisions.handoff = typeof reason === "string" ? reason : "";
    } else if (part.type === "text-delta") {
      // Every word is the reply's: the model's decisions come as tool calls, so nothing is held back.
      raw = reply.delta(part.id, part.text);
      if (raw.trim() && raw !== shown) {
        shown = raw;
        input.onVisible?.(raw, hits);
      }
    } else if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
  const usage = await result.totalUsage;
  // Seen once on ChatGPT plan usage: the whole reply twice back to back ("…okay?I'm about…"), likely
  // two message items (now handled by ReplyText). A reply that is exactly itself twice is never
  // intended, so keep one copy even if it came as one item.
  const half = raw.length >> 1;
  if (raw.length > 40 && raw.length % 2 === 0 && raw.slice(0, half) === raw.slice(half)) raw = raw.slice(0, half);
  // DONE_TOOL's message is the reply when the model wrote none (text it did write already streamed).
  if (done !== null && !raw.trim() && done) {
    raw = done;
    input.onVisible?.(raw, hits);
  }
  let outcome = replyOutcome(raw, decisions);
  // Ending the chain with nothing to say is fine (the steps show what was done), not a handoff.
  if (done !== null && !raw.trim()) outcome = { kind: "answer", text: "", escalate: null };
  // W-09: a card with no words is still an answer (the card is what the customer asked for).
  if ((widgets.length || input.shownWidgets) && outcome.kind === "handoff" && decisions.handoff === null && decisions.flag === null) outcome = { kind: "answer", text: "", escalate: null };
  if (pageAction) {
    // A reply that only calls the action has no text; that's an answer (the action card), not a handoff.
    if (outcome.kind === "handoff") {
      if (decisions.handoff !== null) pageAction = null; // handing off wins over the call
      else outcome = { kind: "answer", text: "", escalate: null };
    }
  }
  return {
    raw,
    outcome,
    hits,
    actions,
    pageAction,
    widgets,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}
