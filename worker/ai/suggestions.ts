import { parseSuggestions, SAMPLE_LIMITS, suggestionInput, suggestionPrompt, type SuggestionSample } from "../../shared/suggestions.ts";
import { completeText, createModel, loadAiSettings } from "./providers.ts";
import { recordUsage } from "./topics.ts";

// W-15 (D-33): the widget's suggested questions, drafted from the desk's own knowledge for an
// admin to review on the Appearance page. Nothing is saved here. The sample is small and fixed:
// source titles, page titles (shortest URLs first, so top-level pages like /pricing lead), the
// opening chunk of up to two documents per source, and the most frequent A-02 topics.

const DRAFT_TIMEOUT_MS = 60_000;

export type SuggestionSkip = "no_knowledge" | "ai_off" | "cap_reached";

/** A bounded sample of the workspace's indexed knowledge, or null when nothing is indexed yet. */
export async function knowledgeSample(db: D1Database, workspaceId: string): Promise<SuggestionSample | null> {
  const [any, sources, pages, excerpts, topics] = await db.batch([
    db.prepare("SELECT 1 AS ok FROM kb_chunks WHERE workspace_id = ? LIMIT 1").bind(workspaceId),
    db.prepare("SELECT title FROM kb_sources s WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM kb_chunks k WHERE k.source_id = s.id) ORDER BY created_at LIMIT ?").bind(workspaceId, SAMPLE_LIMITS.sources),
    db
      .prepare("SELECT title FROM kb_documents WHERE workspace_id = ? AND title IS NOT NULL AND title <> '' GROUP BY title ORDER BY MIN(LENGTH(url)), MAX(updated_at) DESC LIMIT ?")
      .bind(workspaceId, SAMPLE_LIMITS.pages),
    db
      .prepare(
        `SELECT title, heading, text FROM (
           SELECT k.title, k.heading, k.text, ROW_NUMBER() OVER (PARTITION BY k.source_id ORDER BY LENGTH(COALESCE(k.url, '')), k.rowid) AS n
           FROM kb_chunks k WHERE k.workspace_id = ? AND k.position = 0
         ) WHERE n <= 2 ORDER BY n LIMIT ?`,
      )
      .bind(workspaceId, SAMPLE_LIMITS.excerpts),
    db
      .prepare(
        `SELECT t.name, COUNT(c.id) AS conversations FROM topics t JOIN conversations c ON c.workspace_id = t.workspace_id AND c.topic_id = t.id
         WHERE t.workspace_id = ? GROUP BY t.id ORDER BY conversations DESC, t.name LIMIT ?`,
      )
      .bind(workspaceId, SAMPLE_LIMITS.topics),
  ]);
  if (!any!.results.length) return null;
  return {
    sources: (sources!.results as { title: string }[]).map((r) => r.title),
    pages: (pages!.results as { title: string }[]).map((r) => r.title),
    excerpts: excerpts!.results as SuggestionSample["excerpts"],
    topics: topics!.results as SuggestionSample["topics"],
  };
}

/**
 * Up to four questions from the model (possibly none, when its answer had nothing usable), or why
 * it didn't run. Model errors and timeouts are thrown for the route to report.
 */
export async function draftSuggestions(env: Env, workspaceId: string): Promise<{ suggestions: string[] } | { skipped: SuggestionSkip }> {
  const [settings, usage, sample] = await Promise.all([
    loadAiSettings(env, workspaceId),
    env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(workspaceId, new Date().toISOString().slice(0, 7)).first<{ replies: number }>(),
    knowledgeSample(env.DB, workspaceId),
  ]);
  if (!sample) return { skipped: "no_knowledge" };
  if (!settings.enabled) return { skipped: "ai_off" };
  if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) return { skipped: "cap_reached" };
  const model = createModel(env, workspaceId, settings, "suggestions");
  const result = await completeText({
    model: model.model,
    ...model.prompt(suggestionPrompt()),
    messages: [{ role: "user", content: suggestionInput(sample) }],
    // Room for reasoning models' hidden tokens; the answer itself is ~60 tokens.
    maxOutputTokens: 800,
    temperature: 0.4,
    abortSignal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
  });
  await recordUsage(env, workspaceId, result.totalUsage);
  const suggestions = parseSuggestions(result.text);
  if (!suggestions.length) console.warn("suggested questions: nothing usable in the model output:", result.text.slice(0, 200));
  return { suggestions };
}
