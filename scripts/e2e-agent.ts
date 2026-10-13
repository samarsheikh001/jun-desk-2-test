// End-to-end test of M5, support agent as code: config versions (dashboard + API token),
// conflict rules, an HTTP tool the live AI calls (audit log), `jun eval` over NDJSON, and
// the `jun` CLI itself (login/init/push/pull/eval). real AI (E2E_AI_PROVIDER, default ChatGPT). Run after e2e-ai.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cardFromResult } from "../shared/action-try.ts";
import { AI_PROVIDER, BASE, Client, cookieHeader, SETUP_TOKEN, SoftAuthenticator, step, summary, TestSocket } from "./e2e-lib.ts";

const AI_TIMEOUT = 120_000;
// A public echo API stands in for the customer's order API (workerd can't fetch its own dev server).
const ECHO_URL = process.env.ECHO_URL ?? "https://httpbin.org/anything";

const agent = new Client();
let workspaceId = "";
let widgetKey = "";
let token = "";

const files = (extra: Record<string, string> = {}): Record<string, string> => ({
  "AGENTS.md": "---\nmaxReplies: 6\nhandoffTopics: [legal questions]\n---\nBe brief and friendly.",
  "skills/order-status/SKILL.md":
    "---\nname: order-status\ndescription: The customer asks where their order is or when it will arrive.\n---\n1. If you don't have the order number, ask for it.\n2. Look it up with lookup_order.\n3. Tell them the status and the delivery estimate (eta) from the result.",
  "tools/lookup_order.yaml": `description: Look up an order by its number. Returns the order's status and delivery estimate (eta).
url: ${ECHO_URL}/orders/{orderNumber}
query:
  status: shipped
  eta: Friday
input:
  orderNumber:
    type: string
    description: The order number, like A-1042
pick: [args]
mock: { args: { status: shipped, eta: Friday } }
`,
  "evals/basics.yaml": "- name: asks for a human\n  message: can I talk to a real person please\n  expect:\n    outcome: handoff\n- name: order status uses the tool\n  message: Where is my order A-1042?\n  expect:\n    tools: [lookup_order]\n",
  ...extra,
});

const bearer = () => ({ authorization: `Bearer ${token}` });

await step("owner signs in; AI on; the agent starts from the built-in default config", async () => {
  assert.equal((await agent.register("/recover", new SoftAuthenticator(), { token: SETUP_TOKEN })).status, 200);
  workspaceId = (await agent.call("/me")).json.memberships[0].workspaceId;
  widgetKey = (await agent.call(`/workspaces/${workspaceId}/inbox`)).json.inbox.widgetKey;
  await agent.call(`/workspaces/${workspaceId}/ai`, { method: "PUT", body: { enabled: true, provider: AI_PROVIDER, monthlyReplyCap: 1000 } });
  const res = await agent.call(`/workspaces/${workspaceId}/agent`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.files["AGENTS.md"].includes("maxReplies"));
  assert.deepEqual(res.json.issues, []);
});

