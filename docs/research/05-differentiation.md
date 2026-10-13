# 05 — Differentiation: what's actually unclaimed

*As of 2026-10-03. Goal: test our differentiators against what already exists, then pick the pillars we lead with.*

## Validation of candidate differentiators

| # | Candidate | Verdict | Who's there |
|---|---|---|---|
| 1 | One-click self-host on Cloudflare, no servers | **Partially claimed** by tiny projects | ResolveHQ, Supportly-Ai, GhostChat (details below). Established OSS desks all need Postgres + Redis |
| 2 | Struggle detection inside the support widget | **Claimed commercially (Gleap)**; no OSS desk does it | Gleap (closed backend), Marker.io/Userback (feedback tools, not desks), Jam (Intercom add-on) |
| 3 | AI diagnoses from debug context, files issue | **Claimed commercially (Gleap Kai)**; no OSS | Gleap Kai Resolve + Kai Code (ticket → PR) |
| 4 | Data ownership, BYO LLM key, consent-first | **Partially claimed**; weak as a headline | Chatwoot BYO key (paid edition), GhostChat cookieless |
| 5 | Support agent as code, evals in CI | **Enterprise-only (Sierra)**; unclaimed in OSS desks | Sierra Agent SDK (gated), Parlant/Botpress (frameworks, not desks) |
| 6 | Near-zero idle cost | **Real but small in $** | Chatwoot ≈ €8–25/mo VPS + ops burden vs Cloudflare $0–5/mo |

### Details

