import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  AI_OFF_HANDOFF_REASON,
  computeMetrics,
  isAiOffHandoff,
  MAX_START_PAGES,
  startPage,
  dayKey,
  durationStat,
  formatDuration,
  handoffReasonLabel,
  parsePeriod,
  periodDays,
  previousPeriod,
  startOfDay,
  type ConversationFacts,
  type MetricsInput,
} from "./metrics.ts";

const S = 1000;
const MIN = 60 * S;
// Monday 5 Oct 2026, 12:00 UTC.
const NOW = Date.parse("2026-10-05T12:00:00Z");

let n = 0;
function conv(at: number, facts: Partial<ConversationFacts> = {}): ConversationFacts {
  return {
    id: `cv_${++n}`,
    createdAt: at,
    resolved: false,
    firstVisitorAt: at,
    firstAiAt: null,
    firstAgentAt: null,
    firstAgentId: null,
    handoffReason: null,
    aiOffHandoff: false,
    startUrl: null,
    ...facts,
  };
}
const input = (over: Partial<MetricsInput>): MetricsInput => ({
  now: NOW,
  days: 7,
  timezone: "UTC",
  aiEnabled: true,
  conversations: [],
  ratings: [],
  replies: [],
  members: [],
  truncated: false,
  ...over,
});

test("periods: only 7, 30 and 90 days", () => {
  assert.equal(parsePeriod("7"), 7);
  assert.equal(parsePeriod("90"), 90);
  for (const bad of ["14", "", null, undefined, "7.0", " 7", "abc", "-7"]) assert.equal(parsePeriod(bad), null, String(bad));
});

test("days are calendar days in the time zone, DST included", () => {
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "UTC"), "2026-10-05");
  assert.equal(dayKey(Date.parse("2026-10-05T23:30:00Z"), "Europe/Berlin"), "2026-10-06");
  assert.equal(dayKey(Date.parse("2026-10-05T02:00:00Z"), "America/New_York"), "2026-10-04");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(startOfDay("2026-10-05", "America/New_York"), Date.parse("2026-10-05T04:00:00Z")); // EDT
  // Clocks go back in Berlin on 25 Oct 2026: that day starts at UTC+2, the next at UTC+1.
  assert.equal(startOfDay("2026-10-25", "Europe/Berlin"), Date.parse("2026-10-24T22:00:00Z"));
  assert.equal(startOfDay("2026-10-26", "Europe/Berlin"), Date.parse("2026-10-25T23:00:00Z"));
  assert.equal(startOfDay("2026-10-05", "Asia/Kolkata"), Date.parse("2026-10-04T18:30:00Z"));

  const p = periodDays(NOW, 7, "UTC");
  assert.deepEqual(p.keys, ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  assert.equal(p.since, Date.parse("2026-09-29T00:00:00Z"));
  assert.equal(p.until, Date.parse("2026-10-06T00:00:00Z"));
  assert.equal(periodDays(NOW, 90, "UTC").keys.length, 90);
});

test("conversations: counted per day of the period, outside it ignored", () => {
  const r = computeMetrics(
    input({
      conversations: [
        conv(NOW),
        conv(NOW - 2 * 60 * MIN),
        conv(Date.parse("2026-09-29T00:00:00Z"), { resolved: true }), // first second of the period
        conv(Date.parse("2026-09-28T23:59:59Z")), // the day before
        conv(Date.parse("2026-10-06T00:00:00Z")), // tomorrow (clock skew)
      ],
    }),
  );
  assert.equal(r.conversations.total, 3);
  assert.equal(r.conversations.resolved, 1);
  assert.equal(r.conversations.series.length, 7);
  assert.equal(r.conversations.series[0]!.conversations, 1);
  assert.equal(r.conversations.series[6]!.conversations, 2);
  assert.equal(r.conversations.series.reduce((sum, d) => sum + d.conversations, 0), r.conversations.total);

  // The same instant falls on another day in another zone: 23:30 UTC Sunday is Monday in Berlin.
  const late = conv(Date.parse("2026-10-04T23:30:00Z"));
  assert.equal(computeMetrics(input({ conversations: [late] })).conversations.series[5]!.conversations, 1);
  assert.equal(computeMetrics(input({ conversations: [late], timezone: "Europe/Berlin" })).conversations.series[6]!.conversations, 1);
});

