# 03 — Architecture

*As of 2026-10-03. Unverified items listed at the end.*

## 1. Realtime transport

- **WebSockets** for widget and inbox — typing, presence, agent takeover/barge-in need two-way traffic. SSE is fine for a stateless "stream one AI reply" call.
- Plan for **resumable streams** (last-event ID per message) so reconnects don't drop half an answer ([websocket.org](https://websocket.org/guides/websockets-and-ai/), [Ably](https://dev.to/ablyblog/resume-tokens-and-last-event-ids-for-llm-streaming-how-they-work-what-they-cost-to-build-4l7e)).

| Option | Notes |
|---|---|
| **Cloudflare Durable Objects** | One object per conversation/workspace, single writer, SQLite. WebSocket Hibernation: idle sockets not billed for duration; inbound WS msgs billed 20:1, outbound free; $0.15/M requests, $12.50/M GB-s. Fits many mostly-idle widgets ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing), [WS](https://developers.cloudflare.com/durable-objects/best-practices/websockets)). |
| PartyKit | Acquired by Cloudflare (2024); effectively a DO abstraction (*unverified scope*). |
| **Ably** | Ordering, history, multi-region; "AI Transport" with resumable token streams and a Vercel AI SDK transport ([blog](https://ably.com/blog/custom-transport-vercel-ai-sdk)). |
| Pusher | Simpler, fewer guarantees, from ~$49/mo (*third-party*). |
| Liveblocks | Per-MAU — every anonymous visitor counts. Poor fit ([buildmvpfast](https://www.buildmvpfast.com/api-costs/realtime)). |
| Supabase Realtime | Presence limits: 5 updates/30s per client; 50 msg/s on Pro. OK for agent online status; visitor tracking needs Broadcast or batching ([limits](https://supabase.com/docs/guides/realtime/limits)). |
| Convex | Every query is live — trivial inbox UI — but locks you into its DB ([kanopylabs](https://kanopylabs.com/blog/convex-vs-supabase-vs-neon-realtime-backends)). |

**Presence at scale:** keep per-pageview presence in memory (DO or Redis TTL); flush aggregated sessions to Postgres.

## 2. AI agent layer

- **RAG pipeline:** crawl → clean → chunk by heading → embed into tenant-scoped namespaces.
  - Chatwoot Captain: FAQs with pgvector (IVFFlat); handoff = flip conversation pending → open ([deepwiki](https://deepwiki.com/chatwoot/chatwoot/9.1-captain-ai-system)).
  - Stores: **pgvector** (simplest with Postgres), Turbopuffer (no namespace limits, from $64/mo), Vectorize (50k namespaces, 5M vectors/index) ([firecrawl](https://www.firecrawl.dev/blog/best-vector-databases), *third-party*).
- **Tools/actions:** typed tools for lookups and actions; irreversible actions (refunds) require approval — AI SDK 6 has `needsApproval`.
- **MCP:** customer integrations as remote MCP servers; ship the desk itself as an MCP server.
- **Escalation triggers:** low confidence; customer asks for a human; N turns without resolution; deny-listed intent or risky/irreversible action; negative sentiment; prompt-injection detected. Hand over a structured brief: verified identity, intent, what was tried, suggested next step ([digitalapplied](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026)).
- **Evals:** replay sets built from resolved tickets; track resolution rate. Benchmark: Fin ~38% avg, 47–52% with strong docs ([builts.ai](https://builts.ai/blog/intercom-fin-ai-review/), *unverified*).
- **Frameworks:**
  - Vercel AI SDK 6 (Dec 2025): `ToolLoopAgent`, stable MCP with OAuth, tool approval ([guide](https://chatforest.com/builders-log/vercel-ai-sdk-6-builder-guide/)).
  - Cloudflare Agents SDK: `AIChatAgent` on a DO, up to 10 GB SQLite per agent, scheduler, MCP client+server ([docs](https://developers.cloudflare.com/agents/concepts/agent-class/)).
  - Claude Agent SDK: better for long-running heavy agent work than low-latency chat (judgment).

### Claude models ([docs](https://platform.claude.com/docs/en/about-claude/models/overview))

| Model | $ in / out per MTok | Context | Use |
|---|---|---|---|
| Haiku 4.5 | $1 / $5 | 200K | Routing, classification. Retirement no sooner than 2026-10-15; successor expected (*unverified*). |
| Sonnet 5.5 | $2 / $10 | 1M | Default answering model |
| Opus 5.5 | $4 / $20 | 1M | Hard cases, eval grading |
| Fable 5.1 | $10 / $50 | 1M | Not needed for support |

Prompt caching cuts repeated KB/system-prompt input to 10% of base price (5% on Opus 5.5).

## 3. Data model (draft)

- `workspace` → `member` (role, status, capacity) → `team`
- `inbox` (channel: widget/email; widget config)
- `contact` (identified) ← `visitor` (anonymous id; merged on identify)
- `session` / `pageview` (url, referrer, geo, UA, started/last seen; hot in memory, cold in DB)
- `conversation`: inbox, contact, status (`bot` / `pending` / `open` / `snoozed` / `resolved`), assignee, team, priority, `handoff_reason`, AI summary
- `message`: author_type (`visitor` / `agent` / `ai` / `system`), content parts (text, tool_call, tool_result, attachment), `client_msg_id` (idempotency), seq
- `ticket` — separate, or conversation with a type flag (LibreDesk converts conversations → tickets)
- `assignment_event`, `sla_policy` (first response / resolution targets, business hours), `sla_event` (due_at, breached_at)
- `kb_source` / `kb_document` / `kb_chunk` (embedding, namespace)
- `ai_action_log` (tool, args, approval, result) — audit + evals
- `csat`, `tag`, `note`, `audit_log`

## 4. Open-source references

- **Chatwoot** — Rails, Postgres (+pgvector, pg_trgm), Redis, Sidekiq, ActionCable; Redis pub/sub for presence/typing. Captain AI agent. Best overall model to study ([GitHub](https://github.com/chatwoot/chatwoot), [deepwiki](https://deepwiki.com/chatwoot/chatwoot)).
- **LibreDesk** (2025) — single Go binary + Vue, Postgres, Redis; SLAs, automations, CSAT. AGPL. Compact reference ([GitHub](https://github.com/abhinavxd/libredesk)).
- **Tiledesk** — Node/Angular, MongoDB, RabbitMQ over MQTT, Qdrant. Bot + human-in-the-loop flow builder ([schema](https://developer.tiledesk.com/architecture/schema)).
- **Papercups** — Elixir/Phoenix Channels + Presence; maintenance mode, but tidy realtime/widget design ([GitHub](https://github.com/papercups-io)).
- TGO — AI agent CS platform, seen only in roundups (*unverified*).

## 5. Candidate stacks

### A. All-Vercel: Next.js + Postgres (Neon/Supabase) + Ably/Supabase Realtime + AI SDK 6
- ➕ Familiar; one SQL DB with pgvector; Ably gives ordering/history/resumable streams; easy hiring.
- ➖ Serverless can't hold sockets → paid realtime vendor; long agent loops need Vercel Workflow/Inngest; visitor tracking write volume.

### B. Cloudflare: Workers + Durable Objects (`AIChatAgent` per conversation, DO per workspace for presence/inbox) + D1 or Postgres via Hyperdrive + Vectorize + R2
- ➕ Sockets, state, scheduling (SLA timers via alarms) and agent loop in one primitive; hibernation makes idle widgets ~free; edge latency; built-in MCP.
- ➖ Sharding is on us; D1 size limits → Postgres via Hyperdrive for reporting; weaker local tooling; Cloudflare lock-in.

### Recommendation — superseded
The original proposal was a hybrid of Postgres and Durable Objects. **Superseded 2026-10-03 by D-02 and D-03:** we're going all-Cloudflare with no external Postgres, so that one-click deploy works. See `04-cloudflare-self-host.md`.

## Unverified

Pusher/Liveblocks/Turbopuffer pricing; Fin resolution stats; TGO architecture; PartyKit scope post-acquisition; Haiku successor timing.
