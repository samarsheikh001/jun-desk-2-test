import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationIntent, isIntentName } from "./intents.ts";

test("intent names: lowercase letters, digits, _ and -, at most 40 characters", () => {
  for (const ok of ["cancel", "downgrade-plan", "trial_end", "a", "x".repeat(40)]) assert.equal(isIntentName(ok), true, ok);
  for (const bad of ["", "Cancel", "cancel now", "x".repeat(41), "../x", 42, null, undefined]) assert.equal(isIntentName(bad), false, String(bad));
});

test("a conversation's intent: name and exit time, null for ordinary chats", () => {
  assert.equal(conversationIntent(null, null), null);
  assert.deepEqual(conversationIntent("cancel", null), { name: "cancel", exitedAt: null });
  assert.deepEqual(conversationIntent("cancel", 1_700_000_000_000), { name: "cancel", exitedAt: 1_700_000_000_000 });
});
