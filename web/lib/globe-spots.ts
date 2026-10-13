import type { LiveVisitor } from "../../shared/protocol.ts";

/** Visitors at the same rounded spot share a marker (and a label) on the Visitors globe. */
export interface GlobeSpot {
  /** The rounded "lat,lng": stable while the same people are there. */
  id: string;
  location: [number, number];
  label: string;
  sessionIds: string[];
}

export function globeSpots(visitors: LiveVisitor[], labelOf: (v: LiveVisitor) => string): GlobeSpot[] {
  const spots = new Map<string, GlobeSpot>();
  for (const v of visitors) {
    if (!v.location) continue;
    const id = v.location.join(",");
    const spot = spots.get(id);
    if (spot) spot.sessionIds.push(v.sessionId);
    else spots.set(id, { id, location: v.location, label: labelOf(v), sessionIds: [v.sessionId] });
  }
  return [...spots.values()].map((s) => (s.sessionIds.length > 1 ? { ...s, label: `${s.label} +${s.sessionIds.length - 1}` } : s));
}