await step("an API token works for this workspace only; bad tokens are rejected", async () => {
  const created = await agent.call(`/workspaces/${workspaceId}/tokens`, { body: { name: "e2e laptop" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  token = created.json.token;
  assert.match(token, /^jun_/);
  const anon = new Client();
  const who = await anon.call("/cli/whoami", { headers: bearer() });
  assert.equal(who.status, 200, JSON.stringify(who.json));
  assert.equal(who.json.workspace.id, workspaceId);
  assert.equal((await anon.call("/cli/whoami", { headers: { authorization: "Bearer jun_nope" } })).status, 401);
  assert.equal((await anon.call(`/workspaces/ws_other/agent`, { headers: bearer() })).status, 403);
  // Tokens are for the agent API only, not the rest of the dashboard API.
  assert.equal((await anon.call(`/workspaces/${workspaceId}/conversations`, { headers: bearer() })).status, 401);
  const list = (await agent.call(`/workspaces/${workspaceId}/tokens`)).json.tokens;
  assert.ok(list.some((t: { name: string; token?: string }) => t.name === "e2e laptop" && t.token === undefined));
});

let version = 0;

await step("push rejects invalid config with file-level errors, then accepts a valid one", async () => {
  const anon = new Client();
  const bad = await anon.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", headers: bearer(), body: { files: { "AGENTS.md": "---\nmaxReplys: 2\n---\nx", "tools/x.yaml": "url: nope" }, base: null } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_config");
  assert.ok(bad.json.error.issues.some((i: { path: string }) => i.path === "tools/x.yaml"));

  const good = await anon.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", headers: bearer(), body: { files: files(), base: null, message: "order status tool" } });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  version = good.json.version;
  assert.deepEqual(good.json.summary.tools, ["lookup_order"]);
  assert.deepEqual(good.json.summary.skills, ["order-status"]);
});

await step("AI-25: Try it calls the draft's action for real; the answer can become a card", async () => {
  const draft = files({ "tools/who_am_i.yaml": `description: Echo the customer\nurl: ${ECHO_URL}/me/{user.id}\nheaders:\n  Authorization: Bearer {user.secrets.TOKEN}\n` });
  const res = await agent.call(`/workspaces/${workspaceId}/agent/try-action`, { body: { files: draft, name: "lookup_order", input: { orderNumber: "A-1042" } } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.status, "ok", JSON.stringify(res.json));
  assert.equal(res.json.httpStatus, 200);
  // httpbin gives "shipped", go-httpbin (httpbingo.org) ["shipped"].
  assert.equal([res.json.result.args.status].flat()[0], "shipped");
  assert.match(res.json.result.url, /\/orders\/A-1042/);
  const card = JSON.parse(cardFromResult("Lookup order", res.json.result)!);
  assert.equal([card.sample.args.eta].flat()[0], "Friday");
  // A test customer for {user.*}; their key is masked in what comes back.
  const me = await agent.call(`/workspaces/${workspaceId}/agent/try-action`, { body: { files: draft, name: "who_am_i", input: {}, customer: { id: "cus_9", secrets: { TOKEN: "tok_e2e_secret_value" } } } });
  assert.equal(me.json.status, "ok", JSON.stringify(me.json));
  assert.match(me.json.result.url, /\/me\/cus_9/);
  assert.ok(!JSON.stringify(me.json).includes("tok_e2e_secret_value"));
  assert.equal((await agent.call(`/workspaces/${workspaceId}/agent/try-action`, { body: { files: draft, name: "nope", input: {} } })).status, 400);
});

await step("dashboard edits and CLI pushes don't silently overwrite each other", async () => {
  // Dashboard save from a stale base: conflict.
  const stale = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: files(), base: version - 1 || null, message: "stale" } });
  assert.equal(stale.status, 409);
  const dash = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: files({ "README.md": "edited in the dashboard" }), base: version, message: "dashboard edit" } });
  assert.equal(dash.status, 200, JSON.stringify(dash.json));
  // A CLI push based on the version before the dashboard edit would lose it: conflict.
  const anon = new Client();
  const cli = await anon.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", headers: bearer(), body: { files: files(), base: version, message: "cli" } });
  assert.equal(cli.status, 409);
  assert.equal(cli.json.error.current, dash.json.version);
  version = dash.json.version;
  const versions = (await agent.call(`/workspaces/${workspaceId}/agent`)).json.versions;
  assert.deepEqual(versions.slice(0, 2).map((v: { source: string }) => v.source), ["dashboard", "cli"]);
});

