import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageAction } from "./actions.ts";
import { islandLine, WAITING_CARD_MS } from "./island.ts";
import type { Message } from "./protocol.ts";
import type { MessageWidget } from "./widgets.ts";

const NOW = 1_800_000_000_000;
let seq = 0;
const msg = (authorType: Message["authorType"], body: string, meta: Message["meta"] = {}, age = 1000): Message => ({
  id: `msg_${++seq}`,
  seq,
  authorType,
  authorId: null,
  authorName: null,
  body,
  attachments: [],
  clientMsgId: `c${seq}`,
  createdAt: NOW - age,
  internal: false,
  meta,
});
const rideCard = (used = false): MessageWidget =>
  ({
    id: "w1",
    name: "confirm_job",
    summary: "Get a ride · Scheduled pickup",
    ...(used ? { used: true } : {}),
    root: { type: "Card", confirm: { label: "Confirm job", action: { type: "page:search_prices" } }, children: [{ type: "Text", value: "Pickup: Changi" }] },
  }) as unknown as MessageWidget;
const confirmAction = (status: MessageAction["status"]): MessageAction =>
  ({ runId: "r1", id: "upgrade_plan", name: "upgrade_plan", description: "Change this account's plan", input: { plan: "growth" }, params: {}, missing: [], risk: "confirm", status }) as unknown as MessageAction;

test("D-80: a widget still waiting on the visitor is the pill's line, by its title", () => {
  const line = islandLine([msg("visitor", "Book me a ride"), msg("ai", "Your ride is ready", { widgets: [rideCard()] })], NOW);
  assert.deepEqual(line, { text: "Get a ride · tap to finish", waiting: true });
});

test("D-80: a Confirm waiting wins, in the action's own words", () => {
  const line = islandLine([msg("visitor", "Move me to growth"), msg("ai", "I can do that", { action: confirmAction("pending") })], NOW);
  assert.deepEqual(line, { text: "Change this account's plan · tap to finish", waiting: true });
});

test("D-80: a used card, or one older than the limit, falls back to the last reply", () => {
  const used = islandLine([msg("visitor", "Book"), msg("ai", "Booked. Your driver is on the way.", { widgets: [rideCard(true)] })], NOW);
  assert.equal(used?.waiting, false);
  const old = islandLine([msg("visitor", "Book", {}, WAITING_CARD_MS + 5000), msg("ai", "Ready", { widgets: [rideCard()] }, WAITING_CARD_MS + 1000)], NOW);
  assert.equal(old?.waiting, false);
});

test("D-80: a card from an earlier exchange doesn't count; internal notes never reach the line", () => {
  const line = islandLine([msg("visitor", "Book"), msg("ai", "Ready", { widgets: [rideCard()] }), msg("visitor", "Never mind"), msg("ai", "No problem. Anything else?")], NOW);
  assert.deepEqual(line, { text: "No problem.", waiting: false });
  const note = { ...msg("agent", "Internal: refund approved."), internal: true };
  assert.deepEqual(islandLine([msg("visitor", "Hi"), msg("ai", "Hello there."), note], NOW), { text: "Hello there.", waiting: false });
});
