# v1 build plan

*Drafted 2026-10-04. Orders the 56 `v1` features from `features.md` into milestones. Each milestone ends in something you can demo.*

**Principles**

1. **The deploy button works from day one.** One-click deploy is a hard constraint (D-02). We keep it green on every milestone instead of bolting it on at the end.
2. **Get a working conversation early, then add pillars.** The order is chat → AI → handoff → P1 → P3 → polish.
3. **P1 (support that sees the bug) comes before visitor tracking and inbox polish**, because it's the lead pillar (D-12).
4. **Slack stays late and small** (secondary channel; only C-09 is in v1).

**Size** is a rough relative guess (S / M / L), not an estimate. We'll size properly once the repo exists.

**🚀 = launch-critical.** If time runs short, unmarked items can slip to v1.1 without hurting the launch story.

---

## M0 — Foundation

> **Status 2026-10-04: deployed** to https://jun-desk.samarsheikh001.workers.dev via `npm run deploy` (D1 auto-provisioned, migrations applied, SETUP_TOKEN set). Passkey auth passes an 11-step e2e test locally. Owner setup and sign-in verified with a real passkey on the live site. Still to do: the Deploy button itself (repo is private), CLA bot setup.

*Demo: click "Deploy to Cloudflare" → an empty Jun Desk is live, and you can log in.*

| ID | Feature | Size | |
|---|---|---|---|
| T-09 | Deploy-to-Cloudflare button (D1, DOs, Vectorize, R2, Workers AI provisioned) | M | 🚀 |
| T-07 | Repo layout, licenses (AGPL server, MIT widget/SDK), CLA bot | S | 🚀 |
| T-01 | Workspaces, members, roles; multi-workspace schema from day one (D-09) | M | 🚀 |
| T-02 | Built-in auth: passkeys (D-17) | M | 🚀 |
| T-12 | D1 migrations run automatically on deploy/upgrade | S | 🚀 |

**Decided 2026-10-04** (see `decisions.md`):
- **D-11 data layer.** Recommendation: D1 is the source of truth for conversations and messages; each conversation's Durable Object holds live state (sockets, typing, the agent loop) and writes through to D1.
- **D-05 tickets.** Recommendation: one `conversation` table with a type flag.
- **Repo layout.** The deploy button needs a self-contained Workers app. Recommendation: the deployable Worker sits at the repo root; the widget and SDK are packages whose builds go into the Worker's static assets.

## M1 — Conversation loop (no AI yet)

> **Status 2026-10-04: built and tested locally.** API e2e (14 steps) and a real-browser run (headless Chrome: passkey sign-in, widget on the demo page, live reply, typing, "Seen", resolve) pass. Two Durable Objects: `Conversation` (per conversation) and `WorkspaceHub` (per workspace, inbox fan-out + presence). Not yet deployed (adds an R2 bucket).

*Demo: a visitor on a test site chats, and an agent replies from the inbox in real time.*

| ID | Feature | Size | |
|---|---|---|---|
| C-01 | Web widget channel | — | 🚀 |
| W-01 | Loader under 6 KB (was 5 KB, D-38) with a stand-in bubble | M | 🚀 |
| W-02 | Widget isolated in an iframe or shadow DOM | S | 🚀 |
| I-01 | Real-time inbox with status views | L | 🚀 |
| I-03 | Typing indicators, read receipts, agent presence | S | 🚀 |
| W-05 | History for returning visitors | S | 🚀 |
| W-06 | Attachments (R2) | S | 🚀 |
| I-02 | Manual assignment (round-robin and capacity → v1.1) | S | 🚀 |

## M2 — AI agent answers

> **Status 2026-10-04: built and tested locally.** e2e-ai (10 steps, real Workers AI models) and a headless-Chrome run pass: grounded answer with citation, streaming, handoff on "talk to a person" / staff-only asks / cap, takeover, permissions. Vector search runs in a per-workspace `KnowledgeIndex` DO instead of Vectorize (D-18). Not deployed yet (adds a Queue and a DO class).

