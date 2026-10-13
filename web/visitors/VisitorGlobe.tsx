import { useEffect, useRef, useState } from "react";
import { Map as MapLibre, Marker, setWorkerUrl, type ExpressionSpecification, type GeoJSONSourceSpecification, type LayerSpecification, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre finds its worker next to its own module, which Vite's bundling breaks: hand Vite the
// worker as an entry of its own and tell MapLibre where it ended up.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { GlobeSpot } from "../lib/globe-spots.ts";

setWorkerUrl(workerUrl);

// V-01: live visitors on a 3D globe (MapLibre, globe projection). The whole map is one static file
// (public/geo/world.v1.json, built by scripts/globe-data.ts from Natural Earth, ~220 KB gzipped,
// cached forever) and labels are drawn with the desk's own font, so there are no tiles, glyph
// server or map service. Loaded lazily: only the Visitors page pays for MapLibre.
// Drag to spin, Ctrl/⌘ + scroll to zoom (two zoom steps); hovering a visitor in the table
// turns the globe to them.

const WORLD_URL = "/geo/world.v1.json";
const FONT = "Outfit";
/** How far you can zoom in from the whole globe. */
const ZOOM_STEPS = 2;
/** Degrees of longitude per second while idle. */
const SPIN = 4;

type World = Record<"countries" | "borders" | "lakes" | "ice" | "barren" | "depth" | "countryLabels" | "seaLabels" | "cities", GeoJSONSourceSpecification["data"]>;

/** Map colours: a bright atlas by day, the same map at night. Not theme tokens: a map wants colour. */
const PALETTES = {
  light: {
    shelf: "#a6dffa", deep200: "#8fd5f8", deep2000: "#78cbf5", deep4000: "#63c1f2",
    land: "#d3eec5", visited: "#b4e09b", barren: "#eef2e2", ice: "#ffffff", lake: "#8fd5f8",
    border: "#e49aae", text: "#2b2f33", halo: "rgba(255,255,255,0.9)", sea: "#2f86c2", city: "#2b2f33",
  },
  dark: {
    shelf: "#173c5e", deep200: "#133555", deep2000: "#0f2d4b", deep4000: "#0c2641",
    land: "#284a33", visited: "#3a6b43", barren: "#33493a", ice: "#c9d6dc", lake: "#133555",
    border: "#b0687e", text: "#e9ecef", halo: "rgba(10,14,20,0.85)", sea: "#7db6e3", city: "#e9ecef",
  },
};
type Palette = (typeof PALETTES)["light"];

const palette = (): Palette => (document.documentElement.dataset.theme === "dark" ? PALETTES.dark : PALETTES.light);

const landFill = (p: Palette, countries: string[]): ExpressionSpecification | string =>
  countries.length ? ["case", ["in", ["get", "iso"], ["literal", countries]], p.visited, p.land] : p.land;

/** Every colour in the style, by layer: set at start and again when the theme changes. */
function paints(p: Palette, countries: string[]): Record<string, Record<string, unknown>> {
  return {
    ocean: { "background-color": p.shelf },
    depth: { "fill-color": ["match", ["get", "depth"], 200, p.deep200, 2000, p.deep2000, p.deep4000] },
    land: { "fill-color": landFill(p, countries) },
    barren: { "fill-color": p.barren },
    ice: { "fill-color": p.ice },
    lakes: { "fill-color": p.lake },
    borders: { "line-color": p.border },
    "sea-labels": { "text-color": p.sea, "text-halo-color": p.halo },
    "city-labels": { "text-color": p.text, "text-halo-color": p.halo },
    "country-labels": { "text-color": p.text, "text-halo-color": p.halo },
  };
}

function style(world: World, countries: string[]): StyleSpecification {
  const colour = paints(palette(), countries);
  const layers: LayerSpecification[] = [
    { id: "ocean", type: "background", paint: {} },
    // Depth bands overlap (4000 m lies inside 2000 m inside 200 m): drawn shallow to deep.
    { id: "depth", type: "fill", source: "depth", paint: { "fill-antialias": false } },
    { id: "land", type: "fill", source: "countries", paint: {} },
    { id: "barren", type: "fill", source: "barren", paint: { "fill-opacity": 0.75, "fill-antialias": false } },
    { id: "ice", type: "fill", source: "ice", paint: { "fill-opacity": 0.9 } },
    { id: "lakes", type: "fill", source: "lakes", paint: {} },
    { id: "borders", type: "line", source: "borders", paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 4, 1.2] } },
    {
      id: "sea-labels", type: "symbol", source: "seaLabels",
      layout: { "text-field": ["get", "name"], "text-font": [FONT], "text-size": ["case", ["get", "ocean"], 13, 11], "text-letter-spacing": ["case", ["get", "ocean"], 0.25, 0.1], "text-max-width": 6, "symbol-sort-key": ["get", "rank"] },
      paint: { "text-halo-width": 0 },
    },
    // The dot is part of the label ("• Mumbai"), so a city whose name doesn't fit shows no orphan dot.
    // minz is Natural Earth's zoom for the place; the globe starts around zoom 2.
    {
      id: "city-labels", type: "symbol", source: "cities",
      filter: ["<=", ["get", "minz"], ["+", ["zoom"], 1]],
      layout: { "text-field": ["format", "• ", { "font-scale": 1.5 }, ["get", "name"], {}], "text-font": [FONT], "text-size": 10.5, "text-anchor": "left", "text-offset": [-0.4, -0.1], "symbol-sort-key": ["get", "rank"] },
      paint: { "text-halo-width": 1.2 },
    },
    {
      id: "country-labels", type: "symbol", source: "countryLabels",
      filter: ["<=", ["get", "minz"], ["+", ["zoom"], 1.5]],
      layout: { "text-field": ["get", "name"], "text-font": [FONT], "text-size": ["interpolate", ["linear"], ["get", "rank"], 1, 13, 6, 10.5], "text-max-width": 7, "symbol-sort-key": ["get", "rank"] },
      paint: { "text-halo-width": 1.4 },
    },
  ];
  for (const layer of layers) Object.assign((layer as { paint: object }).paint, colour[layer.id]);
  return {
    version: 8,
    projection: { type: "globe" },
    // Labels in the desk's font, drawn in the browser (no glyph server).
    "font-faces": { [FONT]: new URL("/fonts/outfit-latin-wght-normal.woff2", location.href).href },
    sources: Object.fromEntries(Object.entries(world).map(([name, data]) => [name, { type: "geojson", data }])),
    layers,
  };
}

