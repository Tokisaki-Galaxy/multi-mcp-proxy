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
import { isConclusion } from "../src/peek.ts";

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
