import { APICallError, wrapLanguageModel, type LanguageModel } from "ai";

// AI-16: which model each AI job uses. The provider is workspace-wide; an admin may give
// a job its own model id (e.g. a small fast one for nudges). Pure, so it's unit tested.

export type ProviderId = "openai" | "workers-ai" | "chatgpt";

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-6.1-sol",
  // Fast, follows the rules and calls tools well (scripts/bench-models.ts, 2026-10-05).
  "workers-ai": "@cf/mistralai/mistral-small-3.1-24b-instruct",
  // Small and fast (user's pick, 2026-10-05). Not in `jun models`' list, but the plan serves it.
  chatgpt: "gpt-6-luna",
};

/**
 * Every AI call names its job. `answer`: visitor replies (runAgent, live and in evals);
 * `brief`: handoff brief; `nudge`: nudges and AI openers; `draft`: issue drafts;
 * `topics`: topic labels; `judge`: eval grading; `suggestions`: the widget's suggested
 * questions drafted from the knowledge base (W-15); `editor`: a widget, action or procedure
 * edited by chat on the Agent page (W-22, W-24).
 */
export const AI_JOBS = ["answer", "brief", "nudge", "draft", "topics", "judge", "suggestions", "followups", "editor"] as const;
export type AiJob = (typeof AI_JOBS)[number];
export type JobModels = Partial<Record<AiJob, string>>;

/**
 * A job's own default per provider, used unless an admin set a model for that job. Editing on the
 * Agent page writes whole files (widget templates against ChatKit's long guide, W-22; actions and
 * procedures, W-24), so it gets the large model where the
 * provider has one (user's pick, 2026-10-11). An id the provider rejects falls back to the
 * workspace model, like an override.
 */
export const JOB_DEFAULTS: Record<ProviderId, JobModels> = {
  chatgpt: { editor: "gpt-6-astra" },
  openai: { editor: "gpt-6-astra" },
  "workers-ai": {},
};

const MODEL_ID = /^[\w.:/@-]{1,100}$/;

export class InvalidModelsError extends Error {}

/** Validates a `models` object from the API: known jobs only; empty/null clears an override. */
export function parseJobModels(input: unknown): JobModels {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new InvalidModelsError("models must be an object of job → model id.");
  const out: JobModels = {};
  for (const [job, value] of Object.entries(input)) {
    if (!(AI_JOBS as readonly string[]).includes(job)) throw new InvalidModelsError(`Unknown AI job "${job.slice(0, 40)}". Jobs: ${AI_JOBS.join(", ")}.`);
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") throw new InvalidModelsError(`The model for ${job} must be text.`);
    const id = value.trim();
    if (!id) continue;
    if (!MODEL_ID.test(id)) throw new InvalidModelsError(`"${id.slice(0, 100)}" isn't a model id (up to 100 letters, digits and . : / @ - _).`);
    out[job as AiJob] = id;
  }
  return out;
}

/** Stored JSON → overrides; anything malformed is ignored rather than breaking AI. */
export function readJobModels(json: string | null | undefined): JobModels {
  try {
    return parseJobModels(JSON.parse(json || "{}"));
  } catch {
    return {};
  }
}

export interface ModelSettings {
  provider: ProviderId;
  model: string | null;
  models: JobModels;
}

export function workspaceModel(settings: ModelSettings): string {
  return settings.model || DEFAULT_MODELS[settings.provider];
}

/**
 * The one place that decides a job's model: the admin's override, else the job's default for the
 * provider (JOB_DEFAULTS), else the workspace model. `fallback` is set when that differs from the workspace model.
 */
export function modelFor(settings: ModelSettings, job: AiJob): { modelId: string; fallback: string | null } {
  const base = workspaceModel(settings);
  const override = settings.models[job] ?? JOB_DEFAULTS[settings.provider]?.[job];
  return override && override !== base ? { modelId: override, fallback: base } : { modelId: base, fallback: null };
}

export function effectiveModels(settings: ModelSettings): Record<AiJob, string> {
  return Object.fromEntries(AI_JOBS.map((job) => [job, modelFor(settings, job).modelId])) as Record<AiJob, string>;
}

/**
 * Whether a provider rejected the model id itself (a typo, or a model this plan/account
 * doesn't serve). OpenAI: 404 model_not_found; ChatGPT plan: 400 "The 'x' model is not
 * supported…"; Workers AI: "No such model".
 */
export function isUnknownModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const body = APICallError.isInstance(error) ? (error.responseBody ?? "") : "";
  const text = `${error.message}\n${body}`;
  return /model_not_found|no such model|unknown model|invalid model|model\b[^\n]{0,120}\b(is not supported|not supported|does not exist|not found)/i.test(text);
}

/**
 * The override model, retried once on the workspace model when the provider rejects the
 * override's id, so a typo in Settings doesn't break nudges or briefs. Errors mid-stream
 * (after the request was accepted) are not retried.
 */
export function withFallback(
  primary: LanguageModel,
  fallback: () => LanguageModel,
  info: { job: AiJob; modelId: string; fallbackId: string; onFallback?: () => void },
): LanguageModel {
  if (typeof primary === "string") return primary;
  const retry = <T>(call: () => PromiseLike<T>, viaFallback: (model: ReturnType<typeof wrapLanguageModel>) => PromiseLike<T>) =>
    Promise.resolve(call()).catch((error: unknown) => {
      if (!isUnknownModelError(error)) throw error;
      console.warn(`AI-16: model "${info.modelId}" for ${info.job} was rejected (${(error as Error).message.slice(0, 200)}); using the workspace model "${info.fallbackId}".`);
      info.onFallback?.();
      const model = fallback();
      if (typeof model === "string") throw error;
      return viaFallback(wrapLanguageModel({ model, middleware: [] }));
    });
  return wrapLanguageModel({
    model: primary,
    middleware: {
      wrapGenerate: ({ doGenerate, params }) => retry(doGenerate, (m) => m.doGenerate(params)),
      wrapStream: ({ doStream, params }) => retry(doStream, (m) => m.doStream(params)),
    },
  });
}
