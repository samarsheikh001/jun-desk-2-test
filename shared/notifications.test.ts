import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contactLabel,
  DEFAULT_NOTIFICATION_PREFS,
  notificationPayload,
  notificationRecipients,
  parseNotificationPrefs,
  readNotificationPrefs,
  type NotificationPrefs,
} from "./notifications.ts";

const on = DEFAULT_NOTIFICATION_PREFS;
const off: NotificationPrefs = { needsPerson: false, assigned: false, visitorReply: false, mention: false, sound: false };
const team = (prefs: Record<string, Partial<NotificationPrefs>> = {}) =>
  ["ann", "bo", "cy"].map((userId) => ({ userId, prefs: { ...on, ...prefs[userId] } }));

test("needs a person: every member who wants it; nobody is the actor (the AI or the visitor)", () => {
  assert.deepEqual(notificationRecipients({ kind: "needs_person", conversationId: "c", actorId: null }, team()), ["ann", "bo", "cy"]);
  assert.deepEqual(notificationRecipients({ kind: "needs_person", conversationId: "c", actorId: null }, team({ bo: { needsPerson: false } })), ["ann", "cy"]);
});

test("assigned: only the assignee, never when you assign yourself; round robin honours either toggle", () => {
  assert.deepEqual(notificationRecipients({ kind: "assigned", conversationId: "c", actorId: "ann", targets: ["bo"] }, team()), ["bo"]);
  assert.deepEqual(notificationRecipients({ kind: "assigned", conversationId: "c", actorId: "bo", targets: ["bo"] }, team()), []);
  assert.deepEqual(notificationRecipients({ kind: "assigned", conversationId: "c", actorId: "ann", targets: ["bo"] }, team({ bo: { assigned: false } })), []);
  // Round robin as the chat needed a person: "needs a person" alone is enough, as is "assigned".
  const auto = { kind: "assigned" as const, conversationId: "c", actorId: null, targets: ["cy"], auto: true };
  assert.deepEqual(notificationRecipients(auto, team({ cy: { assigned: false } })), ["cy"]);
  assert.deepEqual(notificationRecipients(auto, team({ cy: { needsPerson: false } })), ["cy"]);
  assert.deepEqual(notificationRecipients(auto, team({ cy: off })), []);
  assert.deepEqual(notificationRecipients({ ...auto, auto: false }, team({ cy: { assigned: false } })), []);
});

test("visitor reply goes to the assignee; mentions to the mentioned, not the author; removed members get nothing", () => {
  assert.deepEqual(notificationRecipients({ kind: "visitor_reply", conversationId: "c", actorId: null, targets: ["ann"] }, team()), ["ann"]);
  assert.deepEqual(notificationRecipients({ kind: "visitor_reply", conversationId: "c", actorId: null, targets: ["ann"] }, team({ ann: { visitorReply: false } })), []);
  assert.deepEqual(notificationRecipients({ kind: "mention", conversationId: "c", actorId: "ann", targets: ["ann", "bo", "cy", "cy"] }, team({ cy: { mention: false } })), ["bo"]);
  assert.deepEqual(notificationRecipients({ kind: "mention", conversationId: "c", actorId: null, targets: ["gone"] }, team()), []);
});

test("prefs: defaults all on, partial updates, validation", () => {
  assert.deepEqual(readNotificationPrefs(null), on);
  assert.deepEqual(readNotificationPrefs("not json"), on);
  assert.deepEqual(readNotificationPrefs('{"mention":false,"junk":1,"assigned":"no"}'), { ...on, mention: false });
  assert.deepEqual(parseNotificationPrefs({ visitorReply: false }, { ...on, mention: false }), { ...on, mention: false, visitorReply: false });
  assert.throws(() => parseNotificationPrefs({ volume: 1 }), /Unknown/);
  assert.throws(() => parseNotificationPrefs({ mention: "off" }), /true or false/);
  assert.throws(() => parseNotificationPrefs([]), /object/);
});

test("sound: on by default, a per-person boolean, and it never changes who is notified", () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFS.sound, true);
  assert.equal(readNotificationPrefs('{"sound":false}').sound, false);
  assert.equal(readNotificationPrefs('{"sound":"off"}').sound, true);
  assert.equal(parseNotificationPrefs({ sound: false }).sound, false);
  assert.deepEqual(parseNotificationPrefs({ sound: false }, { ...on, mention: false }), { ...on, mention: false, sound: false });
  assert.throws(() => parseNotificationPrefs({ sound: "no" }), /sound must be true or false/);
  assert.deepEqual(notificationRecipients({ kind: "needs_person", conversationId: "c", actorId: null }, team({ bo: { sound: false } })), ["ann", "bo", "cy"]);
});

test("payload: contact label, ~100 characters, url and tag of the conversation", () => {
  const anon = contactLabel({ id: "ct_abc", name: null, email: null });
  assert.match(anon, /^Visitor #\d{4}$/);
  assert.equal(contactLabel({ id: "ct_abc", name: null, email: "ana@acme.test" }), "ana@acme.test");
  const long = "word ".repeat(60);
  const p = notificationPayload({ id: "n1", kind: "visitor_reply", conversationId: "cv_1", contact: "Ana", text: long });
  assert.equal(p.title, "Ana replied");
  assert.ok(p.body.length <= 100 && p.body.endsWith("…"));
  assert.equal(p.url, "/inbox/cv_1");
  assert.equal(p.tag, "cv_1");
  assert.equal(notificationPayload({ id: "n", kind: "needs_person", conversationId: "c", contact: "Ana", text: "Help" }).title, "Ana needs a person");
  assert.equal(notificationPayload({ id: "n", kind: "assigned", conversationId: "c", contact: "Ana", text: "", by: "Bo" }).title, "Bo assigned you Ana");
  assert.equal(notificationPayload({ id: "n", kind: "assigned", conversationId: "c", contact: "Ana", text: "", auto: true }).title, "New chat assigned to you: Ana");
  assert.equal(notificationPayload({ id: "n", kind: "mention", conversationId: "c", contact: "Ana", text: "@Bo look", by: "Cy" }).title, "Cy mentioned you (Ana)");
  assert.equal(notificationPayload({ id: "n", kind: "visitor_reply", conversationId: "c", contact: "Ana", text: "" }).body, "Open the conversation to reply.");
});
