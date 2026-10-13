import { useState, type ReactNode } from "react";
import type { AiAction } from "../../shared/protocol.ts";
import { formatTime } from "../lib/thread.ts";
import { ChevronDownIcon, ToolIcon } from "@/components/icons.tsx";
import { cn } from "cn";

// AI-11: the AI's tool calls as compact chips (agents only; never rendered in the widget).
// A header ("3 tool calls · 1 failed") folds the list; each row folds its details: what the
// model sent, what came back (as stored, already capped by the tool runner), HTTP status, time.
// Only the model's input is stored, never request headers, so tool secrets can't show here.

/** `id: 1234, plan: "pro"` — the input, short enough for a chip. */
export function inputSummary(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.join(", ") || "no input";
}

/** Pretty JSON when the stored output is JSON, else the text as is. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Grid-rows 0fr → 1fr: animates to the content's own height; hidden content can't take focus. */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return <ChevronDownIcon size={12} className={cn("transition-transform duration-200 motion-reduce:transition-none", !open && "-rotate-90", className)} />;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const pre = "m-0 max-h-40 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words text-foreground shadow-xs";

function ToolRow({ action }: { action: AiAction }) {
  const [open, setOpen] = useState(false);
  const failed = action.status === "error";
  const meta = [
    action.httpStatus ? `HTTP ${action.httpStatus}` : null,
    `${action.durationMs} ms`,
    formatTime(action.createdAt),
    action.configVersion ? `config v${action.configVersion}` : null,
  ].filter(Boolean);
  return (
    <li className="tool-row-in">
      <button
        type="button"
        data-plain
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-md px-[3px] text-left transition-colors duration-100 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <ToolIcon size={13} className={cn("transition-opacity duration-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0", open && "opacity-0")} />
          <Chevron open={open} className={cn("absolute transition-[opacity,transform] group-hover/row:opacity-100 group-focus-visible/row:opacity-100", open ? "opacity-100" : "opacity-0")} />
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-foreground">{action.tool}</span>
        <span className="inline-flex h-5.5 min-w-0 flex-1 items-center rounded-md bg-muted px-1.5 shadow-xs">
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">{inputSummary(action.input)}</span>
        </span>
        <span className={cn("shrink-0 text-[11.5px] tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed ? `failed${action.httpStatus ? ` ${action.httpStatus}` : ""}` : "ok"}
        </span>
      </button>
      <Fold open={open}>
        <div className="mt-0.5 mb-1 ml-2 grid gap-2 border-l border-border py-1 pl-3.5">
          <Detail label="Input">
            <pre className={pre}>{Object.keys(action.input).length ? JSON.stringify(action.input, null, 2) : "(none)"}</pre>
          </Detail>
          {action.output && (
            <Detail label={failed ? "Error" : "Result"}>
              {/* Scrolls with the panel's keyboard focus too, so it's a tab stop only when open. */}
              <pre className={cn(pre, failed && "text-destructive")} tabIndex={0}>{pretty(action.output)}</pre>
            </Detail>
          )}
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{meta.join(" · ")}</span>
        </div>
      </Fold>
    </li>
  );
}

/**
 * The AI's tool calls, folded under one header. `defaultOpen` false makes the compact
 * version shown in the thread next to the reply that made the calls.
 */
export function ToolCalls({ actions, defaultOpen = true, className }: { actions: AiAction[]; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!actions.length) return null;
  const failed = actions.filter((a) => a.status === "error").length;
  return (
    <div className={cn("tool-calls w-full min-w-0", className)}>
      <button
        type="button"
        data-plain
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Chevron open={open} />
        <span className="tabular-nums">
          {actions.length} tool call{actions.length === 1 ? "" : "s"}
          {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        </span>
      </button>
      <Fold open={open}>
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 px-1 pb-1">
          {actions.map((a) => (
            <ToolRow key={a.id} action={a} />
          ))}
        </ul>
      </Fold>
    </div>
  );
}
