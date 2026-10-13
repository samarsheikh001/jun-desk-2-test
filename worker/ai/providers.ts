import { createOpenAI } from "@ai-sdk/openai";
import { OPENAI_API_BASE } from "@jun/llm";
import { streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { modelFor, readJobModels, withFallback, type AiJob, type JobModels, type ProviderId } from "./models.ts";
import { dedupedAi } from "./workers-ai.ts";

type ProviderOptions = Record<string, Record<string, string | number | boolean | null>>;

export { AI_JOBS, DEFAULT_MODELS, type AiJob, type ProviderId } from "./models.ts";

export interface AiSettings {
  enabled: boolean;
  provider: ProviderId;
  /** The workspace model (null = provider default); every job uses it unless overridden. */
  model: string | null;
  /** AI-16: per-job model overrides within the same provider. */
  models: JobModels;
  instructions: string;
  monthlyReplyCap: number;
}

export async function loadAiSettings(env: Env, workspaceId: string): Promise<AiSettings> {
  const row = await env.DB.prepare("SELECT enabled, provider, model, models, instructions, monthly_reply_cap FROM ai_settings WHERE workspace_id = ?")
    .bind(workspaceId)
    .first<{ enabled: number; provider: ProviderId; model: string | null; models: string | null; instructions: string; monthly_reply_cap: number }>();
  return {
    enabled: row?.enabled === 1,
    provider: row?.provider ?? "workers-ai",
    model: row?.model ?? null,
    models: readJobModels(row?.models),
    instructions: row?.instructions ?? "",
    monthlyReplyCap: row?.monthly_reply_cap ?? 2000,
  };
}

/** Sign in with ChatGPT (D-27) spends the signed-in owner's plan; this private desk always offers it. */
export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export class AiUnavailableError extends Error {}

/**
 * One whole reply, for prompts nobody watches stream (nudges, handoff briefs, issue drafts,
 * eval grading). ChatGPT plan usage only accepts streaming requests ("Stream must be set to
 * true"), so this streams and collects instead of calling generateText.
 */
export async function completeText(options: Parameters<typeof streamText>[0]): Promise<{ text: string; totalUsage: LanguageModelUsage }> {
  let failure: unknown;
  const result = streamText({
    ...options,
    onError: ({ error }) => {
      failure ??= error;
    },
  });
  try {
    const [text, totalUsage] = await Promise.all([result.text, result.totalUsage]);
    if (failure) throw failure;
    return { text, totalUsage };
  } catch (error) {
    throw failure ?? error;
  }
}

/** A chat model plus how this provider wants the system prompt delivered. */
export interface AgentModel {
  provider: ProviderId;
  modelId: string;
  model: LanguageModel;
  /** Call options carrying `system` (ChatGPT plan usage rejects system messages, so it goes in `instructions`). */
  prompt(system: string): { system?: string; providerOptions?: ProviderOptions };
}

/**
 * The model for one AI job (AI-16: `modelFor` decides which). An override the provider
 * rejects as unknown is retried once on the workspace model (`withFallback`).
 */
export function createModel(env: Env, workspaceId: string, settings: AiSettings, job: AiJob): AgentModel {
  const { modelId, fallback } = modelFor(settings, job);
  const agent = providerModel(env, workspaceId, settings.provider, modelId);
  if (!fallback) return agent;
  agent.model = withFallback(agent.model, () => providerModel(env, workspaceId, settings.provider, fallback).model, {
    job,
    modelId,
    fallbackId: fallback,
    onFallback: () => {
      agent.modelId = fallback;
    },
  });
  return agent;
}

function providerModel(env: Env, workspaceId: string, provider: ProviderId, modelId: string): AgentModel {
  const plain = (model: LanguageModel): AgentModel => ({ provider, modelId, model, prompt: (system) => ({ system }) });

  if (provider === "workers-ai") {
    // dedupedAi: see workers-ai.ts (Workers AI streams text and tool calls twice).
    return plain(createWorkersAI({ binding: dedupedAi(env.AI) })(modelId));
  }
  if (provider === "openai") {
    const apiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
    if (!apiKey) throw new AiUnavailableError("OPENAI_API_KEY isn't set. Add it as a Worker secret.");
    const baseURL = (env as unknown as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL;
    return {
      ...plain(createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelId)),
      prompt: (system) => ({ system, providerOptions: { openai: { store: false } } }),
    };
  }
  // Token refresh happens in the workspace's hub object, so rotation is never raced.
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  const chatgptFetch: typeof fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const token = await hub.chatgptAccessToken(workspaceId, attempt > 0);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(input, { ...init, headers });
      // A plain 401 may just be a stale access token: refresh once and retry.
      if (response.status !== 401 || attempt > 0) return response;
    }
  };
  const openai = createOpenAI({ apiKey: "chatgpt-plan", baseURL: OPENAI_API_BASE, fetch: chatgptFetch });
  return {
    provider: "chatgpt",
    modelId,
    model: openai(modelId),
    prompt: (system) => ({ providerOptions: { openai: { instructions: system, store: false } } }),
  };
}
