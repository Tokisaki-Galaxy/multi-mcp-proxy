/**
 * Resource affinity: extracting ids from tool results, and narrowing request
 * arguments down to candidates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCandidateIds, collectResultIds } from "../src/pool-logic.ts";

const FIELDS = ["id", "scrapeId", "uploadRef"];

/* ---------------------------------------------------------------- result ids */

test("reads an id from a text block that holds JSON", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [
        { type: "text", text: JSON.stringify({ id: "01a1c63f-43f4-7738-9b87-51c319dc0394", status: "completed" }) },
      ],
    },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), ["01a1c63f-43f4-7738-9b87-51c319dc0394"]);
});

test("reads an id from structuredContent", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { structuredContent: { scrapeId: "fc1.MkV3nQ8pRtYz" } },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), ["fc1.MkV3nQ8pRtYz"]);
});

test("reads uploadRef from a parse response", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: '{"uploadRef":"up_9f3ac21be7d04a5b","contentType":"application/pdf"}' }] },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), ["up_9f3ac21be7d04a5b"]);
});

test("returns every declared field that is present, deduplicated", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      structuredContent: { id: "01a1c63f-43f4-7738-9b87-51c319dc0394", scrapeId: "fc1.abcdefgh" },
      content: [{ type: "text", text: '{"id":"01a1c63f-43f4-7738-9b87-51c319dc0394"}' }],
    },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), ["01a1c63f-43f4-7738-9b87-51c319dc0394", "fc1.abcdefgh"]);
});

test("ignores ids nested inside result rows", () => {
  // A search response has an `id` on every hit. Binding those would pin future
  // queries to keys that never created anything.
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ data: [{ id: "01a1c63f-43f4-7738-9b87-51c319dc0394" }] }) }],
    },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), []);
});

test("ignores a plain prose result", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "The page was scraped successfully." }] },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), []);
});

test("ignores an error result", () => {
  const payload = { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } };
  assert.deepEqual(collectResultIds(payload, FIELDS), []);
});

test("ignores a field whose value is too short to be an id", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { structuredContent: { id: "abc" } },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), []);
});

test("ignores a field whose value contains whitespace", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { structuredContent: { id: "not an id at all" } },
  };
  assert.deepEqual(collectResultIds(payload, FIELDS), []);
});

test("an empty field list yields nothing", () => {
  const payload = { jsonrpc: "2.0", id: 1, result: { structuredContent: { id: "01a1c63f-43f4-7738" } } };
  assert.deepEqual(collectResultIds(payload, []), []);
});

/* ------------------------------------------------------------- arg candidates */

test("finds an id at the top level of the arguments", () => {
  const args = { id: "01a1c63f-43f4-7738-9b87-51c319dc0394" };
  assert.deepEqual(collectCandidateIds(args), ["01a1c63f-43f4-7738-9b87-51c319dc0394"]);
});

test("finds an id nested inside an options object", () => {
  const args = { scrapeOptions: { scrapeId: "fc1.MkV3nQ8pRtYz" }, prompt: "click login" };
  assert.deepEqual(collectCandidateIds(args), ["fc1.MkV3nQ8pRtYz"]);
});

test("finds an id inside an array", () => {
  const args = { ids: ["01a1c63f-43f4-7738", "01a1c63f-9999-0000"] };
  assert.deepEqual(collectCandidateIds(args), ["01a1c63f-43f4-7738", "01a1c63f-9999-0000"]);
});

test("a natural language query is not offered as a candidate", () => {
  // Four words with spaces; it can never be an id, so it never reaches the ledger.
  const args = { query: "how do cloudflare durable objects work" };
  assert.deepEqual(collectCandidateIds(args), []);
});

test("deduplicates repeated ids", () => {
  const args = { id: "01a1c63f-43f4-7738", nested: { id: "01a1c63f-43f4-7738" } };
  assert.deepEqual(collectCandidateIds(args), ["01a1c63f-43f4-7738"]);
});

test("stops at the candidate cap", () => {
  const many = Array.from({ length: 200 }, (_, i) => `candidate-id-${String(i).padStart(4, "0")}`);
  const out = collectCandidateIds({ many });
  assert.ok(out.length <= 64, `expected at most 64, got ${out.length}`);
});

test("stops walking past the depth limit", () => {
  const deep = { a: { b: { c: { d: { e: { id: "01a1c63f-43f4-7738" } } } } } };
  assert.deepEqual(collectCandidateIds(deep), []);
});

test("handles null, undefined and primitives", () => {
  assert.deepEqual(collectCandidateIds(null), []);
  assert.deepEqual(collectCandidateIds(undefined), []);
  assert.deepEqual(collectCandidateIds(42), []);
  assert.deepEqual(collectCandidateIds(""), []);
  assert.deepEqual(collectCandidateIds({}), []);
});
