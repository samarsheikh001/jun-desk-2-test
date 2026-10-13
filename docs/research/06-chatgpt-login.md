# 06 — "Login with ChatGPT" as the AI backend

*As of 2026-10-04. Question: can the person deploying Jun Desk sign in with their ChatGPT account and have the desk's AI run on that subscription instead of an API key?*

## Verdict

**Not for the live support agent.** It works officially only for open-source, *locally hosted* apps. Remotely hosted apps (like a Worker answering website visitors) need OpenAI's approval, and the plan's caps make it a poor fit even then. Offer OpenAI as a **bring-your-own-API-key** provider instead.

**Possible exception:** the local eval CLI (`jun eval`, AI-19) *is* a locally hosted open-source app, so "Sign in with ChatGPT" could legitimately power it.

## Does being open source qualify us? (checked 2026-10-04)

Re-read OpenAI's pages directly after the user pointed out that Jun Desk is open source.

- **Open source gets us into the program.** "Your open-source app can request permission to use the user's ChatGPT plan" ([source](https://developers.openai.com/siwc/token-sharing-open-source)).
- **It doesn't cover hosted deployments.** Same page: the docs cover "open-source **and** locally hosted apps. If you're interested in offering it in a paid or **remotely hosted** app, complete the interest form." A self-hosted Jun Desk on Cloudflare serving website visitors is remotely hosted.
- **The flow technically requires the user's own machine.** Redirect must be `http://127.0.0.1:<port>/callback` ("Do not substitute with `localhost`"). There's no HTTPS or server redirect in the documented flow ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)). A Worker can't receive a loopback callback.
- **Plan usage is per signed-in user.** Credentials are bound to "verified account identity" and a per-host `ext_agent_host_id`. Nothing authorizes spending one person's plan on requests for other people (website visitors).
- One fetch summarised the overview as mentioning self-hosted VMs; the sign-in page itself does not *(unverified)*.

**Conclusion:** open source + locally run (the `jun eval` CLI) = allowed today. Open source + hosted (the live agent) = needs OpenAI approval via the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/). Applying is free; being open source may help.

## What exists officially

- **Codex CLI** supports "Sign in with ChatGPT" (browser OAuth or device code) or an API key ([docs](https://developers.openai.com/codex/cli), [CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth/)).
- **Sign in with ChatGPT for third-party apps** (DevDay, 2026-09-29): Plus/Pro users can spend their plan in third-party apps via OAuth scope `chatgpt.tokens.use.direct`, with a per-app weekly cap the user sets. Partners include Notion, Vercel, Devin ([overview](https://developers.openai.com/siwc/quickstart), [WorkOS](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope), [The Star](https://www.thestar.com.my/tech/tech-news/2026/10/04/openai-expands-chatgpt-with-apps-and-third-party-sign-in)).
  - Open-source docs cover "open-source and locally hosted apps. If you're interested in offering it in a **paid or remotely hosted app**, complete the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)" ([source](https://developers.openai.com/siwc/token-sharing-open-source)).
  - Open-source path: loopback redirect only (`http://127.0.0.1:…/callback`), PKCE, dynamic client registration ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)). Built for a user's own requests, not for serving third parties (our reading).

## Limits of plan-funded calls

([preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference))

- Responses API only; `stream: true` and `store: false` required.
- No system-role messages, `temperature` or `max_output_tokens`. No file search, code interpreter, hosted MCP, background mode. Function calling / structured output support *(unverified)*.
- Access tokens 1 h, rotating refresh tokens 30 days.
- Limits return HTTP 429 `subscription_sharing_usage_limit_exceeded` (doesn't say which limit). Plus has a 5-hour window shared across all connected apps. Apps aren't notified when a user disconnects.
- Personal Plus/Pro only; no Business/Enterprise admin controls *(unverified — help pages returned 403)*.
- **For a support desk:** capacity capped by one person's plan, 429s mid-conversation, and an OAuth flow a Worker can't complete.

## Community hacks (don't use)

opencode plugins ([numman-ali](https://github.com/numman-ali/opencode-openai-codex-auth), [open-hax](https://github.com/open-hax/codex), [cortexkit](https://github.com/cortexkit/openai-auth)), OpenClaw, [vec4me](https://github.com/vec4me/openai-codex-auth) reuse the Codex token against ChatGPT's `backend-api`. Their own READMEs say personal use only. OpenAI tolerates rather than blocks them ([MindStudio](https://www.mindstudio.ai/blog/anthropic-restricts-third-party-agents-openai-opens-codex-comparison)), but they depend on mimicking Codex requests and can break any time. Reported unexplained bans ([forum](https://community.openai.com/t/codex-chatgpt-pro-account-banned-with-no-warning-no-explanation-18-month-subscriber/1381906), *unverified link to these tools*). OpenAI's new docs: "Do not point it at ChatGPT's `backend-api` endpoints."

## Terms

Consumer terms prohibit "Automatically or programmatically extracting data or Output" and making "your account available to anyone else" ([EU Terms](https://openai.com/policies/eu-terms-of-use/); main terms page returned 403, relying on excerpts with the same wording). Answering a stream of website visitors on one person's plan conflicts with both. The API's business terms are written for building products that serve end users (current text not re-read).

## The legitimate route: OpenAI API key

- Responses API with a project-scoped key the deployer pastes in (prompted as a secret at deploy). There's no OAuth "connect your OpenAI Platform account" flow for API billing.
- **Cloudflare AI Gateway** supports OpenAI Chat Completions and Responses, BYOK stored keys, caching, logs and fallback ([docs](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)). Workers AI hosts OpenAI's open-weight gpt-oss models (from memory, *unverified*).
- Pricing per 1M tokens from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) as reported by the research agent: gpt-6-luna $0.10 in / $0.50 out, gpt-6.1-sol $2 / $10, gpt-6-astra $10 / $50, gpt-5.4-mini $0.75 / $4.50. **Model names not cross-checked; confirm before hard-coding.**
