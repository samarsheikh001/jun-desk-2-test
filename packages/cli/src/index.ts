#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  ChatGPTAuth,
  ChatGPTProvider,
  hasPlanUsageScope,
  LlmError,
  OpenAIProvider,
  type ChatMessage,
  type LlmProvider,
} from "@jun/llm";
import { evaluate, init, login, pull, push } from "./desk.ts";
import { loginWithChatGPT } from "./login.ts";
import { FileCredentialStore } from "./store.ts";

const HELP = `jun — Jun Desk developer CLI

Support agent as code (talks to your deployed desk):
  jun login <desk-url> [--token jun_…]   Connect to a desk with an API token (Settings → API tokens)
  jun init [dir]                         Start a config folder (default: support-agent)
  jun pull [dir]                         Download the desk's live agent config
  jun push [dir] [-m "message"]          Validate and make the folder's config live (--force overwrites dashboard edits)
  jun eval [dir]                         Run evals/*.yaml and replay recent conversations against the folder's config
      --sample <n>       conversations to replay (default 20, 0 to skip)
      --mock-tools       use each tool's mock: response instead of calling it
      --no-cases         skip evals/*.yaml          --json   one JSON event per line
      --fail-on-change   exit 1 if any replayed answer changes (for CI)
  In CI, set JUN_DESK_URL and JUN_DESK_TOKEN instead of running jun login.

Local LLM (development):
  jun login chatgpt [--no-browser]   Sign in with ChatGPT (dev only: uses your own plan)
  jun logout chatgpt                 Revoke and forget ChatGPT tokens
  jun whoami                         Show the signed-in ChatGPT account
  jun models                         List models available to your ChatGPT account
  jun ask "<question>"               Ask once and stream the answer
  jun chat                           Multi-turn chat in the terminal

Options for ask/chat:
  --provider chatgpt|openai   Default: chatgpt, or $JUN_LLM_PROVIDER
  --model <slug>              Default: $JUN_MODEL or the provider default
  --instructions "<text>"     System guidance for the assistant

The openai provider reads $OPENAI_API_KEY (and optional $OPENAI_BASE_URL, e.g. an AI Gateway URL).`;

function createProvider(name: string, model: string | undefined, store: FileCredentialStore): LlmProvider {
  const modelOption = model ? { model } : {};
  if (name === "chatgpt") return new ChatGPTProvider(new ChatGPTAuth(store), modelOption);
  if (name === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Set OPENAI_API_KEY to use --provider openai.");
    const baseUrl = process.env.OPENAI_BASE_URL;
    return new OpenAIProvider({ apiKey, ...modelOption, ...(baseUrl ? { baseUrl } : {}) });
  }
  throw new Error(`Unknown provider "${name}". Use chatgpt or openai.`);
}

async function streamToStdout(provider: LlmProvider, messages: ChatMessage[], instructions: string | undefined): Promise<string> {
  let answer = "";
  for await (const event of provider.stream({ messages, ...(instructions ? { instructions } : {}) })) {
    if (event.type === "text-delta") process.stdout.write(event.text);
    else answer = event.text;
  }
  process.stdout.write("\n");
  return answer;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      instructions: { type: "string" },
      "no-browser": { type: "boolean" },
      token: { type: "string" },
      message: { type: "string", short: "m" },
      force: { type: "boolean" },
      sample: { type: "string" },
      "mock-tools": { type: "boolean" },
      "no-cases": { type: "boolean" },
      json: { type: "boolean" },
      "fail-on-change": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  const store = new FileCredentialStore();

  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "login": {
      if (arg && /^https?:\/\//.test(arg)) {
        let token = values.token ?? process.env.JUN_DESK_TOKEN;
        if (!token) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          token = (await rl.question("API token (Settings → API tokens): ")).trim();
          rl.close();
        }
        const desk = await login(arg, token);
        console.log(`Logged in to ${desk.workspaceName} at ${desk.url} as ${desk.user}.`);
        return;
      }
      if (arg !== "chatgpt") throw new Error("Usage: jun login <desk-url>  or  jun login chatgpt");
      console.log("Note: ChatGPT sign-in is for local development only. Released builds use an OpenAI API key.\n");
      const result = await loginWithChatGPT(store, { openBrowser: !values["no-browser"] });
      console.log(`\nSigned in${result.email ? ` as ${result.email}` : ""}.${result.registered ? " (Registered this machine with OpenAI.)" : ""}`);
      console.log(`Credentials saved to ${store.path}`);
      return;
    }
    case "logout": {
      await new ChatGPTAuth(store).logout();
      console.log("Signed out of ChatGPT.");
      return;
    }
    case "whoami": {
      const tokens = (await store.load())?.tokens;
      if (!tokens) {
        console.log("Not signed in. Run `jun login chatgpt`.");
        return;
      }
      console.log(`ChatGPT account: ${tokens.email ?? "(unknown email)"}`);
      console.log(`Access token expires: ${new Date(tokens.expiresAt).toLocaleString()}`);
      console.log(`Plan usage granted: ${hasPlanUsageScope(tokens) ? "yes" : "no"}`);
      return;
    }
    case "models": {
      const provider = new ChatGPTProvider(new ChatGPTAuth(store));
      for (const model of await provider.listModels()) {
        console.log(model.displayName === model.slug ? model.slug : `${model.slug}  (${model.displayName})`);
      }
      return;
    }
    case "ask": {
      const question = positionals.slice(1).join(" ");
      if (!question) throw new Error('Usage: jun ask "<question>"');
      const provider = createProvider(values.provider ?? process.env.JUN_LLM_PROVIDER ?? "chatgpt", values.model ?? process.env.JUN_MODEL, store);
      await streamToStdout(provider, [{ role: "user", content: question }], values.instructions);
      return;
    }
    case "chat": {
      const provider = createProvider(values.provider ?? process.env.JUN_LLM_PROVIDER ?? "chatgpt", values.model ?? process.env.JUN_MODEL, store);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // History is sent with every request: plan usage requires store:false and no previous_response_id.
      const history: ChatMessage[] = [];
      console.log(`Chatting via ${provider.id}. Empty line or Ctrl+C to exit.`);
      try {
        while (true) {
          const line = (await rl.question("\nyou › ")).trim();
          if (!line) break;
          history.push({ role: "user", content: line });
          process.stdout.write("ai  › ");
          try {
            history.push({ role: "assistant", content: await streamToStdout(provider, history, values.instructions) });
          } catch (error) {
            history.pop();
            throw error;
          }
        }
      } finally {
        rl.close();
      }
      return;
    }
    case "init":
      return init(arg ?? "support-agent");
    case "pull":
      return pull(arg ?? "support-agent");
    case "push":
      return push(arg ?? "support-agent", { ...(values.message ? { message: values.message } : {}), force: Boolean(values.force) });
    case "eval":
      return evaluate(arg ?? "support-agent", {
        ...(values.sample !== undefined ? { sample: Number(values.sample) } : {}),
        mockTools: Boolean(values["mock-tools"]),
        cases: !values["no-cases"],
        replay: values.sample !== "0",
        json: Boolean(values.json),
        failOnChange: Boolean(values["fail-on-change"]),
      });
    default:
      throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof LlmError) console.error(`\nError (${error.code}): ${error.message}`);
  else console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