*Demo: crawl a docs site, ask a question in the widget, and get a streamed answer with citations.*

| ID | Feature | Size | |
|---|---|---|---|
| T-10 | LLM provider: Claude BYO key, Workers AI fallback | S | 🚀 |
| K-01 | Website crawl with scheduled re-sync | M | 🚀 |
| K-03 | Manual Q&A snippets | S | 🚀 |
| K-02 | File upload (PDF, MD, TXT first; DOCX can slip) | S | |
| AI-01 | Answers grounded in the KB, with citations | M | 🚀 |
| AI-02 | "I don't know" when confidence is low | S | 🚀 |
| AI-07 | Persona and tone instructions | S | 🚀 |
| AI-08 | Prompt-injection and abuse guardrails | S | 🚀 |
| W-03 | Streaming with resumable streams | M | 🚀 |
| B-03 | LLM spend caps; degrades to "leave a message" | S | 🚀 |
| AI-16 | Model routing (Haiku triage → Sonnet answers); one model is fine at first | S | |

**Decide before starting:** **D-10 default LLM.** Recommendation: Claude Sonnet 5.5 with the user's own key, falling back to Workers AI.

## M3 — Handoff to humans

*Demo: the AI can't solve the problem and hands off. The agent gets a brief in the inbox and in Slack, and replies from either.*

| ID | Feature | Size | |
|---|---|---|---|
| W-07 | "Talk to a human" always visible | S | 🚀 |
| AI-03 | Escalation rules | S | 🚀 |
| AI-04 | Structured handoff brief | S | 🚀 |
| I-04 | Agent takeover / barge-in | S | 🚀 |
| C-09 | Team replies from Slack (handed-off chats only) | M | |
| T-13 | Slack app manifest + guided setup | S | |

## M4 — P1: support that sees the bug ⭐

> **Status 2026-10-04: built and tested locally.** In headless Chrome on the demo page: "Pay invoice" fails with a real 500 and a chart throws; the visitor asks "Why can't I pay my invoice?"; the AI answers "Your request to /api/demo/billing failed with a server error (500) at 21:11:42. I've flagged this to our team." and hands off; the agent sees both events in the debug panel. e2e-debug (6 steps) checks masking end to end. **This is the first good moment to show design partners.**

*Demo: the test site throws a 500 on /api/billing. The visitor asks "why can't I pay?" The AI answers "your request to /api/billing failed at 14:02, I've flagged it", and the agent sees the debug panel.*

| ID | Feature | Size | |
|---|---|---|---|
| S-01 | Capture JS errors and failed requests in the widget SDK | M | 🚀 |
| S-07 | PII masking for captured data (ships with S-01) | M | 🚀 |
| V-02 | Page-view trail per session | S | 🚀 |
| S-03 | Debug panel on each conversation | M | 🚀 |
| S-05 | AI uses debug context to diagnose | M | 🚀 |

## M5 — P3: support agent as code ⭐

*Demo: edit `support-agent/skills/refund/SKILL.md` in git, run `jun eval`, and see which past answers change before `jun push`.*

**Status (2026-10-05): deployed.** Engine and format: D-22.

| ID | Feature | Size | |
|---|---|---|---|
| AI-18 | Agent config as files in git; dashboard edits the same config | L | 🚀 |
| AI-05 | Custom tools via HTTP endpoints (defined in config) | M | 🚀 |
| AI-11 | Action audit log | S | 🚀 |
| AI-19 | Eval runner CLI: replay conversations, show answer diffs | M | 🚀 |

## M6 — Visitors and identity

*Demo: watch live visitors, see who's logged in (verified), and start a chat with one.*

**Status (2026-10-05): built locally, all tests pass (unit 57, e2e 60 incl. `e2e-visitors` 10, browser check of the real loader). Design: D-23.**

