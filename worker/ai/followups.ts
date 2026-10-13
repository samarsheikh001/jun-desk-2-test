import { cleanFollowUps } from "./agent.ts";
import type { SearchHit } from "./query.ts";

// Follow-up questions under an answer (the chips the widget shows): written by a separate, small
// AI job after the answer is saved, from the question, the answer and the sources it used. Asked
// for inside the reply (a line, then a tool call), models almost never wrote them (D-42). Pure.

/** At most this much of each source goes into the prompt. */
const SOURCE_CHARS = 400;
/** At most this many sources. */
const MAX_SOURCES = 3;

export function followUpsPrompt(): string {
  return `You suggest what a customer might ask a support assistant next.
Write up to 3 short follow-up questions (under 60 characters each), in the customer's words and language, that the sources below answer and the answer didn't already cover.
One question per line, nothing else: no numbering, no quotes, no introduction. If there's nothing useful to ask, write nothing.`;
}

/** The job's input: the customer's question, the answer they got, and the sources it drew on. */
export function followUpsInput(question: string, answer: string, hits: SearchHit[]): string {
  const sources = hits
    .slice(0, MAX_SOURCES)
    .map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` — ${h.heading}` : ""}\n${h.text.replace(/\s+/g, " ").slice(0, SOURCE_CHARS)}`)
    .join("\n\n");
  return `Customer's question:\n${question.slice(0, 1000)}\n\nAnswer they got:\n${answer.slice(0, 2000)}\n\nSources:\n${sources}`;
}

/** The job's output, one question per line, as the widget's chips (cleaned and capped). */
export function parseFollowUpLines(text: string): string[] {
  return cleanFollowUps(text.split("\n"));
}