await step("the live AI calls the HTTP tool and the call is in the audit log (agents only)", async () => {
  const visitor = new Client();
  const vtoken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
  const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Hi, where is my order A-1042?" }, headers: { "X-Visitor-Token": vtoken } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const conversationId = res.json.conversation.id as string;
  const visitorSocket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [vtoken] });
  const agentSocket = new TestSocket(`/api/conversations/${conversationId}/ws?since=1`, { headers: { cookie: cookieHeader(agent) } });
  await Promise.all([visitorSocket.opened, agentSocket.opened]);
  const event = await visitorSocket.next(
    (e) => (e.type === "message" && ["ai", "system"].includes(e.message.authorType)) || (e.type === "messages" && e.messages.some((m: { authorType: string }) => ["ai", "system"].includes(m.authorType))),
    AI_TIMEOUT,
  );
  const reply = event.type === "message" ? event.message : event.messages.find((m: { authorType: string }) => ["ai", "system"].includes(m.authorType));
  assert.equal(reply.authorType, "ai", `expected an answer, got: ${reply.body}`);
  assert.match(reply.body, /shipped|friday/i, reply.body);
  assert.equal(reply.meta.configVersion, version);

  const actions = (await agent.call(`/conversations/${conversationId}/actions`)).json.actions;
  const call = actions.find((a: { tool: string }) => a.tool === "lookup_order");
  assert.ok(call, JSON.stringify(actions));
  assert.equal(call.status, "ok");
  assert.equal(call.input.orderNumber, "A-1042");
  assert.equal(call.httpStatus, 200);
  assert.equal(call.configVersion, version);
  // Visitors never see tool activity.
  assert.ok(!visitorSocket.events.some((e) => e.type === "ai_action"));
  assert.equal((await new Client().call(`/conversations/${conversationId}/actions`)).status, 401);
  visitorSocket.close();
  agentSocket.close();
});

