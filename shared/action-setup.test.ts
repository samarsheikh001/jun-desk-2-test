import assert from "node:assert/strict";
import { test } from "node:test";
import { actionSetupProblems, exampleHost, secretRefs, userSecretRefs } from "./action-setup.ts";

test("AI-24: an action that can't work yet says why: a key not added, an example address, the starter text", () => {
  const ready = { description: "Finds an order.", url: "https://api.acme.com/orders/{id}", headers: { Authorization: "Bearer {secrets.ACME_KEY}" } };
  assert.deepEqual(actionSetupProblems(ready, (n) => n === "ACME_KEY"), []);
  assert.deepEqual(actionSetupProblems(ready, () => false), ["The key ACME_KEY isn't added yet."]);
  const starter = { description: "What this returns and when the AI should use it.", url: "https://api.example.com/things/{id}", headers: { Authorization: "Bearer {secrets.API_KEY}" } };
  assert.equal(actionSetupProblems(starter, () => false).length, 3);
  // The customer's own key comes with their sign-in: never a setup problem.
  assert.deepEqual(actionSetupProblems({ ...ready, headers: { Authorization: "Bearer {user.secrets.API_TOKEN}" } }, () => false), []);
  // No address (only shows a widget): nothing to check.
  assert.deepEqual(actionSetupProblems({ ...ready, url: "", headers: {} }, () => false), []);
});

test("AI-24: key names from headers; example hosts", () => {
  assert.deepEqual(secretRefs(["Bearer {secrets.A_KEY}", "{secrets.A_KEY} {user.secrets.TOKEN}"]), ["A_KEY"]);
  assert.deepEqual(userSecretRefs(["Bearer {user.secrets.TOKEN}"]), ["TOKEN"]);
  assert.equal(exampleHost("https://api.example.com/x/{id}"), "api.example.com");
  assert.equal(exampleHost("https://example.org"), "example.org");
  assert.equal(exampleHost("https://myexample.com"), null);
  assert.equal(exampleHost("https://api.acme.com"), null);
});
