import { createElement, useEffect, useState, type ReactNode } from "react";
import type { IconNode } from "lucide";

// W-09: ChatKit's icon names (`Icon name=…`, a Button's iconStart/iconEnd). The documented ones
// are drawn as our own simple 24×24 stroke icons (below). The rest of ChatKit's icon set, and
// ChatKit's `lucide:<name>`, are drawn with Lucide icons (D-51), fetched on demand so a card that
// doesn't use them costs nothing: `icon-set.ts` maps ChatKit's names, `lucide`'s full set serves
// `lucide:` names. A name with no icon draws nothing, as in ChatKit.

const P: Record<string, string> = {
  agent: "M12 3v3M8 9h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3ZM9.5 14h.01M14.5 14h.01M12 6a1 1 0 1 0 0-2",
  analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  atom: "M12 12h.01M4.5 7.5c2-3.5 9.5 0 12 4.5s3.5 8.5 1.5 9.5-6.5-2-9-6.5-6.5-4.5-4.5-7.5ZM19.5 7.5c-2-3.5-9.5 0-12 4.5s-3.5 8.5-1.5 9.5 6.5-2 9-6.5 6.5-4.5 4.5-7.5Z",
  batch: "M4 7l8-4 8 4-8 4-8-4ZM4 12l8 4 8-4M4 17l8 4 8-4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  "book-open": "M2 5c3-1 6-1 10 1v14c-4-2-7-2-10-1V5ZM22 5c-3-1-6-1-10 1v14c4-2 7-2 10-1V5Z",
  "book-closed": "M5 4a2 2 0 0 1 2-2h12v17H7a2 2 0 0 0-2 2V4ZM5 21a2 2 0 0 0 2 1h12M9 6h6",
  "book-clock": "M5 4a2 2 0 0 1 2-2h12v8M5 4v17a2 2 0 0 0 2 1h5M17 14v3l2 1M22 17a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
  bug: "M8 8a4 4 0 0 1 8 0v1H8V8ZM6 10h12v4a6 6 0 0 1-12 0v-4ZM12 10v10M3 13h3M18 13h3M4 7l3 2M20 7l-3 2M4 20l3-2M20 20l-3-2",
  calendar: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6ZM4 10h16M8 2v4M16 2v4",
  chart: "M4 20V4M4 20h16M8 16l4-5 3 3 5-6",
  check: "M5 12.5l4.5 4.5L19 7",
  "check-circle": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12.5l2.5 2.5L16 9.5",
  "check-circle-filled": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12.5l2.5 2.5L16 9.5",
  "chevron-left": "M15 5l-7 7 7 7",
  "chevron-right": "M9 5l7 7-7 7",
  "circle-question": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  compass: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15.5 8.5l-2 5-5 2 2-5 5-2Z",
  confetti: "M4 20l4-12 8 8-12 4ZM13 4l.5 2M18 6l-2 1.5M20 11l-2-.5M15 2l1 1M21 7l1-1",
  cube: "M12 2l9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5M12 12v10",
  desktop: "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5ZM9 21h6M12 17v4",
  document: "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v5h5M8 13h8M8 17h6",
  dot: "M12 12h.01",
  "dots-horizontal": "M5 12h.01M12 12h.01M19 12h.01",
  "dots-vertical": "M12 5h.01M12 12h.01M12 19h.01",
  "empty-circle": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  "external-link": "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18",
  keys: "M15 9a4 4 0 1 0-3.5 4L5 19.5V22h3v-2h2v-2h2l1.5-1.5A4 4 0 0 0 15 9ZM16 7h.01",
  lab: "M9 2h6M10 2v6L4 19a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L14 8V2M7 15h10",
  images: "M8 3h11a2 2 0 0 1 2 2v11M4 7h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM2 17l4-4 4 4 2-2 5 5",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6M12 7.5h.01",
  lifesaver: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6",
  lightbulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
  mail: "M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6ZM3 7l9 6 9-6",
  "map-pin": "M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12ZM14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  maps: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14",
  mobile: "M7 3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3ZM11 18h2",
  name: "M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6ZM10 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5 16c.5-1.5 1.5-2 3-2s2.5.5 3 2M14 10h4M14 14h3",
  notebook: "M5 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5V3ZM9 3v18M12 8h4M12 12h4",
  "notebook-pencil": "M5 3h12a2 2 0 0 1 2 2v5M5 3v18h6M9 3v18M20.5 13.5l-6 6-3 1 1-3 6-6a1.4 1.4 0 0 1 2 2Z",
  "page-blank": "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v5h5",
  phone: "M5 3h3l2 5-2.5 1.5a11 11 0 0 0 7 7L16 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z",
  // ChatKit draws "play" as a circle with the triangle inside (as in ChatKit Studio).
  play: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM10 9.3v5.4a.7.7 0 0 0 1.1.6l4.2-2.7a.7.7 0 0 0 0-1.2l-4.2-2.7a.7.7 0 0 0-1.1.6Z",
  plus: "M12 5v14M5 12h14",
  profile: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM6.5 18.5c1.5-2 3.3-3 5.5-3s4 1 5.5 3",
  "profile-card": "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM7 17c1-1.5 2.8-2.3 5-2.3s4 .8 5 2.3",
  reload: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z",
  "star-filled": "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z",
  search: "M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM15.5 15.5 20 20",
  sparkle: "M12 3c.5 4.5 2 6 6.5 6.5-4.5.5-6 2-6.5 6.5-.5-4.5-2-6-6.5-6.5C10 9 11.5 7.5 12 3Z",
  "sparkle-double": "M10 4c.4 3.6 1.6 4.8 5.2 5.2-3.6.4-4.8 1.6-5.2 5.2-.4-3.6-1.6-4.8-5.2-5.2C8.4 8.8 9.6 7.6 10 4ZM18 13c.3 2.2 1 2.9 3 3.2-2 .3-2.7 1-3 3.2-.3-2.2-1-2.9-3-3.2 2-.3 2.7-1 3-3.2Z",
  "square-code": "M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5ZM10 9l-3 3 3 3M14 9l3 3-3 3",
  "square-image": "M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5ZM4 16l4-4 4 4 3-3 5 5M15.5 8.5h.01",
  "square-text": "M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5ZM8 9h8M8 13h8M8 17h5",
  suitcase: "M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8ZM9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18",
  "settings-slider": "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4",
  user: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5",
  wreath: "M7 20c-3-2-4.5-5.5-4-9M17 20c3-2 4.5-5.5 4-9M4 8c1 1 2 1.5 3 1.5M3.5 13c1 .5 2 .5 3 0M6 17c1-.3 1.8-1 2-2M20 8c-1 1-2 1.5-3 1.5M20.5 13c-1 .5-2 .5-3 0M18 17c-1-.3-1.8-1-2-2M9 20h6",
  write: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4",
  "write-alt": "M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z",
  "write-alt2": "M11 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 8.5-8.5Z",
};
const FILLED = new Set(["check-circle-filled", "star-filled"]);

