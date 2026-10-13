// Builds public/geo/world.v1.json, the map behind the Visitors globe (web/visitors/VisitorGlobe.tsx),
// from Natural Earth (public domain, https://www.naturalearthdata.com/), pinned to a release:
//
//   node scripts/globe-data.ts            # downloads into .tmp/natural-earth/, writes public/geo/
//
// Shapes are simplified (Douglas-Peucker), rounded to 2 decimals and stripped to the properties
// the style uses. The file is served as immutable (public/_headers): when it changes, bump the
// version in its name here and in VisitorGlobe.tsx.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE = "v5.1.2";
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${RELEASE}/geojson`;
const CACHE = ".tmp/natural-earth";
const OUT = "public/geo/world.v1.json";

type Position = [number, number];
type Ring = Position[];
interface Geometry { type: string; coordinates: unknown }
interface Feature { type: "Feature"; properties: Record<string, unknown>; geometry: Geometry }
interface Collection { type: "FeatureCollection"; features: Feature[] }

async function load(name: string): Promise<Collection> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.geojson`);
  if (!existsSync(file)) {
    const res = await fetch(`${BASE}/${name}.geojson`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    writeFileSync(file, await res.text());
  }
  return JSON.parse(readFileSync(file, "utf8")) as Collection;
}

const round = (n: number) => Math.round(n * 100) / 100;

function perpendicular(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker (iterative), then rounding and dropping repeated points. */
function simplify(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let max = 0;
    let index = 0;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i]!, points[first]!, points[last]!);
      if (d > max) [max, index] = [d, i];
    }
    if (max > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Position[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!keep[i]) continue;
    const p: Position = [round(points[i]![0]), round(points[i]![1])];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  return out;
}

function area(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  return Math.abs(sum / 2);
}

/** Polygons as lists of rings, whatever the geometry type. */
const polygonsOf = (g: Geometry): Ring[][] => (g.type === "Polygon" ? [g.coordinates as Ring[]] : g.type === "MultiPolygon" ? (g.coordinates as Ring[][]) : []);

/** Simplified (Multi)Polygon, without rings smaller than `minArea` square degrees; null if nothing is left. */
function polygons(g: Geometry, tolerance: number, minArea: number): Geometry | null {
  const out: Ring[][] = [];
  for (const poly of polygonsOf(g)) {
    const outer = simplify(poly[0]!, tolerance);
    if (outer.length < 4 || area(outer) < minArea) continue;
    const holes = poly.slice(1).map((r) => simplify(r, tolerance)).filter((r) => r.length >= 4 && area(r) >= minArea);
    out.push([outer, ...holes]);
  }
  if (!out.length) return null;
  return out.length === 1 ? { type: "Polygon", coordinates: out[0] } : { type: "MultiPolygon", coordinates: out };
}

function lines(g: Geometry, tolerance: number): Geometry | null {
  const parts = (g.type === "LineString" ? [g.coordinates as Position[]] : (g.coordinates as Position[][])).map((l) => simplify(l, tolerance)).filter((l) => l.length >= 2);
  if (!parts.length) return null;
  return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
}

const point = (lng: number, lat: number): Geometry => ({ type: "Point", coordinates: [round(lng), round(lat)] });

function collection(features: (Feature | null)[]): Collection {
  return { type: "FeatureCollection", features: features.filter((f): f is Feature => f !== null) };
}

function feature(properties: Record<string, unknown>, geometry: Geometry | null): Feature | null {
  return geometry ? { type: "Feature", properties, geometry } : null;
}

const pointInRing = (p: Position, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** A label point well inside the largest polygon (coarse pole of inaccessibility). */
function labelPoint(g: Geometry): Position {
  const poly = polygonsOf(g).sort((a, b) => area(b[0]!) - area(a[0]!))[0]!;
  const outer = poly[0]!;
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best: Position = [(minX + maxX) / 2, (minY + maxY) / 2];
  let bestDistance = -1;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p: Position = [minX + ((maxX - minX) * i) / steps, minY + ((maxY - minY) * j) / steps];
      if (!pointInRing(p, outer) || poly.slice(1).some((hole) => pointInRing(p, hole))) continue;
      let d = Infinity;
      for (const ring of poly) for (let k = 1; k < ring.length; k++) d = Math.min(d, perpendicular(p, ring[k - 1]!, ring[k]!));
      if (d > bestDistance) [best, bestDistance] = [p, d];
    }
  }
  return best;
}

