# Launch drafts (not posted)

Edit before posting; numbers below are real as of 2026-10-05.

## Show HN

**Title:** Show HN: Jun Desk – open-source support desk whose AI sees the error your customer just hit

**URL:** https://github.com/samarsheikh001/jun

**Text:**

When a customer writes "I can't pay my invoice", the first few messages of most support chats are spent finding out what they actually saw. Which page, which browser, did it show an error? Jun Desk skips that part. The chat widget keeps a short, masked list of what went wrong in the visitor's browser (failed requests with their status, JavaScript errors, pages visited), so the AI's first reply can be "your payment request failed with a server error at 14:02, I've flagged it to the team", and the engineer who picks it up gets the failing request quoted in the handoff note.

It's an Intercom/Fin-style desk for B2B SaaS that you deploy to your own Cloudflare account: Workers, Durable Objects for the realtime chat, D1, R2, Queues and Workers AI. One button deploys it, and you don't need an API key, an email service or a database server; logins are passkeys.

A few things I haven't seen in other open-source desks:

- The AI's rules, procedures, HTTP tools and tests live as files you can keep in git (procedures use the Agent Skills SKILL.md format). `jun eval` replays your recent real conversations against an edited config and shows which answers would change before you push it.
- An agent can turn the conversation into a GitHub or Linear issue in one click: the AI drafts steps to reproduce from the page trail, the failing request and the browser, the agent edits it, and the conversation keeps the link. The AI never files issues by itself.
- If the page breaks, the widget can offer help on its own, and the AI words the offer from what failed ("Adding a team member didn't work. Want a hand?") rather than a canned line.
- Signed-in customers come through as a verified identity (an HS256 JWT from your backend), so tools can look up that customer's own account.

What it doesn't do yet: email and Slack channels. The default Workers AI model (Mistral Small 3.1) is fast, at about a second to the first word, but it's noticeably weaker than GPT-class models on tricky questions; plugging in an OpenAI key is one secret. Captured context never includes request or response bodies, by design, which means the AI sometimes knows *that* a call failed but not *why*.

The server is AGPL-3.0; the embeddable widget and the config format are MIT. I'd love to hear from anyone running support for a SaaS product about what the debug context gets wrong or misses.

## GitHub release (v1.0.0)

First release. Deploy with the button in the README; upgrades from any earlier commit are `git pull` + `npm run deploy` (migrations run first).

- Widget (about 4 KB loader): live chat, files, read receipts, branding, business hours with email capture, consent mode, allowed websites.
- AI agent on Workers AI or OpenAI: answers from your docs with citations, hands off with a brief, follows procedures, calls your HTTP tools, logs every call.
- Debug context: masked errors, failed requests and page trail for agents and the AI; AI-worded proactive help when something breaks.
- Issues: "Create issue" drafts a GitHub or Linear issue from the conversation and the debug context; the agent edits and files it, and the conversation keeps the link.
- Agent as code: AGENTS.md, skills, tools and evals in git; `jun pull/push/eval`; versions and restore in the dashboard.
- Inbox: real-time, assignment, AI takeover, notes with @mentions, saved replies, tags, contact sidebar, live visitors, agent-started chats, identity verification.
- Reports: conversations per day, AI resolution and handoff rates with the top handoff reasons, first-response times, CSAT with recent 👎 comments, and a per-teammate table.