await step("eval streams test-case results and replays recent conversations", async () => {
  const response = await fetch(`${BASE}/api/workspaces/${workspaceId}/agent/eval`, {
    method: "POST",
    headers: { ...bearer(), "content-type": "application/json" },
    body: JSON.stringify({ files: files({ "AGENTS.md": "---\nmaxReplies: 6\n---\nAlways sign off with: Cheers, the Acme team." }), sample: 2, mockTools: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /ndjson/);
  const events = (await response.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].type, "start");
  assert.equal(events[0].cases, 2);
  assert.ok(events[0].conversations >= 1);
  const human = events.find((e) => e.type === "case" && e.name === "asks for a human");
  assert.equal(human.pass, true, JSON.stringify(human));
  const tool = events.find((e) => e.type === "case" && e.name === "order status uses the tool");
  assert.ok(tool.result.tools.includes("lookup_order"), JSON.stringify(tool));
  const replays = events.filter((e) => e.type === "replay");
  assert.ok(replays.length >= 1, JSON.stringify(events));
  for (const r of replays) assert.ok(["same", "changed"].includes(r.verdict));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.replay.same + done.replay.changed + done.replay.errors, replays.length + done.replay.errors);
});

await step("eval refuses an invalid config", async () => {
  const res = await new Client().call(`/workspaces/${workspaceId}/agent/eval`, { headers: bearer(), body: { files: { "AGENTS.md": "x", "skills/a/SKILL.md": "no frontmatter" } } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "invalid_config");
});

const run = promisify(execFile);
async function jun(args: string[], env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["packages/cli/src/index.ts", ...args], { env: { ...process.env, ...env }, timeout: AI_TIMEOUT });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

await step("the jun CLI: login, init, push, pull and eval", async () => {
  const home = await mkdtemp(join(tmpdir(), "jun-home-"));
  const dir = await mkdtemp(join(tmpdir(), "jun-agent-"));
  const env = { JUN_HOME: home };

  const login = await jun(["login", BASE, "--token", token], env);
  assert.equal(login.code, 0, login.out);
  assert.match(login.out, /Logged in to/);

  // init refuses a non-empty folder; pull fills one with the live config.
  assert.equal((await jun(["init", join(dir, "fresh")], env)).code, 0);
  assert.match(await readFile(join(dir, "fresh", "skills", "refund", "SKILL.md"), "utf8"), /name: refund/);

  const pull = await jun(["pull", join(dir, "live")], env);
  assert.equal(pull.code, 0, pull.out);
  assert.equal((await readFile(join(dir, "live", ".jun-version"), "utf8")).trim(), String(version));
  assert.match(await readFile(join(dir, "live", "tools", "lookup_order.yaml"), "utf8"), /orderNumber/);

  await writeFile(join(dir, "live", "AGENTS.md"), "---\nmaxReplies: 5\n---\nBe brief and friendly. Pushed from the CLI.");
  const push = await jun(["push", join(dir, "live"), "-m", "from the CLI"], env);
  assert.equal(push.code, 0, push.out);
  assert.match(push.out, /Pushed version \d+/);
  const live = (await agent.call(`/workspaces/${workspaceId}/agent`)).json;
  assert.match(live.files["AGENTS.md"], /Pushed from the CLI/);
  assert.equal(live.versions[0].message, "from the CLI");
  assert.equal(live.versions[0].source, "cli");

  await writeFile(join(dir, "live", "tools", "broken.yaml"), "url: ftp://nope");
  const rejected = await jun(["push", join(dir, "live")], env);
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /tools\/broken\.yaml/);

  const evalRun = await jun(["eval", join(dir, "fresh"), "--sample", "0", "--mock-tools"], env);
  assert.match(evalRun.out, /asks for a human/, evalRun.out);
  assert.match(evalRun.out, /Cases: \d+ passed, \d+ failed/, evalRun.out);
});

await step("AI-24: an action that isn't set up (a key not added) is never offered to the AI; adding the key fixes it", async () => {
  const live = (await agent.call(`/workspaces/${workspaceId}/agent`)).json;
  const tool = `description: Tracks a parcel by its tracking number and returns where it is. Use it whenever someone asks where their parcel is.
url: ${ECHO_URL}/parcels/{tracking}
headers:
  Authorization: Bearer {secrets.PARCEL_KEY}
input:
  tracking: { type: string, description: "The tracking number, like ZX-99" }
`;
  const saved = await agent.call(`/workspaces/${workspaceId}/agent`, { method: "PUT", body: { files: { ...live.files, "tools/track_parcel.yaml": tool }, base: live.version, message: "track_parcel" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const ask = async () => {
    const visitor = new Client();
    const vtoken = (await visitor.call(`/widget/${widgetKey}/visitor`, { body: {} })).json.token as string;
    const res = await visitor.call(`/widget/${widgetKey}/conversations`, { body: { clientMsgId: crypto.randomUUID(), body: "Where is my parcel ZX-99?" }, headers: { "X-Visitor-Token": vtoken } });
    const conversationId = res.json.conversation.id as string;
    const socket = new TestSocket(`/api/widget/${widgetKey}/conversations/${conversationId}/ws?since=1`, { protocols: [vtoken] });
    await socket.opened;
    await socket.next((e) => (e.type === "message" && ["ai", "system"].includes(e.message.authorType)) || (e.type === "messages" && e.messages.some((m: { authorType: string }) => ["ai", "system"].includes(m.authorType))), AI_TIMEOUT);
    socket.close();
    return (await agent.call(`/conversations/${conversationId}/actions`)).json.actions as { tool: string; status: string }[];
  };
  const before = await ask();
  assert.ok(!before.some((a) => a.tool === "track_parcel"), JSON.stringify(before));
  assert.equal((await agent.call(`/workspaces/${workspaceId}/action-secrets/PARCEL_KEY`, { method: "PUT", body: { value: "parcel_key_123456" } })).status, 200);
  const after = await ask();
  assert.equal(after.find((a) => a.tool === "track_parcel")?.status, "ok", JSON.stringify(after));
  await agent.call(`/workspaces/${workspaceId}/action-secrets/PARCEL_KEY`, { method: "DELETE" });
  // API tokens (the CLI) can't read or change keys.
  assert.equal((await fetch(`${BASE}/api/workspaces/${workspaceId}/action-secrets`, { headers: bearer() })).status, 401);
});

summary();