test("empty period: zero counts, no rates or medians", () => {
  const r = computeMetrics(input({}));
  assert.equal(r.conversations.total, 0);
  assert.equal(r.ai.resolutionRate, null);
  assert.equal(r.ai.handoffRate, null);
  assert.deepEqual(r.ai.firstResponse, { count: 0, median: null, p90: null });
  assert.deepEqual(r.team.firstResponse, { count: 0, median: null, p90: null });
  assert.equal(r.csat.score, null);
  assert.deepEqual(r.teammates, []);
});

test("AI resolution and handoff: the AI's conversations, and which it handled alone", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAiAt: t + 3 * S }), // AI alone
        conv(t, { firstAiAt: t + 5 * S }), // AI alone
        conv(t, { firstAiAt: t + 4 * S, handoffReason: "The customer asked for a person." }),
        conv(t, { handoffReason: "The customer asked for a person." }), // asked before the AI answered
        conv(t, { firstAiAt: t + 2 * S, firstAgentAt: t + MIN, firstAgentId: "u1" }), // an agent took over
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u1" }), // AI off: the team's from the start
        conv(t), // nobody answered yet
      ],
    }),
  );
  assert.equal(r.ai.conversations, 5);
  assert.equal(r.ai.resolved, 2);
  assert.equal(r.ai.handedOff, 2);
  assert.equal(r.ai.resolutionRate, 2 / 5);
  assert.equal(r.ai.handoffRate, 2 / 5);
  assert.deepEqual(r.ai.firstResponse, { count: 4, median: 3.5 * S, p90: 5 * S });
  assert.equal(r.conversations.series[6]!.aiResolved, 2);
  assert.equal(r.conversations.series[6]!.ai, 5);
});

test("change against the previous period: its own days, null without a count or from zero", () => {
  const p = previousPeriod(NOW, 7, "UTC");
  assert.equal(p.until, periodDays(NOW, 7, "UTC").since);
  assert.equal(p.since, Date.parse("2026-09-22T00:00:00Z"));
  const t = NOW - MIN;
  const two = [conv(t), conv(t), conv(t)];
  assert.equal(computeMetrics(input({ conversations: two, previousTotal: 2 })).conversations.change, 0.5);
  assert.equal(computeMetrics(input({ conversations: two, previousTotal: 0 })).conversations.change, null);
  assert.equal(computeMetrics(input({ conversations: two })).conversations.previousTotal, null);
});

