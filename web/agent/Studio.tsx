import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ChatIcon, ChevronLeftIcon, CodeIcon, InfoIcon, SparkleIcon, TrashIcon } from "../components/icons.tsx";
import { changeOf, go, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// One layout for an item's page on the Agent page (after ChatKit Studio's editor, W-22): widgets,
// actions and procedures alike, so each feels the same. Left: back, the name, Remove, and tabs (AI,
// Code, and Details for widgets); right: what the item looks like (a widget's preview, an action's or
// a procedure's form), which follows every change made on the left.

export type StudioPaneId = "ai" | "test" | "code" | "details";

export interface StudioPane {
  id: StudioPaneId;
  label: string;
  content: ReactNode;
}

const ICONS: Record<StudioPaneId, ReactNode> = { ai: <SparkleIcon />, test: <ChatIcon />, code: <CodeIcon />, details: <InfoIcon /> };

// The tab last used, for this visit (moving between items, or between widgets and actions, keeps it).
let lastPane: StudioPaneId | null = null;

export function Studio({ cfg, canEdit, path, title, back, onRemove, panes, right }: {
  cfg: AgentConfig;
  canEdit: boolean;
  path: string;
  title: string;
  /** Where the back arrow goes: the list of these items. */
  back: { path: string; label: string };
  onRemove: () => void;
  panes: StudioPane[];
  /** The right side: a <section> the caller styles (a preview canvas, a form). */
  right: ReactNode;
}) {
  const code = useCodeView();
  const [pane, setPaneState] = useState<StudioPaneId>(() => lastPane ?? (code ? "code" : canEdit ? "ai" : "details"));
  const setPane = (next: StudioPaneId) => {
    lastPane = next;
    setPaneState(next);
  };
  // "Fix it in Code" (a file the form can't read) switches the Code view on: show the Code tab.
  useEffect(() => {
    if (code && panes.some((p) => p.id === "code")) setPaneState("code");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const shown = panes.find((p) => p.id === pane) ?? panes[0]!;
  const change = changeOf(cfg, path);

  return (
    <div className="agent-wed agent-wed-studio">
      <section className="agent-wed-side">
        <div className="agent-wed-head">
          <Button variant="ghost" size="icon-sm" aria-label={back.label} title={back.label} onClick={() => go(back.path)}>
            <ChevronLeftIcon />
          </Button>
          <h2>{title}</h2>
          {change && <Badge variant="secondary">{change}</Badge>}
          <span className="spacer" />
          {canEdit && (
            <Button variant="ghost" size="icon-sm" aria-label="Remove" title="Removed when you save" onClick={onRemove}>
              <TrashIcon />
            </Button>
          )}
        </div>
        <div className="agent-wed-tabs" role="tablist" aria-label="Edit with">
          {panes.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={shown.id === p.id} className="agent-wed-tab" onClick={() => setPane(p.id)}>
              {ICONS[p.id]}
              {p.label}
            </button>
          ))}
        </div>
        <div className="agent-wed-pane" role="tabpanel">
          {shown.content}
        </div>
      </section>
      {right}
    </div>
  );
}
