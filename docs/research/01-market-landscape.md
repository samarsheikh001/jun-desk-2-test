# 01 — Market landscape

*As of 2026-10-03. Third-party/vendor figures are marked; unverified claims are flagged.*

## Summary

No product cleanly covers all three of: **cheap, fast visitor chat** + **AI agent that takes real actions** + **solid human inbox** for SMB/mid-market.

- Chatbase / Crisp: cheap, but AI and inbox are shallow.
- Fin (ex-Intercom) / Zendesk: strong, but per-resolution billing generates complaints.
- Decagon / Sierra: enterprise-only, six-figure contracts.

## Products

### Fin (formerly Intercom)
- Rebranded Intercom → Fin on 2026-05-12 ([source](https://www.intercom.com/blog/today-intercom-becomes-fin/)); Salesforce acquisition (~$3.6B) closed 2026-09-10 ([CNBC](https://www.cnbc.com/2026/06/15/salesforce-ai-customer-service-fin-acquistion.html)).
- **Procedures** (natural-language multi-step workflows Fin drafts from an outline), data connectors, simulations & regression tests, CX Score, proprietary "Apex" model.
- Channels: voice, email, Messenger, Slack, WhatsApp, SMS, Instagram; runs on top of Zendesk/Salesforce/HubSpot.
- Pricing: **$0.99 per "outcome"** (now includes procedure handoffs and routings, not just resolutions); qualifications $9.99; 50-outcome monthly minimum on third-party help desks ([fin.ai/pricing](https://fin.ai/pricing)).
- Proactive Procedures (Aug 2026) and Sales Agent "Lead Recovery" (May 2026) — see `02-visitor-experience.md`.

### Chatbase
- AI chatbot builder with help desk bolted on. Trains on docs/sites (1–40 MB by plan).
- "AI Actions" (tool calls): 1 / 10 / 20 per agent on Hobby / Standard / Pro. Help desk, voice, telephony, API, campaigns from Standard.
- Pricing: message credits — $40 / $150 / $500 per month; top-ups $40 per 1,000 credits ([chatbase.co/pricing](https://www.chatbase.co/pricing)).
- Strength: fastest time-to-bot. Weakness: inbox/handoff.

### Decagon (enterprise)
- Core unit: **Agent Operating Procedures (AOPs)** — natural-language workflows. **Duet** copilot builds agents; claims >70% of AOPs are written by it.
- Launched 2026-10-01 at Dialogues ([decagon.ai](https://decagon.ai/blog/dialogues-2026)): Voice 3 on its own duplex speech model "Chord"; **Personal Agent Gateway** (customers' own AI agents talk to the business); Agent Modules (sales, onboarding, collections); **Duet Apprentice** (learns from wikis and escalated conversations).
- Pricing unpublished; median contract ~$430K/yr per Vendr data ([getmacha](https://www.getmacha.com/blog/decagon-ai-complete-guide), *unverified*).

### Sierra (enterprise)
- "Agent OS". Channels: chat, voice, SMS, WhatsApp, email, ChatGPT. Voice is its biggest channel.
- **Ghostwriter** (Mar 2026) builds agents from SOPs, call transcripts, or whiteboard photos, 59 languages ([winbuzzer](https://winbuzzer.com/2026/03/26/sierra-ghostwriter-self-service-ai-agent-builder-xcxwbn/)).
- Outcome-based pricing, reportedly ~$1.50/resolution, contracts from ~$150K (*unverified*).

### Plain (B2B, developer-first)
- API-first, MCP support. Channels: Slack, email, in-app chat. **Ari** (customer-facing agent), **Sidekick** (agent copilot).
- $45 / $99 per seat + credit allowance; Ari resolution = 100 credits ([plain.com/pricing](https://www.plain.com/pricing)).

### Pylon (B2B)
- Built around shared Slack / Teams / Discord channels; also email, WhatsApp, Telegram, phone, SMS.
- Multiple agent types (Support, Assist, Background, Slack), reusable "Skills" for actions; context from CRM, PostHog, Jira/Linear, Snowflake ([usepylon.com](https://www.usepylon.com/ai-agents/)).
- Reported $59–139/seat + AI $100–500/mo (*unverified* — pricing page didn't load).

### Crisp (SMB)
- Per-workspace pricing: €0 / €45 / €95 / €295, extra seats $10.
- Hugo AI agent with included credits (~90 / 450 / 1,350 conversations) ≈ **$0.05/conversation** — cheapest published rate found ([crisp.chat/pricing](https://crisp.chat/en/pricing/)).
- MagicMap (live visitors) and MagicBrowse (co-browse) — see `02`.

### Chatwoot (open source, MIT)
- Self-hostable. **Captain** AI agent first-class since v4.14 (May 2026): per-assistant custom tools, audience/schedule targeting, FAQ suggestions mined from past conversations ([blog](https://www.chatwoot.com/blog/captain-gets-sharper-faq-suggestions-assistant-overview)).
- Cloud from $19/agent; Captain credits $20 per 1,000 (*third-party*).

### Zendesk
- Moved to per-resolution AI pricing (~$1.50–2.00) and uses an AI evaluation model to verify each billed resolution ([CMSWire](https://www.cmswire.com/customer-experience/zendesk-unveils-autonomous-ai-workforce-at-relate-2026/)). No native co-browse.

### Newcomers / funding
- Wonderful AI — $150M at ~$2B valuation ([Bloomberg](https://www.bloomberg.com/news/articles/2026-03-12/ai-customer-support-startup-wonderful-ai-raises-150-million)).
- Encore AI — $30M, voice agents trained on a company's call recordings ([TechCrunch](https://techcrunch.com/2026/07/29/encore-ai-raises-30m-to-build-ai-agents-that-learn-from-customer-calls/)).

## Table stakes (2026)

- Train on docs, websites, help-centre content; answers with citations.
- Tool calls / actions against customer APIs (order lookup, refunds).
- Handoff rules + shared human inbox.
- Agent copilot: drafted replies, summaries, translation.
- Multichannel: widget, email, WhatsApp/social; Slack for B2B.
- Basic analytics: resolution rate, topic clustering.
- Voice — becoming expected at mid-market+.

## Where products differentiate

- **Procedures as the core unit** (Decagon AOPs, Fin Procedures) — plain-language workflows with per-step policy.
- **Agents that build agents** (Sierra Ghostwriter, Decagon Duet).
- **Test before ship** — simulations, regression suites (Fin, Decagon).
- **Self-improvement** from escalated conversations (Duet Apprentice, Chatwoot FAQ suggestions).
- **Owned voice models** (Decagon Chord).
- **Customers' AI agents as a channel** (Decagon Personal Agent Gateway).
- **B2B depth** — account and product-usage context (Pylon, Plain).
- **Trustworthy billing** (Zendesk verified resolutions).

## User complaints / gaps

- **Fin "assumed resolutions":** customer silent 24h → counted resolved → billed. Reports of bills jumping $4K → $9K/mo ([getmacha summary](https://www.getmacha.com/blog/intercom-fin-ai-agent-complete-guide); original Reddit threads *unverified*).
- **Chatbase:** a reply can burn 1–6 credits; bot stops when credits run out; confident wrong answers and invented URLs; refund disputes. Trustpilot 3.9 vs G2 4.8 ([sitegpt](https://sitegpt.ai/blog/chatbase-review)).
- **Can't reach a human:** Gartner — 64% of consumers prefer companies not use AI in service ([coverage](https://tech.yahoo.com/ai/articles/ai-now-solve-most-customer-144433841.html)).
- **Enterprise tools out of reach:** long setup, six-figure minimums → mid-market gap.

## Pricing trends

- **Per-resolution / per-outcome is mainstream:** Fin $0.99, Zendesk $1.50–2, Sierra ~$1.50, Decagon ~$0.50/resolution or ~$0.99/conversation. Vendors keep widening "outcome".
- **Seats + credits hybrid:** Plain, Chatwoot, Chatbase, Pylon.
- **Cheap bundled AI for SMB:** Crisp ~$0.05/conversation.
- **Predictable, auditable billing is a selling point:** Zendesk verification; Plain markets cost that "tracks your plan, not a per-resolution meter."

**Implication for us:** bill only verified/customer-confirmed resolutions, transparent caps, guaranteed path to a human, procedure-style actions with built-in testing.