/** The zoom at which the globe fills ~90% of a box this wide. */
const fitZoom = (width: number) => Math.log2((Math.PI * width * 1.07) / 512);

function markerElement(spot: GlobeSpot): HTMLElement {
  const el = document.createElement("div");
  el.className = "globe-marker";
  const dot = document.createElement("span");
  dot.className = "globe-marker-dot";
  const label = document.createElement("span");
  label.className = "globe-marker-label";
  label.textContent = spot.label;
  el.append(dot, label);
  return el;
}

let worldRequest: Promise<World> | null = null;
const loadWorld = () => (worldRequest ??= fetch(WORLD_URL).then((r) => (r.ok ? (r.json() as Promise<World>) : Promise.reject(new Error(`HTTP ${r.status}`)))));

export function VisitorGlobe({ spots, countries, focus }: { spots: GlobeSpot[]; countries: string[]; focus: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre | null>(null);
  const markersRef = useRef(new Map<string, { marker: Marker; el: HTMLElement }>());
  const focusRef = useRef<GlobeSpot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const focusSpot = focus ? spots.find((s) => s.sessionIds.includes(focus)) ?? null : null;
  const countriesRef = useRef(countries);
  countriesRef.current = countries;
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  useEffect(() => {
    const host = hostRef.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancelled = false;
    let cleanup = () => {};

    loadWorld().then(
      (world) => {
        if (cancelled) return;
        let m: MapLibre;
        try {
          const zoom = fitZoom(host.clientWidth || 320);
          m = new MapLibre({
            container: host,
            style: style(world, countriesRef.current),
            center: [spotsRef.current[0]?.location[1] ?? 10, 20],
            zoom,
            minZoom: zoom,
            maxZoom: zoom + ZOOM_STEPS,
            attributionControl: false,
            cooperativeGestures: true,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            renderWorldCopies: false,
          });
        } catch {
          setFailed("The globe needs WebGL, which this browser has turned off.");
          return;
        }
        m.on("error", (e) => {
          if (/webgl/i.test(String(e.error?.message))) setFailed("The globe needs WebGL, which this browser has turned off.");
        });

        // Spin slowly while nobody is touching it (and nobody is focused), resuming 3 s after a drag.
        let holdUntil = 0;
        const hold = () => (holdUntil = Infinity);
        const release = () => (holdUntil = performance.now() + 3000);
        m.on("mousedown", hold);
        m.on("touchstart", hold);
        m.on("mouseup", release);
        m.on("touchend", release);
        m.on("zoomend", (e) => {
          if (e.originalEvent) release();
        });
        let frame = 0;
        let last = performance.now();
        const tick = (now: number) => {
          const dt = Math.min(now - last, 100) / 1000;
          last = now;
          if (!reduced && !focusRef.current && now > holdUntil && !m.isMoving()) {
            const center = m.getCenter();
            m.setCenter([center.lng + SPIN * dt, center.lat + (20 - center.lat) * dt]);
          }
          frame = requestAnimationFrame(tick);
        };
        m.once("load", () => (frame = requestAnimationFrame(tick)));

        const resize = new ResizeObserver(() => {
          m.resize();
          const zoom = fitZoom(host.clientWidth || 320);
          m.setMinZoom(zoom);
          m.setMaxZoom(zoom + ZOOM_STEPS);
        });
        resize.observe(host);
        const theme = new MutationObserver(() => {
          for (const [layer, props] of Object.entries(paints(palette(), countriesRef.current))) {
            for (const [prop, value] of Object.entries(props)) m.setPaintProperty(layer, prop as never, value as never);
          }
        });
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

        setMap(m);
        cleanup = () => {
          cancelAnimationFrame(frame);
          resize.disconnect();
          theme.disconnect();
          m.remove();
        };
      },
      () => !cancelled && setFailed("Couldn't load the map."),
    );

    const markers = markersRef.current;
    return () => {
      cancelled = true;
      markers.clear();
      cleanup();
      setMap(null);
    };
  }, []);

  // Markers: one per spot, kept across updates so they don't flicker.
  useEffect(() => {
    if (!map) return;
    const markers = markersRef.current;
    const seen = new Set<string>();
    for (const spot of spots) {
      seen.add(spot.id);
      const existing = markers.get(spot.id);
      if (existing) {
        existing.el.querySelector(".globe-marker-label")!.textContent = spot.label;
        existing.el.dataset.count = String(spot.sessionIds.length);
        continue;
      }
      const el = markerElement(spot);
      el.dataset.count = String(spot.sessionIds.length);
      const marker = new Marker({ element: el, anchor: "center", opacityWhenCovered: "0" }).setLngLat([spot.location[1], spot.location[0]]).addTo(map);
      markers.set(spot.id, { marker, el });
    }
    for (const [id, { marker }] of markers) {
      if (seen.has(id)) continue;
      marker.remove();
      markers.delete(id);
    }
  }, [map, spots]);

  // Countries with someone on the site are tinted.
  useEffect(() => {
    if (!map?.getLayer("land")) return;
    map.setPaintProperty("land", "fill-color", landFill(palette(), countries));
  }, [map, countries]);

  // Hovering a visitor in the table: fly there, highlight their marker.
  useEffect(() => {
    focusRef.current = focusSpot;
    for (const [id, { el }] of markersRef.current) el.toggleAttribute("data-focus", id === focusSpot?.id);
    if (map && focusSpot) map.easeTo({ center: [focusSpot.location[1], focusSpot.location[0]], duration: 900 });
  }, [map, focusSpot]);

  return (
    <div className="visitor-globe">
      {failed ? <p className="muted small visitor-globe-failed">{failed}</p> : <div ref={hostRef} className="visitor-globe-host" />}
    </div>
  );
}

export default VisitorGlobe;
