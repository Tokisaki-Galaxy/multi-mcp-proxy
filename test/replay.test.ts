/**
 * Replay safety.
 *
 * The proxy sits below the application, so it cannot tell whether a tool had
 * side effects. These tests pin the two facts that decide a retry: where the
 * failure was reported, and whether the tool declared itself safe to repeat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHttp, classifyMcpResult } from "../src/classify.ts";
import { shouldReplay } from "../src/pool-logic.ts";
import type { ClassifyResult, QuotaRules } from "../src/types.ts";

const RULES: QuotaRules = {
  exhaustedStatuses: [402],
  cooldownStatuses: [429],
  invalidStatuses: [401],
  reset: "month",
  resetDay: 1,
};

/** A tool result that reports a failure inside an HTTP 200 body. */
function bodyFailure(text: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function verdict(over: Partial<ClassifyResult>): ClassifyResult {
  return { verdict: "ok", message: "", requestNotProcessed: false, ...over };
}

/* ---------------------------------------------------------- where it came from */

test("a 4xx at the status line counts as not processed", () => {
  for (const status of [401, 402, 429]) {
    const result = classifyHttp(status, new Headers(), "", RULES, false);
    assert.equal(result.requestNotProcessed, true, `HTTP ${status} should be pre-execution`);
  }
});

test("a failure inside the body never counts as not processed", () => {
  const limited = classifyMcpResult(bodyFailure("rate limit exceeded"), RULES)!;
  assert.equal(limited.verdict, "cooldown");
  assert.equal(limited.requestNotProcessed, false);

  const dead = classifyMcpResult(bodyFailure("Invalid API key"), RULES)!;
  assert.equal(dead.verdict, "invalid");
  assert.equal(dead.requestNotProcessed, false);

  const empty = classifyMcpResult(bodyFailure("You have no more credits left"), RULES)!;
  assert.equal(empty.verdict, "exhausted");
  assert.equal(empty.requestNotProcessed, false);
});

test("a 5xx is marked processed unless the service opts in", () => {
  assert.equal(classifyHttp(503, new Headers(), "", RULES, false).requestNotProcessed, false);
  assert.equal(classifyHttp(503, new Headers(), "", RULES, true).requestNotProcessed, true);
});

/* ------------------------------------------------------------------- decisions */

test("a pre-execution rejection replays even for an unsafe tool", () => {
  for (const status of [401, 402, 429]) {
    const result = classifyHttp(status, new Headers(), "", RULES, false);
    assert.equal(shouldReplay(result, { retryOn5xx: false, toolSafe: false }), true, `HTTP ${status}`);
  }
});

test("a body-level failure does not replay for an unannotated tool", () => {
  const limited = classifyMcpResult(bodyFailure("rate limit exceeded"), RULES)!;
  assert.equal(shouldReplay(limited, { retryOn5xx: false, toolSafe: false }), false);
});

test("a body-level failure replays once the tool declares itself safe", () => {
  const limited = classifyMcpResult(bodyFailure("rate limit exceeded"), RULES)!;
  assert.equal(shouldReplay(limited, { retryOn5xx: false, toolSafe: true }), true);

  const dead = classifyMcpResult(bodyFailure("Invalid API key"), RULES)!;
  assert.equal(shouldReplay(dead, { retryOn5xx: false, toolSafe: true }), true);
});

test("network and client failures never replay", () => {
  assert.equal(
    shouldReplay(verdict({ verdict: "network" }), { retryOn5xx: true, toolSafe: true }),
    false
  );
  assert.equal(
    shouldReplay(verdict({ verdict: "client", requestNotProcessed: true }), {
      retryOn5xx: true,
      toolSafe: true,
    }),
    false
  );
});

test("a server failure depends on both the opt-in and the processed flag", () => {
  const processed = verdict({ verdict: "server", requestNotProcessed: true });
  const unprocessed = verdict({ verdict: "server", requestNotProcessed: false });

  assert.equal(shouldReplay(processed, { retryOn5xx: true, toolSafe: false }), true);
  assert.equal(shouldReplay(processed, { retryOn5xx: false, toolSafe: false }), false);
  assert.equal(shouldReplay(unprocessed, { retryOn5xx: true, toolSafe: true }), false);
});

test("a healthy response is never replayed", () => {
  assert.equal(
    shouldReplay(verdict({ verdict: "ok", requestNotProcessed: true }), {
      retryOn5xx: true,
      toolSafe: true,
    }),
    false
  );
});
