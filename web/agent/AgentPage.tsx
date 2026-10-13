import { useState } from "react";
import { PageTabs } from "../components/PageTabs.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { ActionsView } from "./ActionsView.tsx";
import { WidgetsView } from "./WidgetsView.tsx";
import { InstructionsView } from "./InstructionsView.tsx";
import { TasksView } from "./TasksView.tsx";
import { TestsView } from "./TestsView.tsx";
import { SaveBar, routeFor, setCodeView, useCodeView } from "./parts.tsx";
import { useAgentConfig, type AgentConfig } from "./useAgentConfig.ts";

// The Agent page (AI-18). Plain views, one URL each, for the people who run support:
//   /agent              Instructions: how the AI talks, when it hands over (AGENTS.md)
//   /agent/tasks        tasks: when, steps and the actions they use (skills/*/SKILL.md; AI-27)
//   /agent/actions      requests to your systems (tools/*.yaml)
//   /agent/widgets      how an action's result is shown (widgets/*.widget)
//   /agent/tests        test cases and "Run tests" (evals/*.yaml)
// Each page has a Form / Code switch (remembered, not in the URL): Code shows the same item's file as
// text, exactly as `jun pull` / `jun push` see it. Every view edits one shared draft; one save makes
// it a new version.

type Tab = "instructions" | "tasks" | "tests" | "actions" | "widgets";
const TABS: Tab[] = ["instructions", "tasks", "tests", "actions", "widgets"];

/**
 * The Agent's parts, as the sidebar lists them under Agent. `group` starts a labelled group: Actions
 * and Widgets are the building blocks tasks use (D-71), so they come last, apart. The AI's settings
 * are in Settings → AI.
 */
export const AGENT_SECTIONS: { id: Tab; label: string; path: string; group?: string }[] = [
  { id: "instructions", label: "Instructions", path: "/agent" },
  { id: "tasks", label: "Tasks", path: "/agent/tasks" },
  { id: "tests", label: "Tests", path: "/agent/tests" },
  { id: "actions", label: "Actions", path: "/agent/actions", group: "Building blocks" },
  { id: "widgets", label: "Widgets", path: "/agent/widgets" },
];

/**
 * Old /agent/code[/<file>] links (the Code page before the Form / Code switch): that file's page,
 * switched to Code. The shell rewrites them before rendering, like the moved Settings links.
 */
export function movedFromAgentCode(path: string): string | null {
  // AI-27: Procedures became Tasks. D-72: Widgets were called Cards for a day.
  if (/^\/agent\/procedures(\/|$)/.test(path)) return path.replace("/agent/procedures", "/agent/tasks");
  if (/^\/agent\/cards(\/|$)/.test(path)) return path.replace("/agent/cards", "/agent/widgets");
  // D-71: the AI's settings moved to Settings → AI.
  if (/^\/agent\/settings\/?$/.test(path)) return "/settings/ai";
  if (!/^\/agent\/code(\/|$)/.test(path)) return null;
  setCodeView(true, true);
  const file = decodeURIComponent(path.slice("/agent/code/".length));
  return file ? routeFor(file) : "/agent";
}

/** Which part of the Agent page a path shows. */
export function agentSection(path: string): Tab {
  const segment = path.split("/")[2] ?? "";
  return (TABS as string[]).includes(segment) ? (segment as Tab) : "instructions";
}

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(ms).toLocaleDateString();
};

export function AgentPage({ workspaceId, canEdit, path }: { workspaceId: string; canEdit: boolean; path: string }) {
  const cfg = useAgentConfig(workspaceId);
  const [history, setHistory] = useState(false);
  const code = useCodeView();
  const [, , , ...rest] = path.split("/");
  const tab = agentSection(path);
  const item = rest.length ? decodeURIComponent(rest.join("/")) : null;

  const view = (content: React.ReactNode) =>
    cfg.state ? (
      <div className="agent-view">
        {content}
        <SaveBar cfg={cfg} canEdit={canEdit} />
      </div>
    ) : (
      <div className="content muted">Loading…</div>
    );

  return (
    <>
      <PageTabs
        title={AGENT_SECTIONS.find((a) => a.id === tab)!.label}
        tabsHidden
        value={tab}
        className="agent-tabs"
        actions={
          <>
            {/* An item's page (a widget, an action, a task) has its own AI / Code tabs. */}
            {!(item && (tab === "widgets" || tab === "actions" || tab === "tasks")) && (
              <Tabs value={code ? "code" : "form"} onValueChange={(v) => setCodeView(v === "code")}>
                <TabsList className="kb-tabs agent-view-switch" aria-label="View">
                  <TabsTrigger value="form">Form</TabsTrigger>
                  <TabsTrigger value="code" title="The same settings as files, as in git">Code</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>History</Button>
          </>
        }
        tabs={[
          { value: "instructions", label: "Instructions", path: "/agent", content: view(<InstructionsView cfg={cfg} canEdit={canEdit} workspaceId={workspaceId} />) },
          { value: "tasks", label: "Tasks", path: "/agent/tasks", content: view(<TasksView cfg={cfg} canEdit={canEdit} selected={tab === "tasks" ? item : null} />) },
          { value: "actions", label: "Actions", path: "/agent/actions", content: view(<ActionsView cfg={cfg} canEdit={canEdit} selected={tab === "actions" ? item : null} />) },
          { value: "widgets", label: "Widgets", path: "/agent/widgets", content: view(<WidgetsView cfg={cfg} canEdit={canEdit} selected={tab === "widgets" ? item : null} />) },
          { value: "tests", label: "Tests", path: "/agent/tests", content: view(<TestsView cfg={cfg} canEdit={canEdit} />) },
        ]}
      />
      <HistorySheet cfg={cfg} canEdit={canEdit} open={history} onClose={() => setHistory(false)} />
    </>
  );
}

function HistorySheet({ cfg, canEdit, open, onClose }: { cfg: AgentConfig; canEdit: boolean; open: boolean; onClose: () => void }) {
  const state = cfg.state;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="agent-history-sheet">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription>Every save is a version. Restoring one puts it in your draft; it goes live when you save.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="agent-history-list">
          {state && state.versions.length === 0 && <p className="muted small">Nothing saved yet. The AI uses the built-in defaults.</p>}
          <ul className="agent-versions">
            {state?.versions.map((v) => (
              <li key={v.version} className="small">
                <div className="row">
                  <span className="strong">Version {v.version}</span>
                  {v.version === state.version && <Badge variant="secondary" className="agent-pass">Live</Badge>}
                  <span className="spacer" />
                  {canEdit && v.version !== state.version && (
                    <Button variant="outline" size="sm" disabled={cfg.busy} onClick={() => { cfg.restore(v.version); onClose(); }}>Restore</Button>
                  )}
                </div>
                <div>{v.message || <span className="muted">No note</span>}</div>
                <div className="muted">{v.source === "cli" ? "Pushed from git" : "Saved"} by {v.createdBy ?? "someone"} · {ago(v.createdAt)}</div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

