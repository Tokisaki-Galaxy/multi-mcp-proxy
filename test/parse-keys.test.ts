import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeyInput } from "../src/key-input.ts";

test("one bare key per line still works", () => {
  const out = parseKeyInput("tvly-aaa\ntvly-bbb");
  assert.deepEqual(out, [{ secret: "tvly-aaa" }, { secret: "tvly-bbb" }]);
});

test("a trailing note after a comma becomes the label", () => {
  const out = parseKeyInput("tvly-aaa,小号一号\ntvly-bbb,备用");
  assert.deepEqual(out, [
    { secret: "tvly-aaa", label: "小号一号" },
    { secret: "tvly-bbb", label: "备用" },
  ]);
});

test("mixing labelled and bare lines works", () => {
  const out = parseKeyInput("tvly-aaa,谁谁谁的\ntvly-bbb");
  assert.deepEqual(out, [{ secret: "tvly-aaa", label: "谁谁谁的" }, { secret: "tvly-bbb" }]);
});

test("a note containing a comma is kept whole", () => {
  const out = parseKeyInput("tvly-aaa,甲,乙,丙");
  assert.deepEqual(out, [{ secret: "tvly-aaa", label: "甲,乙,丙" }]);
});

test("empty note after the comma is dropped, not stored as blank", () => {
  const out = parseKeyInput("tvly-aaa,");
  assert.deepEqual(out, [{ secret: "tvly-aaa" }]);
});

test("blank lines and comment lines are skipped", () => {
  const out = parseKeyInput("\n# 这是注释\n\ntvly-aaa,一号\n\n");
  assert.deepEqual(out, [{ secret: "tvly-aaa", label: "一号" }]);
});

test("surrounding whitespace is trimmed on both parts", () => {
  const out = parseKeyInput("  tvly-aaa , 一号 key  ");
  assert.deepEqual(out, [{ secret: "tvly-aaa", label: "一号 key" }]);
});

test("CRLF input from a Windows paste is handled", () => {
  const out = parseKeyInput("tvly-aaa,一号\r\ntvly-bbb,二号\r\n");
  assert.deepEqual(out, [
    { secret: "tvly-aaa", label: "一号" },
    { secret: "tvly-bbb", label: "二号" },
  ]);
});

test("array of strings is accepted", () => {
  const out = parseKeyInput(["tvly-aaa,一号", "tvly-bbb"]);
  assert.deepEqual(out, [{ secret: "tvly-aaa", label: "一号" }, { secret: "tvly-bbb" }]);
});

test("array of objects is accepted, including the note alias", () => {
  const out = parseKeyInput([
    { secret: "tvly-aaa", label: "一号" },
    { secret: "tvly-bbb", note: "二号" },
    { key: "tvly-ccc" },
  ]);
  assert.deepEqual(out, [
    { secret: "tvly-aaa", label: "一号" },
    { secret: "tvly-bbb", label: "二号" },
    { secret: "tvly-ccc" },
  ]);
});

test("a line that is only a comma yields nothing", () => {
  assert.deepEqual(parseKeyInput(",只写了备注"), []);
});

test("non-string non-array input yields nothing", () => {
  assert.deepEqual(parseKeyInput(undefined), []);
  assert.deepEqual(parseKeyInput(null), []);
  assert.deepEqual(parseKeyInput(42), []);
});