test("AI off: passed to the team isn't a handoff; 'AI is off' when it's off now with no AI chats", () => {
  const t = NOW - 60 * MIN;
  const offChats = [
    conv(t, { aiOffHandoff: true, firstAgentAt: t + MIN, firstAgentId: "u1" }), // reached the AI while off
    conv(t, { handoffReason: AI_OFF_HANDOFF_REASON }), // the reason alone is enough too
    conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u1" }), // started while off: the team's
  ];
  const off = computeMetrics(input({ aiEnabled: false, conversations: offChats }));
  assert.equal(off.ai.off, true);
  assert.equal(off.ai.enabled, false);
  assert.equal(off.ai.conversations, 0);
  assert.equal(off.ai.handedOff, 0);
  assert.equal(off.ai.handoffRate, null);
  assert.deepEqual(off.ai.reasons, []);
  assert.equal(off.ai.passedWhileOff, 2);
  assert.equal(off.conversations.total, 3);

  // On now (turned on recently): real numbers, the off-time chats still aren't handoffs.
  const on = computeMetrics(input({ aiEnabled: true, conversations: offChats }));
  assert.equal(on.ai.off, false);
  assert.equal(on.ai.conversations, 0);

  // Off now, but the AI worked earlier in the period: show what it did.
  const mixed = computeMetrics(
    input({
      aiEnabled: false,
      conversations: [
        ...offChats,
        conv(t, { firstAiAt: t + 3 * S }), // AI alone
        conv(t, { firstAiAt: t + 3 * S, handoffReason: "The customer asked for a person." }),
        // Answered, then turned off before the next message: the AI's, neither resolved nor handed off.
        conv(t, { firstAiAt: t + 3 * S, aiOffHandoff: true }),
        // Passed on while off, handed back, then the AI handed off for real.
        conv(t, { firstAiAt: t + 9 * S, aiOffHandoff: true, handoffReason: "Refund request" }),
      ],
    }),
  );
  assert.equal(mixed.ai.off, false);
  assert.equal(mixed.ai.conversations, 4);
  assert.equal(mixed.ai.resolved, 1);
  assert.equal(mixed.ai.handedOff, 2);
  assert.equal(mixed.ai.passedWhileOff, 4);
  assert.deepEqual(mixed.ai.reasons.map((r) => r.reason).sort(), ["Refund request", "The customer asked for a person"]);
  assert.equal(isAiOffHandoff(" AI replies are turned off. "), true);
  assert.equal(isAiOffHandoff("AI error: off"), false);
  assert.equal(isAiOffHandoff(null), false);
});

test("start pages: origin + path, no query, trailing slash or ids", () => {
  assert.equal(startPage("https://app.example.com/billing?session=…"), "https://app.example.com/billing");
  assert.equal(startPage("https://app.example.com/billing/"), "https://app.example.com/billing");
  assert.equal(startPage("https://APP.example.com/billing#plans"), "https://app.example.com/billing");
  assert.equal(startPage("https://app.example.com"), "https://app.example.com/");
  assert.equal(startPage("https://app.example.com/"), "https://app.example.com/");
  assert.equal(startPage("http://localhost:5173//docs//setup/"), "http://localhost:5173/docs/setup");
  assert.equal(startPage("https://app.example.com/invoices/123"), "https://app.example.com/invoices/:id");
  assert.equal(startPage("https://app.example.com/invoices/123/edit"), "https://app.example.com/invoices/:id/edit");
  assert.equal(startPage("https://x.test/u/3f2c1a9e-8b7d-4c6e-9f10-2a3b4c5d6e7f"), "https://x.test/u/:id");
  assert.equal(startPage("https://x.test/commit/9fceb02d0ae598e9"), "https://x.test/commit/:id");
  assert.equal(startPage("https://x.test/customers/cus_8f3k2a91"), "https://x.test/customers/:id");
  assert.equal(startPage("https://x.test/share/aZ9kQ2mX7pL4tR8w"), "https://x.test/share/:id");
  assert.equal(startPage("https://x.test/cards/%5Bnumber%5D"), "https://x.test/cards/:id");
  // Words, slugs and versions stay.
  for (const path of ["/docs/getting-started", "/v2/api", "/blog/2fa-setup", "/settings/api_keys", "/deadbeef", "/how-to-reset-password-2026"]) {
    assert.equal(startPage(`https://x.test${path}`), `https://x.test${path}`, path);
  }
  for (const bad of [null, undefined, "", "/billing", "not a url", "javascript:alert(1)", "file:///etc/passwd"]) assert.equal(startPage(bad), null, String(bad));
});

