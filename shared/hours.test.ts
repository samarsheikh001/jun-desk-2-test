import assert from "node:assert/strict";
import { test } from "node:test";
import { awayText, describeOpening, isOpen, nextOpening, parseHours } from "./hours.ts";

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:30" }));
const london = parseHours({ enabled: true, timezone: "Europe/London", days: weekdays, awayMessage: "" });

test("open and closed in the business's time zone", () => {
  // Monday 5 Oct 2026, 10:00 London (BST, UTC+1) = 09:00 UTC.
  assert.equal(isOpen(london, Date.parse("2026-10-05T09:00:00Z")), true);
  assert.equal(isOpen(london, Date.parse("2026-10-05T16:29:00Z")), true); // 17:29 London
  assert.equal(isOpen(london, Date.parse("2026-10-05T16:30:00Z")), false); // 17:30 London
  assert.equal(isOpen(london, Date.parse("2026-10-04T12:00:00Z")), false); // Sunday
  assert.equal(isOpen({ ...london, enabled: false }, Date.parse("2026-10-04T12:00:00Z")), true, "hours off = always open");
});

test("next opening, across a weekend and a DST change", () => {
  // Friday 23 Oct 2026, 18:00 London → Monday 26 Oct 09:00 London; clocks go back on Sunday 25 Oct.
  const friday = Date.parse("2026-10-23T17:00:00Z");
  assert.equal(new Date(nextOpening(london, friday)!).toISOString(), "2026-10-26T09:00:00.000Z"); // GMT again
  assert.equal(nextOpening(london, Date.parse("2026-10-05T09:00:00Z")), null, "open now");
  assert.equal(describeOpening(Date.parse("2026-10-26T09:00:00Z"), "Europe/London", friday), "Monday at 09:00 (London time)");
  // Monday 07:00 London → today at 09:00.
  assert.equal(awayText(london, Date.parse("2026-10-05T06:00:00Z")), "Thanks for your message! Our team is away right now and will reply here today at 09:00 (London time).");
  assert.equal(awayText(london, friday), "Thanks for your message! Our team is away right now and will reply here on Monday at 09:00 (London time).");
});

test("hours are validated with readable errors", () => {
  assert.throws(() => parseHours({ timezone: "Mars/Olympus", days: [] }), /time zone/);
  assert.throws(() => parseHours({ timezone: "UTC", days: [{ day: 1, start: "9am", end: "17:00" }] }), /Monday: use times/);
  assert.throws(() => parseHours({ timezone: "UTC", days: [{ day: 2, start: "17:00", end: "09:00" }] }), /Tuesday: closing time/);
  assert.equal(parseHours({ timezone: "Asia/Kolkata", days: [{ day: 6, start: "10:00", end: "24:00" }] }).days[0]!.end, "24:00");
});
