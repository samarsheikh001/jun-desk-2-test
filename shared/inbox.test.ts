import assert from "node:assert/strict";
import { test } from "node:test";
import { assignmentSettings, DEFAULT_ASSIGNMENT, fillSavedReply, findMentions, mentionParts, normalizeTag, offersRating, parseAssignment, parseRating, pickAssignee } from "./inbox.ts";

const team = [
  { id: "u1", name: "Ann" },
  { id: "u2", name: "Ann Lee" },
  { id: "u3", name: "Bo" },
  { id: "u4", name: "Jörg" },
];

test("mentions: names match case-insensitively, longest first, whole words only", () => {
  assert.deepEqual(findMentions("@ann can you look?", team), ["u1"]);
  assert.deepEqual(findMentions("cc @Ann Lee and @bo", team), ["u2", "u3"]);
  assert.deepEqual(findMentions("@Anna isn't on the team, @Bob neither", team), []);
  assert.deepEqual(findMentions("mail ann@bo.com", team), [], "an email address is not a mention");
  assert.deepEqual(findMentions("@Jörg, @Bo. @bo again", team), ["u4", "u3"]);
  assert.deepEqual(findMentions("no mentions here", team), []);
});

test("mention parts for highlighting", () => {
  assert.deepEqual(mentionParts("hey @Ann Lee, see this", ["Ann", "Ann Lee"]), [
    { text: "hey ", mention: false },
    { text: "@Ann Lee", mention: true },
    { text: ", see this", mention: false },
  ]);
  assert.deepEqual(mentionParts("@Bo", ["Bo"]), [{ text: "@Bo", mention: true }]);
});

test("saved reply placeholders", () => {
  assert.equal(fillSavedReply("Hi {first_name}, {agent_name} here.", { customerName: "Maria Lopez", agentName: "Nina" }), "Hi Maria, Nina here.");
  assert.equal(fillSavedReply("Hi {first_name}!", { customerName: null, agentName: "Nina" }), "Hi there!");
});

test("tag names", () => {
  assert.equal(normalizeTag("  #Billing   bug "), "Billing bug");
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("x".repeat(41)), null);
  assert.equal(normalizeTag(3), null);
});

test("CSAT: ratings are good or bad, with an optional trimmed comment of at most 1000 characters", () => {
  assert.deepEqual(parseRating({ rating: "good" }), { rating: "good", comment: "" });
  assert.deepEqual(parseRating({ rating: "bad", comment: "  too slow \n" }),{ rating: "bad", comment: "too slow" });
  assert.deepEqual(parseRating({ rating: "bad", comment: null }), { rating: "bad", comment: "" });
  assert.equal(parseRating({ rating: "good", comment: "x".repeat(1000) }).comment.length, 1000);
  assert.throws(() => parseRating({ rating: "good", comment: "x".repeat(1001) }), /1000 characters/);
  assert.throws(() => parseRating({ rating: "great" }), /good or bad/);
  assert.throws(() => parseRating({}), /good or bad/);
  assert.throws(() => parseRating({ rating: "good", comment: 5 }), /text/);
});

test("CSAT: offered for resolved conversations someone answered, when ratings are on", () => {
  const visitor = { authorType: "visitor" as const, internal: false };
  const agent = { authorType: "agent" as const, internal: false };
  const ai = { authorType: "ai" as const, internal: false };
  assert.equal(offersRating(true, "resolved", [visitor, agent]), true);
  assert.equal(offersRating(true, "resolved", [visitor, ai]), true, "AI-resolved chats count");
  assert.equal(offersRating(false, "resolved", [visitor, agent]), false, "turned off");
  assert.equal(offersRating(true, "open", [visitor, agent]), false);
  assert.equal(offersRating(true, "resolved", [visitor, { authorType: "system", internal: false }]), false, "nobody replied");
  assert.equal(offersRating(true, "resolved", [visitor, { authorType: "agent", internal: true }]), false, "a note isn't a reply");
});

test("assignment settings: manual or round robin, with a 0–100 cap", () => {
  assert.deepEqual(parseAssignment({ mode: "round_robin", capacity: 5 }), { mode: "round_robin", capacity: 5 });
  assert.deepEqual(parseAssignment({ mode: "manual" }), { mode: "manual", capacity: 0 });
  assert.throws(() => parseAssignment({ mode: "random" }), /manual or round_robin/);
  assert.throws(() => parseAssignment({ mode: "round_robin", capacity: -1 }), /whole number/);
  assert.throws(() => parseAssignment({ mode: "round_robin", capacity: 2.5 }), /whole number/);
  assert.deepEqual(assignmentSettings(undefined), DEFAULT_ASSIGNMENT, "unset means manual");
  assert.deepEqual(assignmentSettings({ mode: "nope" }), DEFAULT_ASSIGNMENT);
});

test("round robin: longest wait first, the cap skips busy teammates, nobody eligible means null", () => {
  const team = [
    { userId: "u1", open: 0, lastAssignedAt: 300 },
    { userId: "u2", open: 4, lastAssignedAt: 100 },
    { userId: "u3", open: 1, lastAssignedAt: 200 },
  ];
  assert.equal(pickAssignee(team, 0), "u2", "waited longest");
  assert.equal(pickAssignee(team, 3), "u3", "u2 is at the cap");
  assert.equal(pickAssignee(team, 1), "u1");
  assert.equal(pickAssignee([{ userId: "u1", open: 2, lastAssignedAt: 0 }], 2), null);
  assert.equal(pickAssignee([], 0), null);
  assert.equal(pickAssignee([{ userId: "b", open: 1, lastAssignedAt: 0 }, { userId: "a", open: 1, lastAssignedAt: 0 }, { userId: "c", open: 0, lastAssignedAt: 0 }], 0), "c", "never assigned: fewer open chats first");
  assert.equal(pickAssignee([{ userId: "b", open: 0, lastAssignedAt: 0 }, { userId: "a", open: 0, lastAssignedAt: 0 }], 0), "a", "then a stable order");
});
