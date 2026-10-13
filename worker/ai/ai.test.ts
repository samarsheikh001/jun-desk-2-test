import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../shared/protocol.ts";
import { actionCallId, DONE_TOOL } from "../../shared/actions.ts";
import { asksForHuman, followUpRules, replyOrder, resolveCitations, searchQuery, systemPrompt, toChatMessages } from "./agent.ts";
import { blocksFromText, chunkBlocks, decodeEntities } from "./chunk.ts";
import { ftsQuery } from "./query.ts";
import type { SearchHit } from "./query.ts";

const hit = (title: string, url: string | null = null): SearchHit => ({ id: title, title, heading: "", url, text: "...", score: 1 });

test("chunks stay within sections and carry the heading path", () => {
  const chunks = chunkBlocks([
    { kind: "heading", level: 1, text: "Billing" },
    { kind: "text", text: "Intro to billing." },
    { kind: "heading", level: 2, text: "Refunds" },
    { kind: "text", text: "Refunds within 14 days." },
    { kind: "heading", level: 2, text: "Invoices" },
    { kind: "text", text: "Invoices are emailed." },
  ]);
  assert.deepEqual(chunks, [
    { heading: "Billing", text: "Intro to billing." },
    { heading: "Billing › Refunds", text: "Refunds within 14 days." },
    { heading: "Billing › Invoices", text: "Invoices are emailed." },
  ]);
});

test("long sections are split near the target size, never over the max", () => {
  const sentence = "This sentence is about forty characters. ";
  const chunks = chunkBlocks([{ kind: "text", text: sentence.repeat(200) }]);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.text.length <= 2000);
});

test("snippets: markdown headings become sections", () => {
  assert.deepEqual(blocksFromText("# Refunds\n\nWithin 14 days.\n\nEmail us."), [
    { kind: "heading", level: 1, text: "Refunds" },
    { kind: "text", text: "Within 14 days." },
    { kind: "text", text: "Email us." },
  ]);
});

test("HTML entities decode", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry&#39;s &lt;b&gt; &#x1F600;"), "Tom & Jerry's <b> 😀");
});

test("citations are renumbered by first use; unknown ones are dropped", () => {
  const { text, sources } = resolveCitations("Refunds take 14 days [3]. Invoices are monthly [1][3]. Ignore [9].", [hit("A", "https://a"), hit("B"), hit("C", "https://c")]);
  assert.equal(text, "Refunds take 14 days [1]. Invoices are monthly [2][1]. Ignore.");
  assert.deepEqual(sources, [{ title: "C", url: "https://c" }, { title: "A", url: "https://a" }]);
});

test("asking for a human is detected without the model", () => {
  for (const yes of ["Can I talk to a human?", "speak with someone please", "human please", "I want to chat with support"]) assert.ok(asksForHuman(yes), yes);
  for (const no of ["How do I add a team member?", "Is there human review of invoices?"]) assert.ok(!asksForHuman(no), no);
});

const msg = (authorType: Message["authorType"], body: string, extra: Partial<Message> = {}): Message => ({
  id: body, seq: 0, authorType, authorId: null, authorName: null, body, attachments: [], clientMsgId: body, createdAt: 0, internal: false, meta: {}, ...extra,
});

test("search query adds the previous visitor message to short follow-ups", () => {
  assert.equal(searchQuery([msg("visitor", "How much is the Team plan?"), msg("ai", "It's $20."), msg("visitor", "and yearly?")]), "How much is the Team plan?\nand yearly?");
  assert.equal(searchQuery([msg("visitor", "How do I export all my data to CSV from the dashboard?")]), "How do I export all my data to CSV from the dashboard?");
});