const iso = (p: Record<string, unknown>) => [p.ISO_A2_EH, p.ISO_A2].find((v): v is string => typeof v === "string" && /^[A-Z]{2}$/.test(v)) ?? "";
const title = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());

const countries = await load("ne_50m_admin_0_countries");
const borders = await load("ne_50m_admin_0_boundary_lines_land");
const lakes = await load("ne_50m_lakes");
const glaciers = await load("ne_110m_glaciated_areas");
const regions = await load("ne_110m_geography_regions_polys");
const marine = await load("ne_110m_geography_marine_polys");
const places = await load("ne_110m_populated_places_simple");
const depths = await Promise.all([200, 2000, 4000].map(async (depth) => ({ depth, data: await load(`ne_10m_bathymetry_${({ 200: "K", 2000: "I", 4000: "G" } as Record<number, string>)[depth]}_${depth}`) })));

const world = {
  // Land, by country (iso: tinted when someone's visiting from there).
  countries: collection(countries.features.map((f) => feature({ iso: iso(f.properties) }, polygons(f.geometry, 0.07, 0.03)))),
  borders: collection(borders.features.map((f) => feature({}, lines(f.geometry, 0.07)))),
  lakes: collection(lakes.features.filter((f) => Number(f.properties.scalerank) <= 3).map((f) => feature({}, polygons(f.geometry, 0.04, 0.3)))),
  ice: collection(glaciers.features.map((f) => feature({}, polygons(f.geometry, 0.08, 0.5)))),
  // Deserts, high plateaus and mountain ranges: paler land, like a landcover layer.
  barren: collection(regions.features.filter((f) => /Desert|Range\/mtn|Plateau/.test(String(f.properties.FEATURECLA)) && !/Antarc|Polar/i.test(String(f.properties.NAME))).map((f) => feature({}, polygons(f.geometry, 0.15, 1)))),
  // Ocean deeper than 200 m, 2000 m, 4000 m: darker blues over the shallow shelf colour.
  depth: collection(depths.flatMap(({ depth, data }) => data.features.map((f) => feature({ depth }, polygons(f.geometry, 0.3, 3))))),
  countryLabels: collection(
    countries.features
      .filter((f) => typeof f.properties.LABEL_X === "number")
      // minz: Natural Earth's suggested zoom for the label (big countries ~2, small islands ~5+).
      .map((f) => feature({ name: f.properties.NAME, rank: f.properties.LABELRANK, minz: f.properties.MIN_LABEL }, point(f.properties.LABEL_X as number, f.properties.LABEL_Y as number))),
  ),
  seaLabels: collection(marine.features.map((f) => {
    const [lng, lat] = labelPoint(f.geometry);
    return feature({ name: title(String(f.properties.name)), rank: f.properties.scalerank, ocean: f.properties.featurecla === "ocean" }, point(lng, lat));
  })),
  cities: collection(
    places.features
      .map((f) => feature({ name: f.properties.name, rank: f.properties.scalerank, minz: f.properties.min_zoom }, point(f.properties.longitude as number, f.properties.latitude as number))),
  ),
};

mkdirSync("public/geo", { recursive: true });
const json = JSON.stringify(world);
writeFileSync(OUT, json);
const { gzipSync } = await import("node:zlib");
console.log(`${OUT}: ${(json.length / 1024).toFixed(0)} KB, ${(gzipSync(json).length / 1024).toFixed(0)} KB gzipped`);
for (const [name, fc] of Object.entries(world)) console.log(`  ${name}: ${fc.features.length} features, ${(JSON.stringify(fc).length / 1024).toFixed(0)} KB`);
