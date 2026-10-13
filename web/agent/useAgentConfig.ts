import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useAction } from "../useAction.ts";

// The agent's files, shared by every part of the Agent page (Instructions, Tasks, Actions,
// Widgets, Tests, in Form or Code): one draft, checked as you type, saved together as one version.

export type Files = Record<string, string>;

export interface Issue {
  path: string;
  message: string;
}

export interface Version {
  version: number;
  message: string;
  source: "dashboard" | "cli";
  createdBy: string | null;
  createdAt: number;
}

export interface AgentState {
  version: number | null;
  files: Files;
  issues: Issue[];
  summary: { skills: string[]; tools: string[]; evals: number; maxReplies: number; handoffTopics: string[]; widgets: string[] };
  versions: Version[];
}

export type AgentConfig = ReturnType<typeof useAgentConfig>;

export function useAgentConfig(workspaceId: string) {
  const base = `/workspaces/${workspaceId}/agent`;
  const [state, setState] = useState<AgentState | null>(null);
  const [draft, setDraft] = useState<Files>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    const next = await api<AgentState>(base);
    setState(next);
    setDraft(next.files);
    setIssues(next.issues);
    setConflict(null);
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const dirty = useMemo(() => state !== null && JSON.stringify(draft) !== JSON.stringify(state.files), [draft, state]);

  // Validate as you type (debounced), so errors show before saving.
  useEffect(() => {
    if (!state) return;
    if (!dirty) {
      // Back to the saved files: their (already checked) issues apply again.
      setIssues(state.issues);
      return;
    }
    const timer = setTimeout(() => {
      api<{ issues: Issue[] }>(`${base}/validate`, { body: { files: draft } })
        .then((r) => setIssues(r.issues))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, dirty, base, state]);

  /** Sets (or with `undefined`, removes) one file of the draft. */
  const setFile = useCallback((path: string, text: string | undefined) => {
    setDraft((d) => {
      if (text === undefined) {
        const next = { ...d };
        delete next[path];
        return next;
      }
      return d[path] === text ? d : { ...d, [path]: text };
    });
  }, []);

  const save = (force = false) =>
    action.run(async () => {
      if (!state) return;
      try {
        const result = await api<{ version: number }>(base, { method: "PUT", body: { files: draft, base: state.version, force, message } });
        setMessage("");
        setSaved(result.version);
        setTimeout(() => setSaved(null), 3000);
        await load();
      } catch (e) {
        if (e instanceof ApiError && e.code === "invalid_config") {
          setIssues((e.detail.issues as Issue[]) ?? []);
          throw new Error("Not saved: fix the errors first.");
        }
        if (e instanceof ApiError && e.code === "conflict") {
          setConflict(e.message);
          return;
        }
        throw e;
      }
    });

  const discard = () => {
    if (!state) return;
    setDraft(state.files);
    setIssues(state.issues);
  };

  const restore = (version: number) =>
    action.run(async () => {
      const old = await api<AgentState>(`${base}?version=${version}`);
      setDraft(old.files);
      setMessage(`Restore version ${version}`);
    });

  const issuesFor = useCallback((path: string) => issues.filter((i) => i.path === path), [issues]);

  return { base, state, draft, setFile, issues, issuesFor, dirty, message, setMessage, conflict, saved, save, discard, restore, load, ...action };
}
