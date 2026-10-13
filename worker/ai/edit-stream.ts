import { buildResponsesBody, OPENAI_API_BASE, toLlmError } from "@jun/llm";
import { HttpError } from "../types.ts";
import { modelFor } from "./models.ts";
import { loadAiSettings, type AiSettings } from "./providers.ts";

// D-62: the Agent page's AI editors (widgets, actions, procedures) stream the model's answer straight
// through to the browser. The Worker builds the prompt (the ChatKit guide stays server-side), sends it
// and returns the provider's own event stream untouched: piping a body costs the Worker almost no CPU,
// while reading every streamed event cost ~1 s of it per edit, far over the Workers Free plan's 10 ms
// (D-61). The browser reads the stream (web/agent/editStream.ts), shows the reply as it comes, checks
// the result and asks once more if it doesn't pass, like the server used to.

/** How the browser should read the stream: OpenAI's Responses events, or Workers AI's chat chunks. */
export type EditStreamFormat = "responses" | "workers-ai";

export type EditStreamSkip = "ai_off" | "cap_reached";

/** The AI is on and under the month's cap, else why not. */
export async function editorSettings(env: Env, workspaceId: string): Promise<AiSettings | { skipped: EditStreamSkip }> {
  const [settings, usage] = await Promise.all([
    loadAiSettings(env, workspaceId),
    env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(workspaceId, new Date().toISOString().slice(0, 7)).first<{ replies: number }>(),
  ]);
  if (!settings.enabled) return { skipped: "ai_off" };
  if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) return { skipped: "cap_reached" };
  return settings;
}

const UNKNOWN_MODEL = /model_not_found|no such model|unknown model|invalid model|model\b[^\n]{0,120}\b(is not supported|not supported|does not exist|not found)/i;

async function responsesRequest(env: Env, workspaceId: string, provider: "chatgpt" | "openai", modelId: string, system: string, user: string, maxOutputTokens: number): Promise<Response> {
  const body = { ...buildResponsesBody({ messages: [{ role: "user", content: user }], instructions: system }, modelId), max_output_tokens: maxOutputTokens };
  const send = (authorization: string, base: string) =>
    fetch(`${base}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization },
      body: JSON.stringify(body),
    });
  if (provider === "openai") {
    const vars = env as unknown as { OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string };
    if (!vars.OPENAI_API_KEY) throw new HttpError(400, "ai_unavailable", "OPENAI_API_KEY isn't set. Add it as a Worker secret.");
    return send(`Bearer ${vars.OPENAI_API_KEY}`, vars.OPENAI_BASE_URL || OPENAI_API_BASE);
  }
  // Token refresh happens in the workspace's hub object, so rotation is never raced; a 401 may just be a stale token.
  const hub = env.WORKSPACE_HUB.getByName(workspaceId);
  for (let attempt = 0; ; attempt++) {
    const response = await send(`Bearer ${await hub.chatgptAccessToken(workspaceId, attempt > 0)}`, OPENAI_API_BASE);
    if (response.status !== 401 || attempt > 0) return response;
  }
}

async function upstream(env: Env, workspaceId: string, settings: AiSettings, modelId: string, system: string, user: string, maxOutputTokens: number): Promise<{ format: EditStreamFormat; response: Response }> {
  if (settings.provider === "workers-ai") {
    try {
      const stream = (await env.AI.run(modelId as Parameters<Ai["run"]>[0], {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: true,
        max_tokens: maxOutputTokens,
      } as never)) as unknown;
      if (!(stream instanceof ReadableStream)) throw new Error("Workers AI didn't stream.");
      return { format: "workers-ai", response: new Response(stream) };
    } catch (error) {
      return { format: "workers-ai", response: new Response(JSON.stringify({ error: { message: (error as Error).message } }), { status: 502 }) };
    }
  }
  return { format: "responses", response: await responsesRequest(env, workspaceId, settings.provider, modelId, system, user, maxOutputTokens) };
}

/**
 * The editor model's answer to one prompt, as the provider's raw event stream (header
 * `x-jun-format`). The job's model, retried once on the workspace model when the provider rejects
 * the override's id (as `withFallback` does for the other jobs).
 */
export async function editStream(env: Env, workspaceId: string, settings: AiSettings, system: string, user: string, maxOutputTokens: number): Promise<Response> {
  const { modelId, fallback } = modelFor(settings, "editor");
  let { format, response } = await upstream(env, workspaceId, settings, modelId, system, user, maxOutputTokens);
  let text = response.ok ? "" : await response.text();
  if (!response.ok && fallback && UNKNOWN_MODEL.test(text)) {
    console.warn(`[ai] editor: model ${modelId} rejected, using ${fallback}`);
    ({ format, response } = await upstream(env, workspaceId, settings, fallback, system, user, maxOutputTokens));
    text = response.ok ? "" : await response.text();
  }
  if (!response.ok || !response.body) {
    let error: { code?: string; type?: string; message?: string } | undefined;
    try {
      error = (JSON.parse(text) as { error?: typeof error }).error;
    } catch {
      error = text ? { message: text.slice(0, 300) } : undefined;
    }
    throw new HttpError(502, "ai_failed", `The AI couldn't make the change: ${toLlmError(response.status, error).message}`);
  }
  return new Response(response.body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-jun-format": format },
  });
}
