import { useEffect, useState, type MouseEvent } from "react";
import { api } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { editFrontmatter, readFrontmatter, setBody } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { ExpandIcon } from "../components/icons.tsx";
import { CodeEditor, EVAL, Field, FilePicker, Problems, SKILL, TextList, TOOL, Unreadable, WIDGET, go, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";
import { MentionText, useMentionActions } from "./MentionText.tsx";

// /agent: AGENTS.md as a page to write on (the body: how the AI talks) beside a panel with when it
// hands over (the frontmatter's maxReplies and handoffTopics) and which model answers. In Code:
// AGENTS.md as text, and any file of no other kind (a README.md) beside it.

const PATH = "AGENTS.md";
const DEFAULT_MAX_REPLIES = 8;

export function InstructionsView({ cfg, canEdit, workspaceId }: { cfg: AgentConfig; canEdit: boolean; workspaceId: string }) {
  const code = useCodeView();
  if (code) return <InstructionsCode cfg={cfg} canEdit={canEdit} />;
  return <InstructionsForm cfg={cfg} canEdit={canEdit} workspaceId={workspaceId} />;
}

function InstructionsCode({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const others = Object.keys(cfg.draft).filter((p) => p !== PATH && ![SKILL, TOOL, WIDGET, EVAL].some((re) => re.test(p))).sort();
  const [picked, setPicked] = useState(PATH);
  const path = picked in cfg.draft ? picked : PATH;
  return (
    <section className="agent-form agent-code">
      {others.length > 0 && <FilePicker files={[PATH, ...others]} value={path} onChange={setPicked} />}
      <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
    </section>
  );
}

const PLACEHOLDER = `For example:

- Be friendly, concise and specific. A few short sentences or a short list.
- Use the customer's name if you know it.
- Don't promise refunds or timelines unless a procedure says you can.`;

function InstructionsForm({ cfg, canEdit, workspaceId }: { cfg: AgentConfig; canEdit: boolean; workspaceId: string }) {
  const text = cfg.draft[PATH] ?? "";
  const { data, body } = readFrontmatter(text);
  const set = (next: string) => cfg.setFile(PATH, next);
  const maxReplies = typeof data?.maxReplies === "number" ? data.maxReplies : undefined;
  const topics = Array.isArray(data?.handoffTopics) ? (data.handoffTopics as unknown[]).map(String) : [];
  const [expanded, setExpanded] = useState(false);
  const writeBody = (value: string) => set(setBody(text, value));
  const actions = useMentionActions(cfg);

  return (
    <div className="agent-doc">
      <section className="agent-doc-main">
        <div className="agent-doc-head">
          <h2>How the AI talks</h2>
          <p>Its tone, and anything it should always or never do. Write it like you'd brief a new teammate. Steps for one job (like refunds) go in Tasks.</p>
        </div>
        <div className="agent-doc-editor">
          {/* W-26: @ names an action. */}
          <MentionText
            className="mention-plain"
            id="agent-instructions"
            ariaLabel="How the AI talks"
            placeholder={PLACEHOLDER}
            value={body}
            onChange={writeBody}
            readOnly={!canEdit}
            actions={actions}
          />
          <Button variant="ghost" size="icon-sm" type="button" className="agent-doc-expand" aria-label="Expand" title="Write in a larger window" onClick={() => setExpanded(true)}>
            <ExpandIcon />
          </Button>
        </div>
        <Problems issues={cfg.issuesFor(PATH)} />
      </section>

      <aside className="agent-panel" aria-label="Handing over and model">
        <h3 className="agent-panel-title">Hand over to your team</h3>
        <div className="agent-panel-card">
          {data === null ? (
            <Unreadable />
          ) : (
            <>
              <Field label="After this many AI replies" hint={`In one conversation. From 1 to 50; ${DEFAULT_MAX_REPLIES} if left empty.`} htmlFor="agent-max-replies">
                <Input
                  id="agent-max-replies"
                  type="number"
                  min={1}
                  max={50}
                  placeholder={String(DEFAULT_MAX_REPLIES)}
                  value={maxReplies ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => set(editFrontmatter(text, { op: "set", path: ["maxReplies"], value: e.target.value === "" ? "" : Number(e.target.value) }))}
                />
              </Field>
              <Field label="Always for these topics" hint="The AI doesn't try to answer these, even if your docs cover them.">
                <TextList
                  values={topics}
                  onChange={(next) => set(editFrontmatter(text, { op: "set", path: ["handoffTopics"], value: next }))}
                  placeholder="e.g. legal or security questions"
                  label="Topic"
                  addLabel="Add a topic"
                  disabled={!canEdit}
                  max={30}
                />
              </Field>
            </>
          )}
        </div>
        <p className="agent-panel-note">The AI also hands over whenever a customer asks for a person, or when it can't help.</p>
        <ModelSummary workspaceId={workspaceId} />
      </aside>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="agent-doc-dialog">
          <DialogHeader>
            <DialogTitle>How the AI talks</DialogTitle>
            <DialogDescription>Changes go in your draft; customers see them once you save.</DialogDescription>
          </DialogHeader>
          <MentionText
            className="mention-plain mention-large"
            id="agent-instructions-large"
            ariaLabel="How the AI talks"
            placeholder={PLACEHOLDER}
            autoFocus
            value={body}
            onChange={writeBody}
            readOnly={!canEdit}
            actions={actions}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AiSummary {
  settings: { enabled: boolean; provider: string; monthlyReplyCap: number };
  effectiveModels: { answer: string };
  usage: { replies: number };
}

const PROVIDERS: Record<string, string> = { "workers-ai": "Workers AI", openai: "OpenAI", chatgpt: "ChatGPT sign-in" };
const link = (path: string, replace = false) => ({
  href: path,
  onClick: (e: MouseEvent) => {
    e.preventDefault();
    if (replace) go(path);
    else navigate(path);
  },
});

/** Which model answers, read-only: it's changed in Agent → Settings. */
function ModelSummary({ workspaceId }: { workspaceId: string }) {
  const [ai, setAi] = useState<AiSummary | null>(null);
  useEffect(() => {
    let live = true;
    api<AiSummary>(`/workspaces/${workspaceId}/ai`).then((next) => live && setAi(next)).catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return (
    <div className="agent-panel-model">
      <h3 className="agent-panel-title">Model</h3>
      {ai && (
        <dl className="agent-panel-facts">
          <dt>Replies with</dt>
          <dd>
            <span className="mono">{ai.effectiveModels.answer}</span>
            <span className="muted"> · {PROVIDERS[ai.settings.provider] ?? ai.settings.provider}</span>
            {!ai.settings.enabled && <Badge variant="secondary" className="agent-panel-off">AI off</Badge>}
          </dd>
          <dt>This month</dt>
          <dd>
            {ai.usage.replies.toLocaleString()}
            {ai.settings.monthlyReplyCap > 0 && <span className="muted"> of {ai.settings.monthlyReplyCap.toLocaleString()}</span>} replies
          </dd>
        </dl>
      )}
      <p className="agent-panel-note">
        Change the model in <a {...link("/settings/ai", true)}>Settings → AI</a>. Answers come from your <a {...link("/knowledge")}>Knowledge</a>.
      </p>
    </div>
  );
}
