import { useEffect } from "react";
import type { ConversationStatus, ConversationSummary } from "../../shared/protocol.ts";
import type { SavedReply } from "../components/Composer.tsx";

/**
 * I-13: what the inbox and the open conversation offer to the command palette and the keyboard
 * shortcuts in Shell. Each page registers itself while mounted; Shell reads the latest values.
 */
export interface InboxBridge {
  /** The conversations the list shows (after filters). */
  conversations: ConversationSummary[];
  move(delta: 1 | -1): void;
  openCursor(): void;
  focusSearch(): void;
  /** `e` / `a`: on the open conversation, else the one under the list cursor. */
  act(command: "resolve" | "assign-me"): void;
}

export interface ConversationPatch {
  status?: ConversationStatus;
  assigneeId?: string | null;
  handling?: "ai" | "human";
}

export interface ThreadBridge {
  conversation: ConversationSummary;
  members: { id: string; name: string }[];
  knownTags: string[];
  savedReplies: SavedReply[];
  canCreateIssue: boolean;
  /** Mirrors the thread's "Hand back to AI" button. */
  canHandBack: boolean;
  update(patch: ConversationPatch): Promise<void>;
  addTag(name: string): Promise<void>;
  startTag(): void;
  focusComposer(mode: "reply" | "note"): void;
  insertReply(reply: SavedReply): void;
  createIssue(): void;
}

export const bridge: { inbox: InboxBridge | null; thread: ThreadBridge | null } = { inbox: null, thread: null };

/** Registers `value` as the current inbox or thread bridge while the component is mounted. */
export function useBridge<K extends keyof typeof bridge>(key: K, value: (typeof bridge)[K]): void {
  useEffect(() => {
    bridge[key] = value;
    return () => {
      if (bridge[key] === value) bridge[key] = null;
    };
  });
}

/** The focused element takes typed text (shortcuts stay off). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  return false;
}

/** Enter on this element already activates it. */
export const isControlTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest("button, a[href], summary, [role='button'], [role='option'], input") !== null;

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "⌘" on Apple devices, "Ctrl" elsewhere. */
export const modKey = (): string => (isMac() ? "⌘" : "Ctrl");
