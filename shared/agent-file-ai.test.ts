import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFileEditInput, agentFileEditPrompt, agentFileKind, parseAgentFileEdit } from "./agent-file-ai.ts";

test("agent file AI: only actions and procedures, with their names", () => {
  assert.deepEqual(agentFileKind("tools/add_seats.yaml"), { kind: "action", name: "add_seats" });
  assert.deepEqual(agentFileKind("tools/lookup.yml"), { kind: "action", name: "lookup" });
  assert.deepEqual(agentFileKind("skills/change-plan/SKILL.md"), { kind: "procedure", name: "change-plan" });
  for (const path of ["AGENTS.md", "widgets/order.widget", "evals/basic.yaml", "tools/../x.yaml", "skills/x/README.md"]) {
    assert.equal(agentFileKind(path), null, path);
  }
});

test("agent file AI: each kind's prompt explains its own format and the answer's shape", () => {
  const action = agentFileEditPrompt("action");
  assert.ok(action.includes("{secrets.NAME}") && action.includes("pick:"));
  assert.ok(!action.includes("frontmatter"));
  const procedure = agentFileEditPrompt("procedure");
  assert.ok(procedure.includes("frontmatter") && procedure.includes("description"));
  for (const p of [action, procedure]) assert.ok(p.trimEnd().endsWith("</file>"));
});

test("agent file AI (W-27): procedures use actions with their inputs; actions keep the names others use", () => {
  const procedure = agentFileEditPrompt("procedure");
  assert.ok(procedure.includes("Whenever a step can be done with one of the desk's actions"));
  assert.ok(procedure.includes("required inputs") && procedure.includes("clear yes") && procedure.includes("needs to be created"));
  assert.ok(!procedure.includes("This action is used by"));
  const action = agentFileEditPrompt("action");
  assert.ok(action.includes("widget_done") && action.includes("Keep the input names"));
});

test("agent file AI: the request carries the file, the desk's other parts, recent chat and problems", () => {
  const input = agentFileEditInput({
    kind: "action",
    name: "add_seats",
    path: "tools/add_seats.yaml",
    text: "description: Add seats\n",
    context: {
      actions: [
        { name: "lookup_order", description: "Look up an order", method: "GET", customer: true, inputs: [{ name: "orderNumber", type: "string", required: true, description: "Like A-1042" }] },
        { name: "apply_offer", description: "Apply an offer", method: "POST", customer: false, widget: "offer_applied", inputs: [{ name: "code", type: "string", required: true, enum: ["save50", "save20"] }, { name: "note", type: "string", required: false }] },
      ],
      procedures: [],
      widgets: ["seats_added"],
      usedBy: ["procedure cancellation", "a button in widget seat_quote"],
    },
    history: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i}` }) as const),
    message: "Also ask for the email",
    error: { file: "bad: [", problems: ["url must start with https://"] },
  });
  assert.ok(input.includes("description: Add seats"));
  assert.ok(input.includes("- lookup_order (GET: looks something up): Look up an order\n  inputs: orderNumber (string, required): Like A-1042\n  knows the signed-in customer"));
  assert.ok(input.includes("- apply_offer (POST: changes something): Apply an offer\n  inputs: code (string, required, one of: save50, save20); note (string, optional)\n  shows its result to the customer as the widget offer_applied"));
  assert.ok(input.includes("This action is used by: procedure cancellation; a button in widget seat_quote"));
  assert.ok(input.includes("The desk's procedures:\n(none)"));
  assert.ok(input.includes("seats_added"));
  assert.ok(!input.includes("turn 7") && input.includes("turn 19"));
  assert.ok(input.includes("- url must start with https://"));
});

test("agent file AI: parses the reply and the whole file, fenced or not", () => {
  assert.deepEqual(parseAgentFileEdit("<reply>Added an email input.</reply>\n<file>\ndescription: x\nurl: https://a.test\n</file>"), {
    reply: "Added an email input.",
    file: "description: x\nurl: https://a.test\n",
  });
  assert.deepEqual(parseAgentFileEdit("```\n<reply>Done</reply>\n<file>\n```yaml\na: 1\n```\n</file>\n```"), { reply: "Done", file: "a: 1\n" });
  assert.equal(parseAgentFileEdit("Sorry, I can't."), null);
  assert.equal(parseAgentFileEdit("<file>\n\n</file>"), null);
});
