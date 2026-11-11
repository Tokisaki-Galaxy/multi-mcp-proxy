/**
 * Which SSE events end a request.
 *
 * The peek used to stop at the first complete event. A slow tool emits
 * `notifications/progress` before its result, so that rule threw the real answer
 * away and recorded the call as healthy. These tests pin what counts as a
 * conclusion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { conclusionProbe, hasConclusion, isConclusion, ssePayloads } from "../src/peek.ts";

test("a result response concludes the request", () => {
  assert.equal(
    isConclusion({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "done" }] } }),
    true
  );
});

test("an error response concludes the request", () => {
  assert.equal(
    isConclusion({ jsonrpc: "2.0", id: 9, error: { code: -32603, message: "boom" } }),
    true
  );
});

test("a progress notification does not conclude the request", () => {
  assert.equal(
    isConclusion({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "a1", progress: 1, total: 3 },
    }),
    false
  );
});

test("any other notification does not conclude the request", () => {
  assert.equal(
    isConclusion({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } }),
    false
  );
});

test("an input_required result still concludes the request", () => {
  // 2026 multi round-trip requests answer with a result, not an error. The client
  // continues from it, and the proxy must not treat it as unfinished.
  assert.equal(
    isConclusion({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "input_required", inputRequests: { login: { method: "elicitation/create" } } },
    }),
    true
  );
});

test("an empty result carrier is not a conclusion", () => {
  assert.equal(isConclusion({ jsonrpc: "2.0", id: 1, result: null }), false);
});

test("an explicit empty error carrier is not a conclusion", () => {
  assert.equal(isConclusion({ jsonrpc: "2.0", id: 1, error: null }), false);
  assert.equal(isConclusion({ jsonrpc: "2.0", id: 1, error: "" }), false);
  assert.equal(isConclusion({ jsonrpc: "2.0", id: 1, error: false }), false);
});

test("non-objects are never conclusions", () => {
  for (const value of [null, undefined, 42, "result", true, [1, 2, 3]]) {
    assert.equal(isConclusion(value), false);
  }
});

/* ------------------------------------------------------------ framing */

const PROGRESS = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n';
const RESULT = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';

test("reads the outcome behind a notification", () => {
  assert.equal(hasConclusion(PROGRESS + RESULT), true);
  assert.equal(hasConclusion(PROGRESS), false);
});

test("recognises CRLF framing", () => {
  // The spec allows CRLF, and an upstream that uses it must not send the peek to
  // its time cap on every request.
  const crlf = (line: string) => `${line.split("\n").join("\r\n")}\r\n\r\n`;
  const progress = crlf('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}');
  const result = crlf('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}');
  assert.equal(hasConclusion(progress), false);
  assert.equal(hasConclusion(progress + result), true);
});

test("joins multi line data before parsing", () => {
  const split = 'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{}}\n\n';
  assert.equal(hasConclusion(split), true);
  assert.deepEqual(ssePayloads(split), [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("an event without its closing blank line decides nothing yet", () => {
  // Its data line is complete, but the event could still grow, so the peek keeps
  // reading. Classification of what already arrived still sees the payload.
  const open = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
  assert.equal(hasConclusion(open), false);
  assert.deepEqual(ssePayloads(open), [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("ignores comments, other fields and non-JSON data", () => {
  const body =
    ": keep-alive\n\n" +
    'event: message\nid: 7\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n' +
    "data: not json\n\n" +
    RESULT;
  assert.deepEqual(ssePayloads(body), [
    { jsonrpc: "2.0", method: "notifications/message" },
    { jsonrpc: "2.0", id: 1, result: {} },
  ]);
  assert.equal(hasConclusion(body), true);
});

test("the incremental probe finds the same conclusion a full scan would", () => {
  const body = PROGRESS + RESULT;
  const probe = conclusionProbe();
  let seen = false;
  // One byte at a time is the worst case a stream can hand over.
  for (let i = 1; i <= body.length; i++) {
    seen = probe.feed(body.slice(0, i)) || seen;
    if (seen) {
      assert.equal(i >= PROGRESS.length + RESULT.length, true, "concluded before the outcome arrived");
      break;
    }
  }
  assert.equal(seen, true);
});