/** Whether a name draws an icon (unknown names draw nothing). */
export function hasIcon(name: unknown): boolean {
  return typeof name === "string" && Object.hasOwn(P, name);
}

const SIZES: Record<string, number> = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 32 };

export function iconSize(size: unknown, fallback = 16): number {
  return (typeof size === "string" && SIZES[size]) || fallback;
}

type IconSet = Record<string, IconNode>;
let chatkitSet: Promise<IconSet> | null = null;
let lucideSet: Promise<IconSet> | null = null;
const loaded = new Map<string, IconNode | null>();

/** The Lucide drawing for a ChatKit name we don't draw ourselves, or a `lucide:<name>`. */
function loadIcon(name: string): Promise<IconNode | null> {
  if (name.startsWith("lucide:")) {
    const pascal = name.slice(7).replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
    lucideSet ??= import("lucide").then((m) => m.icons as IconSet);
    return lucideSet.then((set) => set[pascal] ?? null);
  }
  chatkitSet ??= import("./icon-set.ts").then((m) => m.CHATKIT_ICONS);
  return chatkitSet.then((set) => (Object.hasOwn(set, name) ? set[name]! : null));
}

function LucideIcon({ name, size, color }: { name: string; size: number; color?: string | undefined }): ReactNode {
  const [node, setNode] = useState<IconNode | null | undefined>(() => loaded.get(name));
  useEffect(() => {
    if (node !== undefined) return;
    let live = true;
    loadIcon(name)
      .catch(() => null)
      .then((n) => {
        loaded.set(name, n);
        if (live) setNode(n);
      });
    return () => {
      live = false;
    };
  }, [name, node]);
  // While it loads, hold its place so the row doesn't shift.
  if (node === undefined) return <span className="ck-icon" style={{ display: "inline-block", width: size, height: size }} aria-hidden="true" />;
  if (!node) return null;
  return (
    <svg className="ck-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={color ? { color } : undefined}>
      {node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export function WidgetIcon({ name, size = 16, color }: { name: unknown; size?: number; color?: string | undefined }): ReactNode {
  const d = typeof name === "string" ? P[name] : undefined;
  if (!d) return typeof name === "string" && /^(lucide:)?[a-z0-9][a-z0-9-]{0,60}$/.test(name) ? <LucideIcon name={name} size={size} color={color} /> : null;
  const filled = FILLED.has(name as string);
  if (name === "check-circle-filled") {
    return (
      <svg className="ck-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={color ? { color } : undefined}>
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="var(--ck-surface)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg
      className="ck-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "dot" || String(name).startsWith("dots") ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={color ? { color } : undefined}
    >
      <path d={d} />
    </svg>
  );
}
