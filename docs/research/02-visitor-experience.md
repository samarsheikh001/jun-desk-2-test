# 02 — Visitor experience

*As of 2026-10-03. Mostly vendor docs/changelogs; vendor marketing figures marked "(vendor claim)".*

## 1. Live visitor tracking & identity

- **Live visitor list is table stakes.** Crisp MagicMap shows active visitors in real time and can start co-browse from there ([Crisp](https://crisp.chat/en/unleash/benefits-magicmap/)).
- **Identity verification: JWT, not HMAC.** Intercom deprecated `user_hash` HMAC in favour of a signed JWT (HS256, must include `user_id`) passed on every boot — tokens expire and can be revoked, limiting replay ([changelog](https://www.intercom.com/changes/en/91608-a-new-secure-way-to-authenticate-messenger-users-with-jwts), [migration](https://www.intercom.com/help/en/articles/10807823-migrating-from-identity-verification-to-messenger-security-with-jwts)). → Use JWT from day one.
- **Enrichment:** Clearbit Reveal is retired; enrichment now lives in HubSpot Breeze Intelligence (HubSpot customers only) ([abmatic](https://abmatic.ai/blog/clearbit-sunset-what-to-use-instead-2026)).
  - Company/contact: Clay, Apollo, ZoomInfo, Cognism (GDPR-safe EU).
  - De-anonymization: RB2B (person-level, US only), Warmly — claims ~65% of companies / 15% of individuals identified in <3s (vendor claim). Intent score = pages viewed (e.g. pricing) + ICP fit + agreeing signal types ([Warmly](https://www.warmly.ai/p/solutions/use-cases/website-visitor-identification)).
  - → Pluggable enrichment provider, no single-vendor dependency.

## 2. Proactive engagement

- **Fin Proactive Procedures** (Aug 2026): a website click or an external API signal starts an AI workflow; Fin opens already knowing why ([fin.ai/updates](https://fin.ai/updates), [help](https://www.intercom.com/help/en/articles/15645332-trigger-a-proactive-procedure-from-your-website-or-an-external-api)).
- **Fin Sales Agent Lead Recovery** (May 2026) re-engages prospects who go quiet.
- **Warmly**: visitor ID + AI chat started while the visitor is still on site.
- Shift: from rule-based "30s on /pricing" pop-ups → **signal-driven AI openers carrying context**.

## 3. Struggle detection

- **Definitions (Sentry):** rage click = 5+ rapid clicks on the same element; dead click = click on an interactive element with no DOM change after a few seconds. Sentry's feedback widget attaches up to 60s of pre-report replay; replays can be flushed from app code, e.g. on widget open ([docs](https://docs.sentry.io/product/session-replay/web/)).
- **Pendo → Fin** (beta): rage clicks, error clicks, "U-turns" (leave within 7s) sent as webhooks; Intercom outbound rule starts a proactive Fin conversation ([Pendo](https://support.pendo.io/hc/en-us/articles/49661810672923-Power-Intercom-Fin-to-act-proactively-based-on-frustration-signals-beta)).
- **FullStory "Ragehooks"** → Intercom ([FullStory](https://help.fullstory.com/hc/en-us/articles/360020623794-Intercom)).
- **LogRocket Galileo AI** summarises the session when an Intercom ticket is submitted; June 2026 MCP server that auto-dispatches coding agents to fix issues ([app store](https://www.intercom.com/app-store/?app_package_code=logrocket), [GlobeNewswire](https://www.globenewswire.com/news-release/2026/06/23/3316370/0/en/the-era-of-self-improving-software-is-here-logrocket-now-auto-dispatches-coding-agents-to-fix-user-issues.html)).
- **Jam.dev**: agent requests a recording from the conversation; console logs + full XHR/fetch bodies land as a note ([docs](https://jam.dev/docs/request-a-jam/intercom)).
- **PostHog**: frustration-signal collection; filter replays by it ([changelog](https://posthog.com/changelog)).
- **Gap:** all of these are add-ons wired via notes/webhooks. Few capture this natively in the support widget.

## 4. Co-browse & in-app guidance

- **Crisp MagicBrowse**: plugin-free co-browse, drawing on the visitor's screen, see typing before send ([Crisp](https://crisp.chat/en/unleash/benefits-magicbrowse/)). Zendesk has no native co-browse.
- **Cobrowse.io AI Virtual Agent Co-browse**: AI sees and annotates the user's screen (web, iOS, Android, desktop), redaction controls, escalation to human with context ([Cobrowse.io](https://cobrowse.io/features/ai-virtual-agent-cobrowse)).
- In-app guidance: CommandBar → Amplitude (Oct 2024), relaunched as Amplitude Guides & Surveys (Feb 2025) ([getmacha](https://www.getmacha.com/blog/command-ai-complete-guide)).

## 5. Widget tech, UX & privacy

- **Weight:** Zendesk / Tawk.to ship 500–750 KB JS; Crisp <~155 KB. Undeferred widget = 300–600 ms main-thread blocking, −9 to −16 Lighthouse points; deferred to load+idle or first interaction → 0–1 points. Only 3–10% of visitors open chat ([corewebvitals.io](https://www.corewebvitals.io/pagespeed/chat-widget-perfect-core-web-vitals)).
- **Best practice:** ~4 KB loader with a stand-in bubble; full app in iframe/shadow DOM on click (vendor claim, [GreenGeeks](https://www.greengeeks.com/blog/ai-chatbot-website-loads-slow-fixes/)).
- **AI-rendered UI** ([CopilotKit](https://github.com/CopilotKit/generative-ui), [awesome-generative-ui](https://github.com/narrowin/awesome-generative-ui)):
  - Declarative/allow-listed: Google A2UI, OpenAI ChatKit widgets, AG-UI event streaming.
  - Sandboxed: MCP Apps (arbitrary HTML in iframe).
- **Privacy:** Intercom sets a 9-month `intercom-id` cookie on page load even if chat never opens → needs ePrivacy consent in EU. Common mistake: sending email/user data at boot before consent ([Lokker](https://lokker.com/topics/intercom)).

## Differentiators worth building

1. Native struggle detection in the widget SDK → context-aware AI opener.
2. Debug context on every conversation: last 60s replay, console/network errors, AI summary.
3. JWT identity from day one; consent-gated tracking; pluggable enrichment.
4. Signal-triggered AI outreach via public API (e.g. payment failed → AI opens with context).
5. Allow-listed AI-rendered UI (cards, forms, buttons); MCP Apps optional.
6. AI co-browse with redacted DOM, handoff to human co-browse.
7. <5 KB loader, public Core Web Vitals budget.
8. Consent-aware mode: no cookies before consent.