| ID | Feature | Size | |
|---|---|---|---|
| V-03 | JWT identity verification | S | 🚀 |
| V-04 | Merge anonymous visitor into contact on identify | S | 🚀 |
| V-05 | Custom attributes from host app | S | 🚀 |
| V-06 | Consent-aware mode (no cookies before consent) | S | 🚀 |
| V-01 | Live visitor list | M | 🚀 |
| V-07 | Agent starts a chat with a live visitor | S | |

## M7 — Inbox and widget polish

*Demo: it feels like a real product a team can use every day.*

**Status (2026-10-05): the four launch-critical items (I-08, W-04, I-10, K-04) are built and tested (unit 63, e2e 68 incl. `e2e-polish` 6). Inbox basics I-05, I-06, I-07 and offline email capture W-08 built and tested (unit 67, e2e 76 incl. `e2e-inbox` 8). CSAT W-12 built and tested (unit 69, e2e 80 incl. `e2e-inbox` 12). Core metrics A-01 built and tested (unit 80, e2e 86 incl. `e2e-metrics` 6). M7 is complete.**

| ID | Feature | Size | |
|---|---|---|---|
| I-08 | Contact sidebar (attributes, history, trail, debug context) | M | 🚀 |
| W-04 | Widget branding | S | 🚀 |
| I-10 | Business hours and auto-replies | S | 🚀 |
| K-04 | KB source management | M | 🚀 |
| I-05 | Internal notes and @mentions | S | |
| I-06 | Saved replies | S | |
| I-07 | Tags and attributes | S | |
| W-08 | Offline mode (collect email) | S | |
| W-12 | CSAT rating | S | |
| A-01 | Core metrics dashboard | M | |

## M8 — Launch

*Demo: a stranger goes from the README to a working AI desk on their own site in under 10 minutes.*

**Status (2026-10-05): T-11 and T-12 built and verified; README rewritten; launch drafts in `docs/launch/`. Waiting on: a public repo (to test the Deploy button), a demo video, posting.**

**Before launch (checklist):** CLA bot (D-14); test the Deploy button (the repo is public); demo video; post. *Backlog (D-81, 2026-10-13: no production launch for now):* re-gate ChatGPT sign-in and switch the default to an API key (D-27), only if the desk is launched for others.

**Order (2026-10-08):** done: widget polish (first-message remount, skeleton, scrollbars), the Visitors crash fix and a page error boundary in the desk. *Under consideration next:* CLA bot, demo video (could be recorded as a walkthrough of the desk), launch post. *Backlog until then:* retry the Deploy button (Cloudflare GitHub app needs access to all repos; delete the empty `jun-desk-test` repo first). Re-gating ChatGPT sign-in (D-27) is backlog, not a blocker (D-81).

| ID | Feature | Size | |
|---|---|---|---|
| T-11 | First-run setup wizard | M | 🚀 |
| T-12 | Upgrade path verified on a real older install | S | 🚀 |
| S-08 | Create a GitHub or Linear issue from a conversation (pulled in, D-26). Shipped 2026-10-05 | M | 🚀 |
| — | README, docs site, demo video, launch post (HN, GitHub) | M | 🚀 |

---

## Summary

- **56 v1 features: 45 launch-critical 🚀, 11 can slip to v1.1:** K-02, AI-16, C-09, T-13, V-07, I-05, I-06, I-07, W-08, W-12, A-01. T-12 appears in both M0 (migrations) and M8 (verified upgrade).
- **Critical path:** M0 → M1 → M2 → M3 → M4. After M2, M5 and M6 can run in parallel if there are two people.
- **Earliest "show someone" moment:** end of M4. That's when the lead pillar works end to end, so it's a good point to recruit design partners.

## Open before M0

- [x] D-11 data layer: D1 is the source of truth, Durable Objects hold live state (2026-10-04)
- [x] D-05 tickets: one conversation table with a type flag (2026-10-04)
- [x] Repo layout: Worker at the repo root, `packages/` built into its assets (2026-10-04)
- [x] All v1 features agreed (2026-10-04)
