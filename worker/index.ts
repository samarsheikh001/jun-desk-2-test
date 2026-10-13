import { Hono } from "hono";
import { handleCrawlBatch, resyncAll, type CrawlJob } from "./ai/knowledge.ts";
import { labelAllWorkspaces } from "./ai/topics.ts";
import { ai, handleChatGPTCallback } from "./routes/ai.ts";
import { auth } from "./routes/auth.ts";
import { conversations } from "./routes/conversations.ts";
import { files } from "./routes/files.ts";
import { inbox } from "./routes/inbox.ts";
import { issues } from "./routes/issues.ts";
import { metrics } from "./routes/metrics.ts";
import { notifications } from "./routes/notifications.ts";
import { topics } from "./routes/topics.ts";
import { widget } from "./routes/widget.ts";
import { onboarding } from "./routes/onboarding.ts";
import { visitors } from "./routes/visitors.ts";
import { workspaces } from "./routes/workspaces.ts";
import { agent } from "./routes/agent.ts";
import { frameAncestors } from "./lib/origins.ts";
import { HttpError, type AppEnv } from "./types.ts";

export { Conversation } from "./conversation.ts";
export { WorkspaceHub } from "./hub.ts";
export { KnowledgeIndex } from "./ai/knowledge-index.ts";

const app = new Hono<AppEnv>().basePath("/api");

// CSRF protection for cookie-authenticated requests: state-changing requests must be
// JSON or carry our X-Jun-Upload header (neither of which a cross-site form can send)
// and, when the browser says where they came from, come from this origin.
// The loader's nudge request is the exception: it comes from customers' sites (any origin),
// carries no cookies or tokens, and is sent as text/plain so browsers skip a CORS preflight.
const PUBLIC_CROSS_ORIGIN = /^\/api\/widget\/[^/]+\/nudge$/;

app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !PUBLIC_CROSS_ORIGIN.test(new URL(c.req.url).pathname)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, "bad_origin", "Cross-origin request rejected.");
    }
    const isUpload = c.req.header("x-jun-upload") === "1";
    if (c.req.method !== "DELETE" && !isUpload && !c.req.header("content-type")?.startsWith("application/json")) {
      throw new HttpError(400, "json_required", "Send JSON with Content-Type: application/json.");
    }
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
// Used only by public/demo.html to show P1: a request that fails like a real bug would.
app.post("/demo/billing", (c) => c.json({ error: { code: "payment_provider_timeout", message: "Upstream payment provider timed out" } }, 500));
app.route("/", auth);
app.route("/", workspaces);
app.route("/", conversations);
app.route("/", widget);
app.route("/", files);
app.route("/", ai);
app.route("/", agent);
app.route("/", visitors);
app.route("/", onboarding);
app.route("/", inbox);
app.route("/", metrics);
app.route("/", topics);
app.route("/", issues);
app.route("/", notifications);

app.notFound((c) => c.json({ error: { code: "not_found", message: "No such API route." } }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error(error);
  return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
});

/** The chat frame, with a CSP that lets only the widget's allowed websites embed it. */
async function serveWidgetFrame(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const inbox = key ? await env.DB.prepare("SELECT settings FROM inboxes WHERE widget_key = ?").bind(key).first<{ settings: string }>() : null;
  const domains = inbox ? ((JSON.parse(inbox.settings) as { allowedDomains?: string[] }).allowedDomains ?? []) : [];
  // /widget maps to widget.html in the assets (asking for /widget.html would redirect here).
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  response.headers.set("Content-Security-Policy", frameAncestors(domains));
  return response;
}

/** Must match the daily entry in wrangler.jsonc `triggers.crons`. */
/** The run of the 15-minute schedule that also does the daily knowledge re-sync (03:15 UTC). */
const isDailyRun = (scheduledTime: number) => { const d = new Date(scheduledTime); return d.getUTCHours() === 3 && d.getUTCMinutes() === 15; };

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Dev-only ChatGPT sign-in returns to a 127.0.0.1 loopback path outside /api.
    if (pathname === "/auth/callback") return handleChatGPTCallback(request, env);
    if (pathname === "/widget") return serveWidgetFrame(request, env);
    return app.fetch(request, env, ctx);
  },
  // Website crawling (K-01).
  async queue(batch, env) {
    await handleCrawlBatch(batch as MessageBatch<CrawlJob>, env);
  },
  // Every 15 minutes, topic labels for quiet chats (A-02); once a day also the knowledge re-sync.
  async scheduled(controller, env, ctx) {
    if (isDailyRun(controller.scheduledTime)) ctx.waitUntil(resyncAll(env));
    ctx.waitUntil(labelAllWorkspaces(env));
  },
} satisfies ExportedHandler<Env>;
