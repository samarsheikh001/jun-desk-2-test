// W-27: what the Agent page's AI editors know about each of the desk's actions: what it does, its
// inputs, whether it changes something, whether it knows the signed-in customer, and its widget.
// The procedure editor writes exact steps from it (ask for these inputs first, wait for a yes before
// a change); the widget editor names a form's fields after the inputs its button's action takes.
// Pure; the Worker builds the briefs from the parsed config (worker/ai/agent-file-edit.ts).

export interface ActionBriefInput {
  name: string;
  type: string;
  required: boolean;
  enum?: string[];
  description?: string;
}

export interface ActionBrief {
  name: string;
  description: string;
  method: "GET" | "POST";
  inputs: ActionBriefInput[];
  /** It fills {user.*} itself: the signed-in customer's details are never asked for. */
  customer: boolean;
  /** The widget it shows its result as. */
  widget?: string;
}

function inputLine(i: ActionBriefInput): string {
  const facts = [i.type, i.required ? "required" : "optional", ...(i.enum?.length ? [`one of: ${i.enum.join(", ")}`] : [])];
  return `${i.name} (${facts.join(", ")})${i.description ? `: ${i.description}` : ""}`;
}

/** The actions as a list for a prompt. */
export function describeActions(actions: ActionBrief[]): string {
  if (!actions.length) return "(none)";
  return actions
    .map((a) => {
      const lines = [`- ${a.name} (${a.method === "POST" ? "POST: changes something" : "GET: looks something up"}): ${a.description || "(no description)"}`];
      lines.push(`  inputs: ${a.inputs.length ? a.inputs.map(inputLine).join("; ") : "none"}`);
      if (a.customer) lines.push("  knows the signed-in customer on its own (never ask for their id, email or name)");
      if (a.widget) lines.push(`  shows its result to the customer as the widget ${a.widget}`);
      return lines.join("\n");
    })
    .join("\n");
}
