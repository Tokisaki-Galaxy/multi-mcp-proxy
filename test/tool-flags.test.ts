/**
 * Reading replay safety out of a tools/list response.
 *
 * Both hints default to false in the specification, so anything absent or
 * malformed has to come out unsafe. The table is what the forwarder consults
 * before letting a tools/call retry, and a wrong yes here is a duplicate charge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectToolFlags, TOOL_FLAG_MAX } from "../src/pool-logic.ts";

function list(tools: unknown[]) {
  return { jsonrpc: "2.0", id: 1, result: { tools } };
}

test("reads readOnlyHint", () => {
  const flags = collectToolFlags(list([{ name: "search", annotations: { readOnlyHint: true } }]));
  assert.deepEqual(flags, [{ name: "search", readOnly: true, idempotent: false }]);
});

test("reads idempotentHint", () => {
  const flags = collectToolFlags(list([{ name: "upsert", annotations: { idempotentHint: true } }]));
  assert.deepEqual(flags, [{ name: "upsert", readOnly: false, idempotent: true }]);
});

test("treats a missing annotations object as unsafe", () => {
  const flags = collectToolFlags(list([{ name: "delete_everything" }]));
  assert.deepEqual(flags, [{ name: "delete_everything", readOnly: false, idempotent: false }]);
});

test("treats an empty annotations object as unsafe", () => {
  const flags = collectToolFlags(list([{ name: "write", annotations: {} }]));
  assert.deepEqual(flags, [{ name: "write", readOnly: false, idempotent: false }]);
});

test("risk hints do not grant replay safety", () => {
  const flags = collectToolFlags(
    list([{ name: "additive", annotations: { destructiveHint: false, openWorldHint: false } }])
  );
  assert.deepEqual(flags, [{ name: "additive", readOnly: false, idempotent: false }]);
});

test("a non-boolean hint is not trusted", () => {
  const flags = collectToolFlags(
    list([{ name: "sloppy", annotations: { readOnlyHint: "true", idempotentHint: 1 } }])
  );
  assert.deepEqual(flags, [{ name: "sloppy", readOnly: false, idempotent: false }]);
});

test("ignores a response that is not a tool list", () => {
  assert.deepEqual(collectToolFlags({ jsonrpc: "2.0", id: 1, result: { content: [] } }), []);
  assert.deepEqual(collectToolFlags({ jsonrpc: "2.0", id: 1, error: { message: "no" } }), []);
  assert.deepEqual(collectToolFlags(null), []);
  assert.deepEqual(collectToolFlags("tools"), []);
});

test("skips entries without a usable name", () => {
  const flags = collectToolFlags(
    list([
      { annotations: { readOnlyHint: true } },
      { name: "", annotations: { readOnlyHint: true } },
      { name: 42 },
      { name: "good", annotations: { readOnlyHint: true } },
    ])
  );
  assert.deepEqual(flags, [{ name: "good", readOnly: true, idempotent: false }]);
});

test("caps the number of tools read from one response", () => {
  const many = Array.from({ length: TOOL_FLAG_MAX + 10 }, (_, i) => ({
    name: `tool_${i}`,
    annotations: { readOnlyHint: true },
  }));
  assert.equal(collectToolFlags(list(many)).length, TOOL_FLAG_MAX);
});

test("respects a caller supplied limit", () => {
  const flags = collectToolFlags(list([{ name: "a" }, { name: "b" }, { name: "c" }]), 2);
  assert.deepEqual(
    flags.map((f) => f.name),
    ["a", "b"]
  );
});