test("model input excludes internal notes and system messages", () => {
  const input = toChatMessages([
    msg("visitor", "hi"),
    msg("system", "Handed off", { internal: true }),
    msg("system", "A teammate will reply"),
    msg("agent", "Hello! I'm Ada."),
  ]);
  assert.deepEqual(input, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello! I'm Ada." }]);
});

test("model input replays a page action as a tool call and its result", () => {
  const action = { runId: "run_1", id: "add_to_cart", name: "add_to_cart", tool: "pa_add_to_cart", description: "Add it to the cart", risk: "confirm" as const, params: {}, required: [], input: { size: "M" }, missing: [], status: "ok" as const, result: "Added 1 × M", canUndo: true };
  const input = toChatMessages([msg("visitor", "add it in M"), msg("ai", "Adding it now.", { meta: { action } }), msg("visitor", "thanks")]);
  assert.deepEqual(input, [
    { role: "user", content: "add it in M" },
    { role: "assistant", content: [{ type: "text", text: "Adding it now." }, { type: "tool-call", toolCallId: actionCallId("run_1"), toolName: "pa_add_to_cart", input: { size: "M" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: actionCallId("run_1"), toolName: "pa_add_to_cart", output: { type: "text", value: "Added 1 × M" } }] },
    { role: "assistant", content: "Added 1 × M" }, // no follow-up reply was stored: the card's line stands in
    { role: "user", content: "thanks" },
  ]);
  // The visitor wrote again before the AI said anything after the action: the card's line fills the assistant turn.
  const gap = toChatMessages([msg("ai", "Adding it now.", { meta: { action } }), msg("visitor", "thanks")]);
  assert.deepEqual(gap[2], { role: "assistant", content: "Added 1 × M" });
  const cancelled = toChatMessages([msg("ai", "Adding it now.", { meta: { action: { ...action, status: "cancelled" as const, result: null } } }), msg("visitor", "no")]);
  assert.deepEqual(cancelled[2], { role: "assistant", content: "Cancelled" });
  // An action-only reply has a placeholder body: the model sees just the call.
  const only = toChatMessages([msg("ai", "I can do that right here:", { meta: { action } })]);
  assert.deepEqual((only[0] as { content: unknown[] }).content.length, 1);
});

test("system prompt numbers sources and keeps the handoff rule", () => {
  const prompt = systemPrompt({ workspaceName: "Acme", persona: "Be brief.", hits: [hit("Refunds", "https://acme.dev/refunds")] });
  assert.match(prompt, /\[1\] Refunds \(https:\/\/acme\.dev\/refunds\)/);
  assert.match(prompt, /Call the handoff tool/);
  assert.match(prompt, /Be brief\./);
});

test("FTS query quotes terms and drops stopwords", () => {
  assert.equal(ftsQuery('How do I get a "refund" for /api/billing?'), '"get" OR "refund" OR "api" OR "billing"');
  assert.equal(ftsQuery("is it the"), null);
});

test("replyOutcome: the reply's words plus what it decided with tools", async () => {
  const { replyOutcome } = await import("./agent.ts");
  const none = { handoff: null, flag: null };
  assert.deepEqual(replyOutcome("Refunds take 14 days [1].", none), { kind: "answer", text: "Refunds take 14 days [1].", escalate: null });
  // A handoff wins over everything, and keeps what was said before it.
  assert.deepEqual(replyOutcome("I can't change billing myself.", { ...none, handoff: "needs a refund" }), { kind: "handoff", reason: "needs a refund", text: "I can't change billing myself." });
  assert.deepEqual(replyOutcome("", { ...none, handoff: "  " }), { kind: "handoff", reason: "The AI handed the chat to the team.", text: "" });
  // No words and no decision: the team takes it.
  assert.deepEqual(replyOutcome("  ", none), { kind: "handoff", reason: "The AI couldn't answer from the knowledge base.", text: "" });
  // A flagged problem: the answer stands, and carries the summary for engineers.
  assert.deepEqual(replyOutcome("Your payment request failed with a 500 at 14:02. I've flagged it.", { ...none, flag: "POST /api/billing returns 500" }), {
    kind: "answer",
    text: "Your payment request failed with a 500 at 14:02. I've flagged it.",
    escalate: "POST /api/billing returns 500",
  });
  // Flagged with nothing said to the customer: hand it over with the flag as the reason.
  assert.deepEqual(replyOutcome("", { ...none, flag: "POST /api/billing returns 500" }), { kind: "handoff", reason: "Bug flagged by the AI: POST /api/billing returns 500", text: "" });
  // The words "HANDOFF:" in the text are just text now.
  assert.equal(replyOutcome("HANDOFF: you need staff.", none).kind, "answer");
});

test("follow-up questions: the job's input, and its lines cleaned (unnumbered, unquoted, uncited, deduped, capped)", async () => {
  const { followUpsInput, parseFollowUpLines } = await import("./followups.ts");
  assert.deepEqual(parseFollowUpLines('How do I request one?\n2. "Can I get credit instead?"\nhow do i request one?\n\nIs it free [1]?\nok\nFourth one?'), [
    "How do I request one?",
    "Can I get credit instead?",
    "Is it free?",
  ]);
  assert.deepEqual(parseFollowUpLines(""), []);
  const input = followUpsInput("How long do refunds take?", "Refunds take 14 days [1].", [hit("Refunds", "https://acme.dev/refunds"), hit("Billing"), hit("Plans"), hit("Extra")]);
  assert.match(input, /Customer's question:\nHow long do refunds take\?/);
  assert.match(input, /Answer they got:\nRefunds take 14 days \[1\]\./);
  assert.match(input, /\[3\] Plans/);
  assert.doesNotMatch(input, /Extra/, "at most three sources");
});

test("citations in full-width brackets (some models) are understood", () => {
  const { text, sources } = resolveCitations("Refunds within 14 days【1】 or credit【2†L3-L5】.", [hit("A"), hit("B")]);
  assert.equal(text, "Refunds within 14 days[1] or credit[2].");
  assert.equal(sources.length, 2);
});

test("S-11 nudge: facts describe the failure; unsafe or rambling lines fall back", async () => {
  const { cleanNudge, nudgeFacts, GENERIC_NUDGE } = await import("./nudge.ts");
  const page = { url: "https://app.acme.test/billing", title: "Billing" };
  assert.match(nudgeFacts({ t: 1, kind: "network", method: "POST", url: "/api/billing", status: 500 }, page), /POST \/api\/billing → HTTP 500/);
  assert.match(nudgeFacts({ t: 1, kind: "error", message: "TypeError: x is undefined", source: "/chart.js:4" }, page), /JavaScript error happened: TypeError/);
  assert.equal(cleanNudge('"Looks like your invoice payment didn\'t go through. Want a hand?"'), "Looks like your invoice payment didn't go through. Want a hand?");
  assert.equal(cleanNudge("Looks like the usage chart didn't load"), "Looks like the usage chart didn't load. Want a hand?");
  assert.equal(cleanNudge("Your POST to /api/billing returned 500. Want a hand?"), null);
  assert.equal(cleanNudge("A TypeError happened. Want a hand?"), null);
  assert.equal(cleanNudge(`${"Very long ".repeat(20)}Want a hand?`), null);
  assert.equal(cleanNudge(GENERIC_NUDGE), GENERIC_NUDGE);
  // S-12: the app's own words; its numbers ("row 142") may show, its code never reaches the model.
  const facts = nudgeFacts({ t: 1, kind: "app_error", message: "Row 142: missing email", code: "import.row_invalid" }, { url: "/import", title: "Import contacts" });
  assert.match(facts, /in its own words: "Row 142: missing email"/);
  assert.doesNotMatch(facts, /import\.row_invalid/);
  assert.equal(cleanNudge("Your CSV import failed on row 142. Want a hand?", "Row 142: missing email"), "Your CSV import failed on row 142. Want a hand?");
  assert.equal(cleanNudge("Your CSV import failed on row 142. Want a hand?"), null);
  assert.equal(cleanNudge("Your import got HTTP 500. Want a hand?", "Row 142: missing email"), null);
  assert.equal(cleanNudge("Row 9 for [email] wasn't imported. Want a hand?", "Row 9: missing name for [email]"), null);
});

test("S-02 / S-13 nudge: rage clicks and stuck pages as plain facts; one cache line per element / page and issue", async () => {
  const { cleanNudge, nudgeCacheKey, nudgeFacts } = await import("./nudge.ts");
  const page = { url: "https://app.acme.test/reports", title: "Reports" };
  const rage = nudgeFacts({ t: 1, kind: "rage_click", count: 4, target: { tag: "button", id: "export-btn", text: "Export CSV" } }, page);
  assert.match(rage, /clicked the "Export CSV" button 4 times in a row and nothing happened/);
  assert.doesNotMatch(rage, /export-btn/, "ids are for agents, not the line");
  assert.match(nudgeFacts({ t: 1, kind: "rage_click", count: 3, target: { tag: "a" } }, page), /clicked a link 3 times/);
  assert.match(nudgeFacts({ t: 1, kind: "rage_click", count: 3, target: { tag: "div" } }, page), /clicked something on the page 3 times/);
  const stuck = nudgeFacts({ t: 1, kind: "stuck", url: "/reports", seconds: 185, issue: "network" }, page);
  assert.match(stuck, /on this page for 3 min after a failed request/);
  assert.match(stuck, /Still working on this\? Want a hand\?/);
  // The filter still applies; numbers on the button the visitor sees may show.
  assert.equal(cleanNudge("Looks like that button isn't responding. Want a hand?"), "Looks like that button isn't responding. Want a hand?");
  assert.equal(cleanNudge("Still working on this? Want a hand?"), "Still working on this? Want a hand?");
  assert.equal(cleanNudge("Looks like the Pay 250 button isn't responding. Want a hand?", "Pay 250"), "Looks like the Pay 250 button isn't responding. Want a hand?");
  assert.equal(cleanNudge("The button#export-btn click threw an error. Want a hand?"), null);
  const key = (seconds: number) => nudgeCacheKey("ws", { t: 1, kind: "stuck", url: "/reports", seconds, issue: "network" }, page);
  assert.equal(key(180), key(240));
  assert.notEqual(
    nudgeCacheKey("ws", { t: 1, kind: "rage_click", count: 3, target: { tag: "button", text: "Export" } }, page),
    nudgeCacheKey("ws", { t: 1, kind: "rage_click", count: 3, target: { tag: "button", text: "Save" } }, page),
  );
});

test("K-04: excluded pages match by exact URL or path prefix", async () => {
  const { isExcluded } = await import("./urls.ts");
  const rules = ["https://docs.acme.test/old-page?utm_source=x", "/blog/", "/changelog*"];
  assert.equal(isExcluded(new URL("https://docs.acme.test/old-page"), rules), true, "exact URL (tracking params dropped)");
  assert.equal(isExcluded(new URL("https://docs.acme.test/old-page-2"), rules), false);
  assert.equal(isExcluded(new URL("https://docs.acme.test/blog/launch"), rules), true);
  assert.equal(isExcluded(new URL("https://docs.acme.test/changelog-2026"), rules), true);
  assert.equal(isExcluded(new URL("https://docs.acme.test/guides/blog/"), rules), false, "prefixes start at the root");
  assert.equal(isExcluded(new URL("https://docs.acme.test/x"), undefined), false);
});

test("P-01 page opener: facts from title, path and hint; technical or alarming lines fall back", async () => {
  const { cleanOpener, openerFacts, GENERIC_OPENER } = await import("./nudge.ts");
  const facts = openerFacts({ path: "/pricing", title: "Pricing – Acme" }, "help choosing between Team and Business");
  assert.match(facts, /Page title: Pricing – Acme/);
  assert.match(facts, /Page path: \/pricing/);
  assert.match(facts, /wants to offer on this page: help choosing between Team and Business/);
  assert.doesNotMatch(openerFacts({ path: "/", title: "" }), /offer/);
  assert.match(openerFacts({ path: "/", title: "" }), /\(untitled\)/);
  assert.equal(cleanOpener('"Comparing plans? Happy to help you pick the right one."'), "Comparing plans? Happy to help you pick the right one.");
  assert.equal(cleanOpener("Questions about our plans\nSure!"), "Questions about our plans.");
  assert.equal(cleanOpener(GENERIC_OPENER), GENERIC_OPENER);
  assert.equal(cleanOpener("Need help with the /docs/api page?"), null);
  assert.equal(cleanOpener("Seeing an error on this page?"), null);
  assert.equal(cleanOpener("Something went wrong? We can help."), null);
  assert.equal(cleanOpener("Having problems with billing?"), null);
  assert.equal(cleanOpener("Check https://acme.com for prices."), null);
  assert.equal(cleanOpener(`${"Very long ".repeat(15)}line.`), null);
  assert.equal(cleanOpener("  "), null);
});

test("streamCitations resolves citations so far and holds back an open bracket", async () => {
  const { streamCitations } = await import("./agent.ts");
  const hits = [hit("A", "https://a"), hit("B", "https://b")];
  assert.deepEqual(streamCitations("Refunds take 14 days [2", hits), { text: "Refunds take 14 days", sources: [] });
  assert.deepEqual(streamCitations("Refunds take 14 days [2] and", hits), { text: "Refunds take 14 days [1] and", sources: [{ title: "B", url: "https://b" }] });
});

test("citations of chunks from the same page merge into one source", () => {
  const page = (heading: string): SearchHit => ({ ...hit("Pricing", "https://x/pricing"), heading });
  const { text, sources } = resolveCitations("Teams cost $10 [1][2]. Annual saves 20% [3]. Refunds [2].", [page("Teams"), page("Annual"), hit("Refunds")]);
  assert.equal(text, "Teams cost $10 [1]. Annual saves 20% [2]. Refunds [1].");
  assert.deepEqual(sources, [{ title: "Pricing", url: "https://x/pricing" }, { title: "Refunds", url: null }]);
});

test("followUpRules: a turn after a page action must call the next action or the done tool", () => {
  const rules = followUpRules({ name: "set_pickup", status: "ok", result: "Pickup set to Anchorvale Cres." });
  assert.match(rules, /must call exactly one tool: the next action, or jun_done/);
  assert.match(rules, /never "set_pickup" again with the same inputs/);
  assert.equal(DONE_TOOL.startsWith("pa_"), false, "never a page action's tool name");
});

test("replyOrder: a reply sits after the message it answers, even when another arrived while it was written", () => {
  const stored = [
    msg("visitor", "hey", { seq: 1 }),
    msg("visitor", "export my usage", { seq: 2 }),
    msg("ai", "Hello! How can I help?", { seq: 3, clientMsgId: "ai:1" }),
  ];
  assert.deepEqual(replyOrder(stored).map((m) => m.body), ["hey", "Hello! How can I help?", "export my usage"]);
  // The model's turn now ends on the visitor's unanswered message.
  const input = toChatMessages(stored);
  assert.equal(input.at(-1)?.role, "user");
  // A chain's replies (ai:1, ai:1.1) keep their order behind their message; replies already in place don't move.
  const chain = [
    msg("visitor", "book me", { seq: 1 }),
    msg("visitor", "to the beach", { seq: 2 }),
    msg("ai", "Searching", { seq: 3, clientMsgId: "ai:1" }),
    msg("ai", "Set it", { seq: 4, clientMsgId: "ai:1.1" }),
    msg("ai", "Done", { seq: 5, clientMsgId: "ai:2" }),
  ];
  assert.deepEqual(replyOrder(chain).map((m) => m.body), ["book me", "Searching", "Set it", "to the beach", "Done"]);
  const plain = [msg("visitor", "a", { seq: 1 }), msg("ai", "b", { seq: 2, clientMsgId: "ai:1" }), msg("agent", "c", { seq: 3 })];
  assert.deepEqual(replyOrder(plain).map((m) => m.body), ["a", "b", "c"]);
});

test("W-09: a card's button reaches the model as what it was, with the card's payload and what was entered", () => {
  const press = msg("visitor", "Cancel renewal", { meta: { widgetAction: { widgetId: "w1", widget: "subscription", type: "renewal.cancel", payload: { plan: "Pro" }, values: { reason: "Too pricey" } } } });
  assert.deepEqual(toChatMessages([msg("visitor", "my plan?"), msg("ai", "Here's what I found:"), press]).at(-1), {
    role: "user",
    content: '[On the subscription card the customer pressed "Cancel renewal": action renewal.cancel, payload {"plan":"Pro"}, entered {"reason":"Too pricey"}]',
  });
});
