import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSse } from "./sse.ts";
import { collect, sseStream } from "./test-helpers.ts";

test("parses events split across chunks and line endings", async () => {
  const messages = await collect(
    parseSse(sseStream(["event: a\r", "\ndata: {\"x\":1}\r\n\r\n", ": keep-alive\n", "data: line1\ndata: line2\n\n"])),
  );
  assert.deepEqual(messages, [
    { event: "a", data: '{"x":1}' },
    { event: undefined, data: "line1\nline2" },
  ]);
});

test("flushes a final message without a trailing blank line", async () => {
  const messages = await collect(parseSse(sseStream(["event: done\ndata: bye"])));
  assert.deepEqual(messages, [{ event: "done", data: "bye" }]);
});
