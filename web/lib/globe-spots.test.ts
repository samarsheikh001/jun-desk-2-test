import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveVisitor } from "../../shared/protocol.ts";
import { globeSpots } from "./globe-spots.ts";

const visitor = (sessionId: string, location: [number, number] | null, city: string | null = null) => ({ sessionId, location, city }) as LiveVisitor;

test("globe spots: one per rounded location, labelled by the first visitor, counted", () => {
  const spots = globeSpots(
    [visitor("a", [38.7, -9.1], "Lisbon"), visitor("b", [51.5, -0.1], "London"), visitor("c", [38.7, -9.1], "Lisbon"), visitor("d", null, "Nowhere")],
    (v) => v.city ?? "?",
  );
  assert.deepEqual(spots, [
    { id: "38.7,-9.1", location: [38.7, -9.1], label: "Lisbon +1", sessionIds: ["a", "c"] },
    { id: "51.5,-0.1", location: [51.5, -0.1], label: "London", sessionIds: ["b"] },
  ]);
});
