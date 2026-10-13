# 04 — Open source, one-click deploy on Cloudflare

*As of 2026-10-03. Follows decisions D-02 and D-03.*

## Deploy to Cloudflare button

Source: [Cloudflare docs — Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

- **Auto-provisioned bindings:** KV, D1, R2, Hyperdrive, Vectorize, Secrets Store, Durable Objects, Workers AI, Queues. Everything our stack needs can be created by the button.
- **Secrets:** declared in `.dev.vars.example` / `.env.example`; the deployer is prompted for values at deploy time. Plain config goes in wrangler `vars`. Bindings can have descriptions in `package.json` (inline markdown) to guide the user.
- **Limitations:**
  - Workers only, not Pages. The dashboard must be served by the Worker (static assets), not a Pages project.
  - Public GitHub/GitLab repos only.
  - Monorepo: if the button URL points at a subdirectory, that app must be fully self-contained there, including dependencies. **This constrains repo layout.**
  - D1 migrations must reference the **binding name**, not the database name.

## Implications

- **No external Postgres.** Hyperdrive is provisionable, but it needs a Postgres the user hosts elsewhere, which breaks "one click". Default to **D1 + Durable Object SQLite**; Postgres via Hyperdrive could be an optional "scale" mode later.
- **LLM without keys:** Workers AI is provisioned automatically, so a fresh deploy can answer with zero API keys. Claude (BYO Anthropic key, prompted as a secret) should be the recommended quality option. → D-10.
- **Vectorize** replaces pgvector for the knowledge base.
- **R2** for attachments and (later) replay snippets.
- **Email:** Cloudflare Email Service for magic links and notifications (to verify at build time).

## D1 limits

Source: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

| Limit | Free | Workers Paid |
|---|---|---|
| Max DB size | 500 MB | 10 GB |
| DBs per account | 10 | 50,000 |
| Storage per account | 5 GB | 1 TB |
| Queries per Worker invocation | 50 | 1,000 |

- Max 100 bound parameters per query, 100 columns per table, 2 MB rows, 30 s query timeout.
- **Each D1 database is single-threaded** — queries run one at a time. Hot paths (presence, typing, message fan-out) must stay in Durable Objects; D1 holds durable records and reporting.
- For a self-hosted install (one company), 10 GB is plenty for conversations and metadata. Page-view firehose must be aggregated, not stored raw.

## Open source references on Cloudflare

- Cloudflare Agents SDK `AIChatAgent` — per-conversation agent on a DO, SQLite up to 10 GB per agent, scheduler, MCP client/server ([docs](https://developers.cloudflare.com/agents/concepts/agent-class/)).
- To research next: whether Durable Objects (SQLite-backed) are usable on the Workers **Free** plan, i.e. can someone self-host at $0? *(unverified)*

## CPU time: the AI needs Workers Paid

*As of 2026-10-12.* Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

| | Workers Free | Workers Paid |
|---|---|---|
| CPU time per HTTP request | 10 ms | 30 s by default, up to 5 min |
| Price | $0 | from $5/month per account |
| Queues | 10,000 operations/day | 1M operations/month included |

Over the limit, Cloudflare answers with its own error page, **error 1102 "Worker exceeded resource limits"** (we saw it as HTTP 503), not the Worker's JSON.

**Measured on the owner's live desk (2026-10-11, `wrangler tail`):** one widget edit through the Agent page's AI chat (ChatGPT, streamed) used 772–950 ms of CPU when it finished; two of four runs were stopped at 285 ms and at 12 ms (`exceededCpu`). Our own work in that request takes about 1 ms (timed on the same files); the rest is reading the model's streamed answer (the AI SDK handles every streamed event). Free lets some overruns through, which is why it fails only now and then. Any AI reply streams the same way, so on Free the AI is unreliable; the inbox, widget and visitor features fit. Decision: D-61.
