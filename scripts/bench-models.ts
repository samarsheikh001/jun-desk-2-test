// Compares Workers AI chat models on latency and behaviour for the support agent.
// Run against a dev server whose DB already has the e2e knowledge and agent config with the
// lookup_order tool (after `npm run test:e2e`):
//   BASE_URL=http://localhost:5174 node scripts/bench-models.ts [model ...]

import { Client, SETUP_TOKEN, SoftAuthenticator, TestSocket } from "./e2e-lib.ts";

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/openai/gpt-oss-20b", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"];

const now = Date.now();
const QUESTIONS = [
  { name: "knowledge", body: "How many days do I have to request a refund?", context: undefined },
  { name: "vague", body: "My dashboard won't load", context: undefined },
  { name: "tool", body: "Where is my order A-1042?", context: undefined },
  { name: "no-tool", body: "Do you have a refund policy?", context: undefined },
  {
    name: "bug",
    body: "Why can't I pay my invoice?",
    context: {
      page: { url: "https://app.customer.test/billing", title: "Billing" },
      userAgent: "Mozilla/5.0 Chrome/141",
      viewport: { w: 1440, h: 900 },
      language: "en-GB",
      timezone: "Europe/London",
      capturedAt: now,
      events: [{ t: now - 20_000, kind: "network", method: "POST", url: "https://app.customer.test/api/billing", status: 500, durationMs: 230 }],
    },
  },
];

const agent = new Client();
await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN });
const workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId as string;
const widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey as string;

async function ask(question: (typeof QUESTIONS)[number]) {
  const visitor = new Client();
  const token = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const started = Date.now();
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, {
    body: { clientMsgId: crypto.randomUUID(), body: question.body, context: question.context },
    headers: { "X-Visitor-Token": token },
  });
  const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${res.json.conversation.id}/ws?since=1`, { protocols: [token] });
  await socket.opened;
  let firstWord: number | null = null;
  const result = await new Promise<{ kind: string; text: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout", text: "" }), 90_000);
    socket.ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      const ev = JSON.parse(String(e.data));
      const msgs = ev.type === "message" ? [ev.message] : ev.type === "messages" ? ev.messages : [];
      if (ev.type === "ai_delta" && firstWord === null) firstWord = Date.now() - started;
      for (const m of msgs) {
        if (m.authorType === "ai" || m.authorType === "system") {
          clearTimeout(timer);
          resolve({ kind: m.authorType === "ai" ? "answer" : "handoff", text: m.body });
        }
      }
    });
  });
  const total = Date.now() - started;
  socket.close();
  return { ...result, firstWord: firstWord ?? (result.kind === "answer" ? total : null), total };
}

console.log("model | question | first word | total | outcome | reply");
for (const model of MODELS) {
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: "workers-ai", model, monthlyReplyCap: 10000 } });
  for (const q of QUESTIONS) {
    const r = await ask(q);
    const first = r.firstWord === null ? "-" : `${(r.firstWord / 1000).toFixed(1)}s`;
    console.log(`${model.replace("@cf/", "")} | ${q.name} | ${first} | ${(r.total / 1000).toFixed(1)}s | ${r.kind} | ${r.text.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
// Leave the default model in place.
await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: "workers-ai", model: null, monthlyReplyCap: 100 } });