**1 — Cloudflare-native competitors**
- [ResolveHQ](https://github.com/mirza-rizvi/ResolveHQ): ~202 stars, source-available (not OSI). Email-first helpdesk on Workers/D1/R2/Queues with optional AI drafting, claims Free plan. No live chat widget or Deploy button found. Created date listed as Oct 2026, which doesn't fit 202 stars *(unverified)*. **Closest competitor; watch it.**
- [Supportly-Ai](https://github.com/templefour/Supportly-Ai): ~35 stars, no license. Widget, Telegram, KB auto-reply, handoff on Workers/D1/R2/DO/Workers AI. MVP fork, no Deploy button.
- [GhostChat](https://dev.to/jorbach/how-i-built-a-10kb-embeddable-chat-widget-on-cloudflare-workers-37i8): 10 KB widget on Workers + DOs, webhook handoff, no inbox. Markets cookieless GDPR ([site](https://ghostchat.dev/gdpr-chat-widget)).
- Chatwoot (~34k stars) offers one-click deploys on Heroku/DO/Railway, but needs Postgres + Redis. LibreDesk (3.0k, AGPL) is one binary + Postgres + Redis.

→ "First" is gone; **"the serious, full-featured one"** is open.

**2/3 — Gleap is the real comparable**
- SDK (MIT) captures console errors, unhandled rejections, network requests with status/payload/timing, and session replay ([product](https://www.gleap.ai/product/in-app-bug-reporting), [SDK PR](https://github.com/GleapSDK/JavaScript-SDK/pull/154)). Rage-click auto-reports per one AppSumo listing *(unverified)*; no dead-click evidence.
- Kai Resolve "reads the logs and events before anyone asks the customer a question"; native Linear/Jira/GitHub ([platform](https://www.gleap.ai/platform)). Kai Code turns tickets into PRs ([kai-code](https://www.gleap.ai/kai-code)).
- Backend is closed and hosted. **Our angle: open-source, self-hosted Gleap-class debugging inside a full support desk.**
- Crisp, Chatwoot, Pylon, Plain: no native capture found. Pylon's widget records URL only.

**5 — Agent as code**
- [Sierra Agent SDK](https://x.com/SierraPlatform/status/1956374601254027516): journeys as code, version control, GitHub Actions CI, simulation tests (Ramp is a reference). Contracted customers only.
- [Parlant](https://github.com/emcie-co/parlant) (18.3k stars, Apache-2.0): agent framework in Python, no inbox or widget. Botpress ADK: evals in CI.
- No OSS help desk ships agent config in the repo with evals in CI.

**6 — Cost**
- Chatwoot needs 4 GB RAM minimum + swap + Postgres storage ([requirements](https://developers.chatwoot.com/self-hosted/deployment/requirements)). Measured idle ≈ 810 MB (Rails 373, Sidekiq 381, Postgres 44, Redis 12).
- Cheapest working setup ≈ €7.50/mo ([guide](https://dev.to/pavel-hostim/how-to-self-host-chatwoot-in-2026-after-the-cloud-api-paywall-59ap)). Real cost is ops: pool exhaustion, Redis eviction, log rotation ([operator report](https://dev.to/achiya-automation/i-measured-what-self-hosted-chatwoot-actually-uses-348703-messages-18-gb-of-ram-4cp1)).
- → Sell **"no server to babysit"**, not the dollar saving. Cloudflare $5/mo Workers Paid figure *(unverified this session)*.

### OSS AI-support competitors (2025–26)

| Project | Stars | Notes |
|---|---|---|
| Chatwoot | ~34k | The incumbent; Captain AI (paid edition) |
| Parlant | 18.3k | Agent framework, not a desk |
| LibreDesk | 3.0k | AI assistant + copilot; Postgres + Redis; AGPL |
| TGO | 623 | AI agent customer service |
| KoalaQA | 554 | Chinese-language |
| AgentDesk (huabeitech) | 258 | Go/Next.js, RAG, MCP, handoff; Apache-2.0 |
| ResolveHQ | 202 | Cloudflare-native, email-first |
| Supportly-Ai | 35 | Cloudflare-native MVP |
| Helpin | 6 | "Intercom + Fin + Linear" alternative; AGPL |

---

## Positioning thesis (proposed)

**Nobody combines these. Each pillar alone is partly taken; together they're unclaimed.**

> **Jun Desk — the open-source support desk that sees the bug.**
> AI support for B2B SaaS that knows what broke before the customer finishes typing — and lives in your own Cloudflare account, in one click.

### Pillar 1 — "Support that sees the bug" (lead pillar)
Open-source answer to Gleap, inside a real desk.
- The widget captures JS errors, failed requests, rage/dead clicks and the page trail (S-01, S-02).
- The AI uses them to diagnose: *"Your request to /api/billing returned 500 at 14:02. I've flagged it to engineering."* (S-05, S-06)
- One click files a Linear/GitHub issue with repro context (S-08).
- Why it wins with B2B SaaS: their support tickets *are* bug reports. Every competitor except Gleap makes the agent ask "what browser are you on?"

### Pillar 2 — "Your desk, your Cloudflare"
- Deploy button → working AI desk in minutes (T-09, T-11). No Postgres, Redis or server to babysit.
- Idle cost ≈ $0; conversations and debug data never leave your account; BYO Claude key or zero-key Workers AI.
- Consent-first, sub-6 KB widget (5 KB until D-38) (W-01, V-06) as supporting proof points.
- Why it wins: Chatwoot is the default OSS choice, and its self-host is a 4 GB VPS + on-call burden.

### Pillar 3 — "Support agent as code"
- Procedures, persona, tools and guardrails live as files in the user's repo (git-versioned, reviewed in PRs).
- Evals (replay past conversations) run in CI before a change ships; PR comment shows answer diffs.
- The dashboard edits the same config, so non-devs aren't locked out.
- Why it wins: Sierra has this for six-figure enterprise contracts; no OSS desk has it. Developer audience = exactly who deploys to Cloudflare.

### Supporting points, not headlines
- Honest AI: citations, "I don't know", always-visible human handoff (AI-01, AI-02, W-07).
- Fast, private widget (W-01, V-06).

### What we deliberately don't compete on
- Channel breadth (Fin, Pylon) — web + Slack + email is enough for B2B SaaS.
- Voice (Sierra, Decagon).
- Enterprise procurement (SOC 2, SSO) until later.

## Implication for versions (proposal, needs user decision)

The current v1 is "a good OSS desk on Cloudflare", which only shows Pillar 2. Pillars 1 and 3 sit in v2. If launch is when we get attention (Hacker News, GitHub stars), v1 should **demo all three pillars, even thinly**:

- Pull a thin slice of Pillar 1 into v1: S-01 (errors + failed requests), S-03 (debug panel), S-07 (masking), and a basic S-05 (AI uses the context).
- Pull a thin slice of Pillar 3 into v1: AI-18 (config as code), basic AI-19 (eval runner CLI). CI integration can wait for v2.
- To make room, consider pushing some v1 inbox polish to v1.1 (e.g. I-02 round-robin/capacity, I-13 command palette, I-14 push).

## Risks

- **Gleap** could open-source or ship a self-hosted edition. Mitigation: we're a full desk, not a bug reporter with chat.
- **Chatwoot** could add a Cloudflare deploy or debug capture. Its Rails/Postgres architecture makes the former unlikely.
- **ResolveHQ** could add a widget and a Deploy button. It's email-first and source-available; we move faster on chat + debug.
- **Capture scope creep:** we must not become a session-replay product (N-08). Capture only what support needs, with PII masking from day one.