test("pages where chats start: top pages with counts and share", () => {
  const at = (url: string | null) => conv(NOW, { startUrl: url });
  const urls = [
    ...Array(4).fill("https://app.test/billing?plan=…"),
    "https://app.test/billing/",
    "https://app.test/invoices/1",
    "https://app.test/invoices/2",
    "https://docs.test/setup",
    ...Array.from({ length: 10 }, (_, i) => `https://app.test/p${String.fromCharCode(97 + i)}`),
    null,
    null,
    "garbage",
  ];
  const r = computeMetrics(input({ conversations: urls.map(at) }));
  assert.equal(r.pages.withPage, 18);
  assert.equal(r.pages.withoutPage, 3);
  assert.equal(r.pages.top.length, MAX_START_PAGES);
  assert.deepEqual(r.pages.top.slice(0, 3), [
    { page: "https://app.test/billing", count: 5, share: 5 / 18 },
    { page: "https://app.test/invoices/:id", count: 2, share: 2 / 18 },
    { page: "https://app.test/pa", count: 1, share: 1 / 18 },
  ]);
  assert.deepEqual(computeMetrics(input({})).pages, { top: [], withPage: 0, withoutPage: 0 });
});

test("handoff reasons: grouped, top five", () => {
  assert.equal(handoffReasonLabel("AI error: fetch failed (502)"), "AI error");
  assert.equal(handoffReasonLabel("Bug flagged by the AI: POST /api/billing returns 500"), "Bug flagged by the AI");
  assert.equal(handoffReasonLabel("Monthly AI reply cap (2000) reached."), "Monthly AI reply cap reached");
  assert.equal(handoffReasonLabel("  The customer asked   for a person. "), "The customer asked for a person");
  assert.equal(handoffReasonLabel(""), "No reason given");
  assert.equal(handoffReasonLabel("x".repeat(200)).length, 120);

  const reasons = ["Refund request", "refund request.", "Refund request", "AI error: a", "AI error: b", "Wants to cancel", "Angry", "Data deletion", "Zebra"];
  const r = computeMetrics(input({ conversations: reasons.map((reason) => conv(NOW, { handoffReason: reason })) }));
  assert.deepEqual(r.ai.reasons, [
    { reason: "Refund request", count: 3 },
    { reason: "AI error", count: 2 },
    { reason: "Angry", count: 1 },
    { reason: "Data deletion", count: 1 },
    { reason: "Wants to cancel", count: 1 },
  ]);
  assert.equal(r.ai.handedOff, 9);
});

test("first response: first visitor message to first public agent reply", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      conversations: [
        conv(t, { firstAgentAt: t + 30 * S, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 2 * MIN, firstAgentId: "u2" }),
        conv(t, { firstAgentAt: t + 10 * MIN, firstAgentId: "u1" }),
        conv(t, { firstVisitorAt: null, firstAgentAt: t, firstAgentId: "u1" }), // no visitor message: no time
        conv(t, { firstVisitorAt: t + MIN, firstAgentAt: t, firstAgentId: "u1" }), // reply before the question: ignored
      ],
    }),
  );
  assert.equal(r.team.answered, 3);
  assert.deepEqual(r.team.firstResponse, { count: 3, median: 2 * MIN, p90: 10 * MIN });
  assert.equal(durationStat([5, 1, 3, 2]).median, 2.5);
  assert.equal(durationStat(Array.from({ length: 10 }, (_, i) => i + 1)).p90, 9);
  assert.equal(durationStat([7]).p90, 7);
  assert.equal(durationStat([Number.NaN, -1]).count, 0);
});

test("CSAT: ratings given in the period, score, latest bad comments", () => {
  const ratings = [
    { conversationId: "c1", rating: "good" as const, comment: "Great", createdAt: NOW - 5 * MIN },
    { conversationId: "c2", rating: "bad" as const, comment: "  Slow  ", createdAt: NOW - 4 * MIN },
    { conversationId: "c3", rating: "bad" as const, comment: null, createdAt: NOW - 3 * MIN },
    { conversationId: "c4", rating: "good" as const, comment: null, createdAt: NOW - 30 * 24 * 60 * MIN }, // too old
    ...Array.from({ length: 6 }, (_, i) => ({ conversationId: `b${i}`, rating: "bad" as const, comment: `bad ${i}`, createdAt: NOW - 60 * MIN - i * MIN })),
  ];
  const r = computeMetrics(input({ ratings }));
  assert.equal(r.csat.good, 1);
  assert.equal(r.csat.bad, 8);
  assert.equal(r.csat.score, 1 / 9);
  assert.deepEqual(
    r.csat.badComments.map((c) => [c.conversationId, c.comment]),
    [["c2", "Slow"], ["b0", "bad 0"], ["b1", "bad 1"], ["b2", "bad 2"], ["b3", "bad 3"]],
    "newest first, only with a comment, at most five",
  );
});

