import assert from "node:assert/strict";
import { test } from "node:test";
import { editFrontmatter, editYaml, freshName, readFrontmatter, readYaml, setBody } from "./agentFiles.ts";

const AGENTS = `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly.
`;

test("frontmatter edits keep comments, other keys and the body", () => {
  const out = editFrontmatter(AGENTS, { op: "set", path: ["maxReplies"], value: 5 });
  assert.match(out, /# Guardrails\. Remove a line/);
  assert.match(out, /maxReplies: 5 +# AI replies per conversation/);
  assert.match(out, /- legal or security questions/);
  assert.ok(out.endsWith("# How to talk to customers\n\n- Be friendly.\n"));
  const topics = editFrontmatter(out, { op: "set", path: ["handoffTopics"], value: ["legal", "refunds over $500"] });
  assert.deepEqual(readFrontmatter(topics).data?.handoffTopics, ["legal", "refunds over $500"]);
  assert.match(topics, /# always hand these to a person/);
});

test("frontmatter is created when missing and dropped when emptied", () => {
  const added = editFrontmatter("Body\n", { op: "set", path: ["maxReplies"], value: 3 });
  assert.equal(added, "---\nmaxReplies: 3\n---\nBody\n");
  assert.equal(editFrontmatter(added, { op: "set", path: ["maxReplies"], value: "" }), "Body\n");
  assert.equal(setBody(AGENTS, "New body\n").split("---\n").at(-1), "New body\n");
});

test("yaml edits: rename a map key in place, remove an emptied map, push and remove list items", () => {
  const tool = "description: Find an order\nheaders:\n  Authorization: Bearer {secrets.KEY}\ninput:\n  id:\n    type: string\n  email:\n    type: string\n";
  const renamed = editYaml(tool, { op: "rename", path: ["input"], from: "id", to: "order_id" });
  assert.deepEqual(Object.keys((readYaml(renamed) as { input: object }).input), ["order_id", "email"]);
  const noHeaders = editYaml(tool, { op: "set", path: ["headers", "Authorization"], value: "" });
  assert.ok(!noHeaders.includes("headers"));
  const evals = editYaml("- name: a\n  message: hi\n", { op: "push", path: [], value: { name: "b", message: "yo" } });
  assert.deepEqual((readYaml(evals) as { name: string }[]).map((c) => c.name), ["a", "b"]);
  assert.deepEqual(readYaml(editYaml(evals, { op: "remove", path: [], index: 0 })), [{ name: "b", message: "yo" }]);
});

test("a file that doesn't parse is left alone", () => {
  assert.equal(readYaml("a: [1"), null);
  assert.equal(editYaml("a: [1", { op: "set", path: ["a"], value: 2 }), "a: [1");
  assert.equal(freshName("detail", ["detail", "detail_2"]), "detail_3");
});
