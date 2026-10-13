import assert from "node:assert/strict";
import { test } from "node:test";
import { matchTopic, normalizeTopic, parseTopicOutput, resolveTopics, topicExcerpt, topicInput, topicPagePath, topicPrompt } from "./topics.ts";

test("normalizeTopic: 1-3 words, Title Case, trimmed", () => {
  assert.equal(normalizeTopic("billing"), "Billing");
  assert.equal(normalizeTopic("  password   reset. "), "Password Reset");
  assert.equal(normalizeTopic('"CSV import"'), "CSV Import");
  assert.equal(normalizeTopic("**Login**"), "Login");
  assert.equal(normalizeTopic("refunds and credits"), "Refunds and Credits");
  assert.equal(normalizeTopic("SSO / SAML"), "SSO / SAML");
  assert.equal(normalizeTopic("of the month"), "Of the Month", "a small word first is capitalised");
  assert.equal(normalizeTopic("api keys\n"), "Api Keys");
  assert.equal(normalizeTopic("Node.js SDK"), "Node.js SDK");
  assert.equal(normalizeTopic("problems logging in today"), null, "more than three words");
  assert.equal(normalizeTopic(""), null);
  assert.equal(normalizeTopic("   "), null);
  assert.equal(normalizeTopic("123"), null, "needs a letter");
  assert.equal(normalizeTopic("x".repeat(41)), null);
  assert.equal(normalizeTopic("<script>"), null);
  assert.equal(normalizeTopic("Billing {x}"), null);
  assert.equal(normalizeTopic(42), null);
  assert.equal(normalizeTopic(null), null);
});

test("matchTopic ignores case, spaces and punctuation", () => {
  const existing = ["Billing", "Password Reset", "CSV Import"];
  assert.equal(matchTopic("billing", existing), "Billing");
  assert.equal(matchTopic("Password-Reset", existing), "Password Reset");
  assert.equal(matchTopic("PasswordReset", existing), "Password Reset");
  assert.equal(matchTopic("csv import", existing), "CSV Import");
  assert.equal(matchTopic("Invoices", existing), undefined);
});

test("parseTopicOutput: plain, fenced, wrapped, junk", () => {
  assert.deepEqual(parseTopicOutput('[{"id":"1","topic":"Billing"},{"id":2,"topic":"Login"}]'), [
    { id: "1", topic: "Billing" },
    { id: "2", topic: "Login" },
  ]);
  assert.deepEqual(parseTopicOutput('Sure! Here you go:\n```json\n[{"id": "3", "topic": "Billing"}]\n```\nHope that helps.'), [{ id: "3", topic: "Billing" }]);
  assert.deepEqual(parseTopicOutput('{"topics": [{"id": "1", "topic": "Login"}]}'), [{ id: "1", topic: "Login" }]);
  assert.deepEqual(parseTopicOutput('[{"id":"1"},{"topic":"x"},null,"Billing",{"id":"2","topic":7},{"id":" 4 ","topic":"Login"}]'), [{ id: "4", topic: "Login" }]);
  assert.deepEqual(parseTopicOutput("[]"), []);
  assert.equal(parseTopicOutput("I can't help with that."), null);
  assert.equal(parseTopicOutput('[{"id":"1","topic":"Billing"'), null, "truncated");
  assert.equal(parseTopicOutput('{"topic": "Billing"}'), null);
  assert.equal(parseTopicOutput(""), null);
});

test("resolveTopics reuses existing topics, adds new ones under the cap", () => {
  const out = [
    { id: "1", topic: "billing" },
    { id: "2", topic: "Password reset" },
    { id: "3", topic: "password-reset" },
    { id: "4", topic: "Way too many words here" },
    { id: "9", topic: "Unknown Id" },
    { id: "1", topic: "Second Answer" },
  ];
  const { labels, created } = resolveTopics(out, ["1", "2", "3", "4"], ["Billing"]);
  assert.deepEqual([...labels], [["1", "Billing"], ["2", "Password Reset"], ["3", "Password Reset"]]);
  assert.deepEqual(created, ["Password Reset"]);

  // At the cap: existing topics still match, new ones are dropped.
  const full = Array.from({ length: 40 }, (_, i) => `Topic ${i}`);
  const capped = resolveTopics([{ id: "1", topic: "topic 3" }, { id: "2", topic: "Brand New" }], ["1", "2"], full);
  assert.deepEqual([...capped.labels], [["1", "Topic 3"]]);
  assert.deepEqual(capped.created, []);

  // One slot left: the first new topic takes it, a second distinct one doesn't fit.
  const almost = resolveTopics([{ id: "1", topic: "Alpha" }, { id: "2", topic: "alpha" }, { id: "3", topic: "Beta" }], ["1", "2", "3"], full.slice(0, 39));
  assert.deepEqual([...almost.labels], [["1", "Alpha"], ["2", "Alpha"]]);
  assert.deepEqual(almost.created, ["Alpha"]);
});

test("topicExcerpt: first three visitor messages, two replies at most, no system lines", () => {
  const lines = topicExcerpt([
    { authorType: "ai", body: "Hi! How can I help?" },
    { authorType: "visitor", body: "My card was charged twice" },
    { authorType: "ai", body: "Sorry about that. ".repeat(30) },
    { authorType: "system", body: "Handed to the team" },
    { authorType: "visitor", body: "  " },
    { authorType: "visitor", body: "for March" },
    { authorType: "agent", body: "Looking" },
    { authorType: "agent", body: "Third reply is skipped" },
    { authorType: "visitor", body: "ok" },
    { authorType: "visitor", body: "fourth is past the limit" },
  ]);
  assert.deepEqual(lines.map((l) => l.from), ["Customer", "Support", "Customer", "Support", "Customer"]);
  assert.equal(lines[0]!.text, "My card was charged twice");
  assert.ok(lines[1]!.text.length <= 200 && lines[1]!.text.endsWith("…"));
  assert.equal(lines[4]!.text, "ok");
  assert.deepEqual(topicExcerpt([{ authorType: "visitor", body: "Hi" }, { authorType: "ai", body: "Hello!" }]), [{ from: "Customer", text: "Hi" }], "a trailing reply is dropped");
});

test("prompt and input", () => {
  assert.match(topicPrompt([]), /no topics yet/);
  assert.match(topicPrompt(["Billing"]), /Existing topics: "Billing"/);
  assert.match(topicPrompt(["Billing"], 1), /No new topics can be created/);
  assert.match(topicPrompt(["Billing"], 5), /room for 4 more/);
  assert.equal(
    topicInput([{ id: "1", page: "/billing", lines: [{ from: "Customer", text: "Charged twice" }] }, { id: "2", page: null, lines: [{ from: "Customer", text: "Reset?" }] }]),
    "Conversation 1\nPage: /billing\nCustomer: Charged twice\n\nConversation 2\nCustomer: Reset?",
  );
  assert.equal(topicPagePath("https://acme.com/invoices/:id"), "/invoices/:id");
  assert.equal(topicPagePath(null), null);
  assert.equal(topicPagePath("nope"), null);
});