test("teammates: replies, conversations, and their first responses", () => {
  const t = NOW - 60 * MIN;
  const r = computeMetrics(
    input({
      members: [
        { userId: "u1", name: "Ann" },
        { userId: "u2", name: "Bo" },
        { userId: "u3", name: "Cy" },
      ],
      replies: [
        { userId: "u2", replies: 9, conversations: 4 },
        { userId: "u1", replies: 3, conversations: 2 },
        { userId: "gone", replies: 1, conversations: 1 },
      ],
      conversations: [
        conv(t, { firstAgentAt: t + MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 3 * MIN, firstAgentId: "u1" }),
        conv(t, { firstAgentAt: t + 20 * S, firstAgentId: "u2" }),
      ],
    }),
  );
  assert.deepEqual(
    r.teammates.map((m) => [m.name, m.replies, m.conversations, m.firstResponse.median]),
    [["Bo", 9, 4, 20 * S], ["Ann", 3, 2, 2 * MIN], ["Former teammate", 1, 1, null], ["Cy", 0, 0, null]],
  );
});

test("the cap is passed through", () => {
  assert.equal(computeMetrics(input({ truncated: true })).truncated, true);
});

test("durations read like a person wrote them", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45 * S), "45s");
  assert.equal(formatDuration(59.6 * S), "1m");
  assert.equal(formatDuration(3 * MIN + 10 * S), "3m");
  assert.equal(formatDuration(59 * MIN + 40 * S), "1h");
  assert.equal(formatDuration(80 * MIN), "1h 20m");
  assert.equal(formatDuration(2 * 24 * 60 * MIN + 4 * 60 * MIN), "2d 4h");
  assert.equal(formatDuration(3 * 24 * 60 * MIN), "3d");
  assert.equal(formatDuration(-5), "0s");
});

test("topics (A-02): counts, share of labelled chats, AI resolution per topic", () => {
  const billing = { topicId: "top_b", topicName: "Billing" };
  const login = { topicId: "top_l", topicName: "Login" };
  const r = computeMetrics(
    input({
      conversations: [
        conv(NOW, { ...billing, firstAiAt: NOW + S }), // AI resolved
        conv(NOW, { ...billing, firstAiAt: NOW + S, handoffReason: "The customer asked for a person." }),
        conv(NOW, { ...billing }), // team only: not an AI conversation
        conv(NOW, { ...login, firstAiAt: NOW + S }),
        conv(NOW, { topicId: "top_x", topicName: null }), // topic deleted meanwhile: unlabeled
        conv(NOW), // not labelled yet
        conv(NOW, { firstVisitorAt: null }), // no visitor message: never labelled, not counted
        conv(NOW - 30 * 24 * 60 * MIN, { ...login }), // outside the period
      ],
    }),
  );
  assert.deepEqual(r.topics, {
    list: [
      { id: "top_b", name: "Billing", count: 3, share: 3 / 4, aiResolutionRate: 1 / 2, aiResolved: 1 },
      { id: "top_l", name: "Login", count: 1, share: 1 / 4, aiResolutionRate: 1, aiResolved: 1 },
    ],
    labeled: 4,
    unlabeled: 2,
  });
  assert.deepEqual(computeMetrics(input({})).topics, { list: [], labeled: 0, unlabeled: 0 });
  // Ties sort by name; a topic with no AI conversations has no rate.
  const tie = computeMetrics(input({ conversations: [conv(NOW, login), conv(NOW, billing)] }));
  assert.deepEqual(tie.topics.list.map((t) => [t.name, t.aiResolutionRate]), [["Billing", null], ["Login", null]]);
});
