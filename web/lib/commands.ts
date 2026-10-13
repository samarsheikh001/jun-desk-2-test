/**
 * I-13: the command palette's fuzzy matcher and the keyboard shortcut dispatcher.
 * Pure functions (no DOM), so `npm test` covers them on Node.
 */

// ---------- fuzzy matching ----------

/** Lower case without accents, so "jorg" finds "Jörg". */
export const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_.@/:([]/.test(text[i - 1]!);

/**
 * Scores `text` against `query` as a subsequence match, or null when some query character is
 * missing. Higher is better: contiguous runs, word starts and an early first match score more.
 * Spaces in the query split it into words that may match in any order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const target = fold(text);
  let total = 0;
  for (const word of words) {
    const score = scoreWord(word, target);
    if (score === null) return null;
    total += score;
  }
  return total;
}

function scoreWord(word: string, target: string): number | null {
  // A plain substring beats any scattered match; at a word start even more.
  const at = target.indexOf(word);
  if (at !== -1) {
    let best = at;
    for (let i = at; i !== -1; i = target.indexOf(word, i + 1)) {
      if (isWordStart(target, i)) {
        best = i;
        break;
      }
    }
    return 100 + word.length * 10 + (isWordStart(target, best) ? 40 : 0) + (best === 0 ? 20 : 0) - Math.min(best, 30);
  }
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of word) {
    const i = target.indexOf(ch, from);
    if (i === -1) return null;
    score += i === previous + 1 ? 8 : isWordStart(target, i) ? 6 : 1;
    previous = i;
    from = i + 1;
  }
  return score - Math.min(target.indexOf(word[0]!), 20) / 2;
}

/** An item's score: its best field, where earlier fields (a name) count a little more than later ones (a preview). */
export function scoreFields(query: string, fields: readonly (string | null | undefined)[]): number | null {
  let best: number | null = null;
  fields.forEach((field, n) => {
    if (!field) return;
    const s = fuzzyScore(query, field);
    if (s !== null && (best === null || s - n * 5 > best)) best = s - n * 5;
  });
  return best;
}

/** Items matching `query` with their scores, best first (stable for ties). */
export function rankScored<T>(query: string, items: readonly T[], fields: (item: T) => readonly (string | null | undefined)[]): { item: T; score: number }[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0 }));
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = scoreFields(query, fields(item));
    if (score !== null) scored.push({ item, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ item, score }) => ({ item, score }));
}

/** Items matching `query`, best first (stable for ties). */
export const rank = <T>(query: string, items: readonly T[], fields: (item: T) => readonly (string | null | undefined)[]): T[] => rankScored(query, items, fields).map((r) => r.item);

/** The inbox's quick filter: every word of `query` appears somewhere in the fields (no fuzziness). */
export function matchesFilter(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(fields.filter(Boolean).join(" \n "));
  return words.every((w) => haystack.includes(w));
}

// ---------- keyboard shortcuts ----------

export type ShortcutCommand =
  | "palette"
  | "help"
  | "next"
  | "previous"
  | "open"
  | "reply"
  | "note"
  | "resolve"
  | "assign-me"
  | "tag"
  | "search"
  | "go-inbox"
  | "go-visitors"
  | "go-dashboard"
  | "go-settings";

/** What the dispatcher needs from a keydown event (a KeyboardEvent fits, plus two DOM facts). */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** An IME composition is in progress (`isComposing`, or the "Process" key / keyCode 229). */
  isComposing: boolean;
  /** Focus is in an input, textarea, select or contenteditable. */
  typing: boolean;
  /** Focus is on a button or link, where Enter already means "activate". */
  onControl: boolean;
}

export interface ShortcutContext {
  /** The inbox is the current page (j/k, e, a… only work there). */
  inbox: boolean;
  /** A modal is open: "palette" (Ctrl+K closes it), "other" (an app dialog: no shortcuts), or none. */
  modal: "none" | "palette" | "other";
}

/** A pending "g" (go to…) prefix and when it was pressed. */
export interface ShortcutState {
  prefix: "g" | null;
  at: number;
}

export const INITIAL_SHORTCUT_STATE: ShortcutState = { prefix: null, at: 0 };
/** How long "g" waits for its second key. */
export const PREFIX_TIMEOUT_MS = 1500;

const GO: Record<string, ShortcutCommand> = { i: "go-inbox", v: "go-visitors", d: "go-dashboard", r: "go-dashboard", s: "go-settings" };
const INBOX: Record<string, ShortcutCommand> = {
  j: "next",
  k: "previous",
  o: "open",
  Enter: "open",
  r: "reply",
  n: "note",
  e: "resolve",
  a: "assign-me",
  t: "tag",
  "/": "search",
};

/**
 * Maps a keydown to a command. Returns the next state too (for the two-key "g i" shortcuts).
 * Single-key shortcuts never fire while typing, with Ctrl/⌘/Alt held, or during IME composition;
 * Ctrl+K / ⌘K works everywhere (it's how you get out of a text field to the palette).
 */
export function dispatchShortcut(input: KeyInput, state: ShortcutState, context: ShortcutContext, now: number): { command: ShortcutCommand | null; state: ShortcutState } {
  const none = { command: null, state: INITIAL_SHORTCUT_STATE };
  if (input.isComposing) return none;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;

  if ((input.ctrlKey || input.metaKey) && !input.altKey && !input.shiftKey && key === "k") {
    return context.modal === "other" ? none : { command: "palette", state: INITIAL_SHORTCUT_STATE };
  }
  if (context.modal !== "none" || input.typing || input.ctrlKey || input.metaKey || input.altKey) return none;

  if (state.prefix === "g" && now - state.at <= PREFIX_TIMEOUT_MS && !input.shiftKey) {
    return { command: GO[key] ?? null, state: INITIAL_SHORTCUT_STATE };
  }
  if (input.key === "?") return { command: "help", state: INITIAL_SHORTCUT_STATE };
  if (input.shiftKey) return none;
  if (key === "g") return { command: null, state: { prefix: "g", at: now } };
  if (!context.inbox) return none;
  if (key === "Enter" && input.onControl) return none;
  return { command: INBOX[key] ?? null, state: INITIAL_SHORTCUT_STATE };
}

/** The shortcuts help sheet. `alt` is a second way to do the same thing. */
export const SHORTCUT_HELP: { group: string; keys: { keys: string[]; alt?: string[]; label: string }[] }[] = [
  {
    group: "Anywhere",
    keys: [
      { keys: ["Ctrl", "K"], label: "Command palette" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["g", "i"], label: "Go to Inbox" },
      { keys: ["g", "v"], label: "Go to Visitors" },
      { keys: ["g", "d"], label: "Go to Dashboard" },
      { keys: ["g", "s"], label: "Go to Settings" },
    ],
  },
  {
    group: "Inbox",
    keys: [
      { keys: ["j"], label: "Next conversation" },
      { keys: ["k"], label: "Previous conversation" },
      { keys: ["Enter"], alt: ["o"], label: "Open conversation" },
      { keys: ["/"], label: "Filter conversations" },
      { keys: ["r"], label: "Reply" },
      { keys: ["n"], label: "Write a note" },
      { keys: ["e"], label: "Resolve" },
      { keys: ["a"], label: "Assign to me" },
      { keys: ["t"], label: "Add a tag" },
    ],
  },
  {
    group: "Composer",
    keys: [
      { keys: ["Enter"], alt: ["Ctrl", "Enter"], label: "Send" },
      { keys: ["Shift", "Enter"], label: "New line" },
      { keys: ["Esc"], label: "Leave the composer" },
    ],
  },
];
