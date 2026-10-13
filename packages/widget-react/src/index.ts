import { useEffect, type DependencyList, type RefObject } from "react";

// AI-21 page actions (D-40): a React hook that registers a WebMCP-shaped action with the Jun Desk
// loader while the component is on screen, and removes it on unmount. The loader may not have
// loaded yet (its script tag is async): then the hook waits for its "jundesk:ready" event.
// No runtime dependency: plain TypeScript, React as a peer.

/** A WebMCP tool descriptor (https://developer.chrome.com/docs/ai/webmcp/imperative-api). */
export interface WebMcpTool<Input = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  /** JSON Schema for `execute`'s input; `required` params the AI can't fill are asked for in the chat. */
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  /** Runs in the visitor's browser with their own session. A string (or `{ summary }`) becomes the Done line. */
  execute: (input: Input, options: { signal?: AbortSignal }) => Result | Promise<Result>;
}

/** The Jun extras WebMCP has no place for. */
export interface JunActionExtras<Result = unknown> {
  /** Offer it only on matching paths: "/pricing", "/plans/*". */
  pages?: string[];
  /** One instance per item on screen (name + key is unique). */
  key?: string | number;
  /** Highlighted while the action runs. */
  element?: Element | RefObject<Element | null> | null;
  /** Small facts for the AI, or a function returning them. */
  context?: Record<string, string | number | boolean> | (() => Record<string, string | number | boolean>);
  /** Checked before the action is offered and before it runs. */
  available?: () => boolean;
  /** Gives the chat an Undo button. */
  undo?: (result: Result) => void | Promise<void>;
  /** "confirm" (default: a summary and a Confirm button), "auto" (runs at once) or "human" (goes to the team). */
  risk?: "auto" | "confirm" | "human";
  /** A card made on the desk (its widget name): the result, an object, is shown as that card. */
  widget?: string;
}

export type JunAction<Input = Record<string, unknown>, Result = unknown> = WebMcpTool<Input, Result> & JunActionExtras<Result>;

interface JunDeskApi {
  registerAction(action: JunAction<never, unknown>): () => void;
}

const host = globalThis as unknown as {
  JunDesk?: JunDeskApi;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

/**
 * Registers `action` while the component is mounted (and again whenever `deps` change), like
 * `useEffect`. Returns nothing: the chat does the rest.
 *
 *   useJunAction({ name: "add_to_cart", key: product.id, description: `Add ${product.name} to the cart`, …, execute }, [product.id]);
 */
export function useJunAction<Input = Record<string, unknown>, Result = unknown>(action: JunAction<Input, Result>, deps: DependencyList = []): void {
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    const register = () => {
      if (gone || !host.JunDesk) return;
      off = host.JunDesk.registerAction(action as unknown as JunAction<never, unknown>);
    };
    if (host.JunDesk) register();
    else host.addEventListener?.("jundesk:ready", register);
    return () => {
      gone = true;
      host.removeEventListener?.("jundesk:ready", register);
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
