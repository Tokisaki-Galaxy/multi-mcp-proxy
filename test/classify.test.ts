/**
 * This suite runs on node's own type stripping, not through a bundler, so the
 * three suppressions below come from the project's tooling rather than the
 * tests: node:test and node:assert have no @types/node here, and tsc rejects a
 * .ts import path unless allowImportingTsExtensions is on. Adding @types/node
 * and that flag is the real fix, and both files carrying them are off limits.
 */
// @ts-ignore node:test has no type declarations in this project
import { test } from "node:test";
// @ts-ignore node:assert has no type declarations in this project
import assert from "node:assert/strict";

import type { ClassifyResult, QuotaRules } from "../src/types";
// @ts-ignore node refuses an extensionless specifier, tsc refuses the .ts one
import { classifyHttp, classifyMcpResult, classifyPayload } from "../src/classify.ts";

const DAY = 24 * 60 * 60 * 1000;

function rules(over: Partial<QuotaRules> = {}): QuotaRules {
  return {
    invalidStatuses: [],
    exhaustedStatuses: [],
    cooldownStatuses: [],
    reset: "month",
    ...over,
  };
}

const firecrawlRules = rules({ invalidStatuses: [401, 403] });
const exaRules = rules({ invalidStatuses: [401, 403], exhaustedStatuses: [402], cooldownStatuses: [429] });
const tavilyRules = rules({ invalidStatuses: [401], exhaustedStatuses: [432, 433], cooldownStatuses: [429] });

/** assert.ok plus a cast, because assert has no types in this project. */
function found(result: ClassifyResult | null): ClassifyResult {
  assert.ok(result, "expected a classification");
  return result as ClassifyResult;
}

const FIRECRAWL_INVALID_KEY =
  '{"result":{"content":[{"type":"text","text":"The Firecrawl API key is invalid or revoked.\\nFix: Replace the key on the existing Firecrawl MCP server, then start a new session. Get an API key at https://www.firecrawl.dev/app/api-keys"}],"isError":true},"jsonrpc":"2.0","id":9}';

const EXA_INVALID_KEY =
  '{"result":{"content":[{"type":"text","text":"web_search_exa error (401): Invalid API key. Provide a valid key using \'Authorization: Bearer <key>\' or \'x-api-key: <key>\'. Create a key at https://dashboard.exa.ai/api-keys\\nTimestamp: 2026-11-10T11:43:42.180Z"}],"isError":true},"jsonrpc":"2.0","id":9}';

const TAVILY_INVALID_KEY =
  '{"result":{"content":[{"text":"{\\"error\\":\\"Search failed\\",\\"status\\":401,\\"detail\\":{\\"error\\":\\"Unauthorized: missing or invalid API key.\\"},\\"documentation\\":\\"https://docs.tavily.com/documentation/api-reference/endpoint/search\\"}","type":"text"}],"isError":true},"jsonrpc":"2.0","id":3}';

const TAVILY_NO_SESSION =
  '{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Missing mcp-session-id header. Please reconnect to start a new session."}}';

const NOT_ACCEPTABLE =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}';

const NORMAL_SEARCH_RESULT =
  '{"result":{"content":[{"type":"text","text":"Title: Unauthorized access explained\\nURL: https://example.com/x"}]},"jsonrpc":"2.0","id":5}';

test("sample 1: Firecrawl dead key wrapped in HTTP 200", () => {
  const transport = classifyHttp(200, new Headers(), FIRECRAWL_INVALID_KEY, firecrawlRules, false);
  assert.equal(transport.verdict, "ok");
  assert.equal(transport.status, 200);

  const result = found(classifyMcpResult(JSON.parse(FIRECRAWL_INVALID_KEY), firecrawlRules));
  assert.equal(result.verdict, "invalid");
  assert.equal(result.requestNotProcessed, true);
});

test("sample 2: Exa dead key wrapped in HTTP 200, status parsed from prose", () => {
  const result = found(classifyMcpResult(JSON.parse(EXA_INVALID_KEY), exaRules));
  assert.equal(result.verdict, "invalid");
  assert.equal(result.status, 401);
});

test("sample 3: Tavily dead key inside a JSON string in a text block", () => {
  const result = found(classifyMcpResult(JSON.parse(TAVILY_INVALID_KEY), tavilyRules));
  assert.equal(result.verdict, "invalid");
  assert.equal(result.status, 401);
});

test("sample 4: missing session is a client error, never a dead key", () => {
  const transport = classifyHttp(400, new Headers(), TAVILY_NO_SESSION, tavilyRules, false);
  assert.equal(transport.verdict, "client");
  assert.equal(transport.status, 400);
  assert.match(transport.message, /Missing mcp-session-id/);

  const payload = found(classifyMcpResult(JSON.parse(TAVILY_NO_SESSION), tavilyRules));
  assert.equal(payload.verdict, "client");
});

test("sample 5: unacceptable Accept header is a client error", () => {
  const transport = classifyHttp(406, new Headers(), NOT_ACCEPTABLE, exaRules, false);
  assert.equal(transport.verdict, "client");

  const payload = found(classifyMcpResult(JSON.parse(NOT_ACCEPTABLE), exaRules));
  assert.equal(payload.verdict, "client");
});

test("sample 6: a search hit that mentions Unauthorized is not a failure", () => {
  assert.equal(classifyMcpResult(JSON.parse(NORMAL_SEARCH_RESULT), exaRules), null);
  assert.equal(classifyMcpResult(JSON.parse(NORMAL_SEARCH_RESULT), firecrawlRules), null);
});

test("sample 7: configured exhausted status with empty body", () => {
  const result = classifyHttp(432, new Headers(), "", tavilyRules, false);
  assert.equal(result.verdict, "exhausted");
  assert.equal(result.status, 432);
  assert.equal(result.requestNotProcessed, true);
});

test("sample 8: 429 cooldown honours Retry-After seconds", () => {
  const result = classifyHttp(429, new Headers({ "retry-after": "30" }), "", exaRules, false);
  assert.equal(result.verdict, "cooldown");
  assert.equal(result.retryAfterMs, 30_000);
  assert.equal(result.requestNotProcessed, true);
});

test("Retry-After accepts an HTTP date", () => {
  const at = new Date(Date.now() + 45_000).toUTCString();
  const result = classifyHttp(429, new Headers({ "retry-after": at }), "", exaRules, false);
  assert.equal(result.verdict, "cooldown");
  const wait = result.retryAfterMs ?? -1;
  assert.ok(wait >= 40_000 && wait <= 46_000, `got ${wait}`);
});

test("Retry-After falls back to a minute when unusable and clamps at a day", () => {
  const garbage = classifyHttp(429, new Headers({ "retry-after": "soon" }), "", exaRules, false);
  assert.equal(garbage.retryAfterMs, 60_000);

  const missing = classifyHttp(429, new Headers(), "", exaRules, false);
  assert.equal(missing.retryAfterMs, 60_000);

  const huge = classifyHttp(429, new Headers({ "retry-after": "999999" }), "", exaRules, false);
  assert.equal(huge.retryAfterMs, DAY);
});

test("5xx is only replayable when the service opts in", () => {
  const careful = classifyHttp(503, new Headers(), '{"error":{"message":"upstream overloaded"}}', exaRules, false);
  assert.equal(careful.verdict, "server");
  assert.equal(careful.requestNotProcessed, false);

  const brave = classifyHttp(503, new Headers(), "", exaRules, true);
  assert.equal(brave.verdict, "server");
  assert.equal(brave.requestNotProcessed, true);
});

test("a 5xx body that mentions a key never blames the key", () => {
  const result = classifyHttp(500, new Headers(), "Invalid API key: internal error", exaRules, false);
  assert.equal(result.verdict, "server");
});

test("an isError result that matches no rule is a client error", () => {
  const payload = {
    result: { content: [{ type: "text", text: "Something went wrong, please try again later." }], isError: true },
    jsonrpc: "2.0",
    id: 1,
  };
  const result = found(classifyMcpResult(payload, exaRules));
  assert.equal(result.verdict, "client");
  assert.equal(result.requestNotProcessed, true);
});

test("explicit rules win over the status defaults", () => {
  const forbiddenAsDead = rules({ invalidStatuses: [403] });
  const result = classifyHttp(403, new Headers(), "", forbiddenAsDead, false);
  assert.equal(result.verdict, "invalid");
});

test("an unconfigured 402 stays a client error at the transport layer", () => {
  const result = classifyHttp(402, new Headers(), "", rules(), false);
  assert.equal(result.verdict, "client");
});

test("quota wording in an error envelope marks the key exhausted", () => {
  const payload = {
    result: { content: [{ type: "text", text: "You have no more credits left on this plan." }], isError: true },
    jsonrpc: "2.0",
    id: 2,
  };
  const result = found(classifyMcpResult(payload, exaRules));
  assert.equal(result.verdict, "exhausted");
  assert.equal(result.requestNotProcessed, true);
});

test("a successful result that merely mentions credits stays clean", () => {
  const payload = {
    result: { content: [{ type: "text", text: "Pricing: no more credits than the free tier includes." }] },
    jsonrpc: "2.0",
    id: 3,
  };
  assert.equal(classifyMcpResult(payload, exaRules), null);
});

test("classifyPayload reads an error envelope on its own", () => {
  const result = found(
    classifyPayload(
      { error: "Search failed", status: 401, detail: { error: "Unauthorized: missing or invalid API key." } },
      tavilyRules
    )
  );
  assert.equal(result.verdict, "invalid");
  assert.equal(result.status, 401);

  assert.equal(classifyPayload({ results: [{ title: "Unauthorized access explained" }] }, tavilyRules), null);
  assert.equal(classifyPayload("plain string", tavilyRules), null);
  assert.equal(classifyPayload(null, tavilyRules), null);
});

test("classifyPayload maps an upstream tag to a verdict", () => {
  const result = found(classifyPayload({ error: { tag: "NO_MORE_CREDITS", message: "Plan budget is gone" } }, exaRules));
  assert.equal(result.verdict, "exhausted");
  assert.equal(result.status, 402);
  assert.equal(result.code, "NO_MORE_CREDITS");
});

test("classifyMcpResult ignores shapes that cannot be an error", () => {
  assert.equal(classifyMcpResult(null, exaRules), null);
  assert.equal(classifyMcpResult(undefined, exaRules), null);
  assert.equal(classifyMcpResult({}, exaRules), null);
  assert.equal(classifyMcpResult({ jsonrpc: "2.0", id: 1 }, exaRules), null);
  assert.equal(classifyMcpResult({ result: { content: [] } }, exaRules), null);
  assert.equal(classifyMcpResult({ result: { content: [{ type: "image", data: "..." }] } }, exaRules), null);
});

test("classifyHttp reports ok for 2xx so the caller keeps looking at the body", () => {
  assert.equal(classifyHttp(200, new Headers(), "", exaRules, false).verdict, "ok");
  assert.equal(classifyHttp(204, new Headers(), "", exaRules, false).verdict, "ok");
  assert.equal(classifyHttp(201, new Headers(), "not json at all", exaRules, false).verdict, "ok");
});

test("upstream tags in a 200 body are surfaced for the admin log", () => {
  const text =
    '{"result":{"content":[{"type":"text","text":"TEAM_BUDGET_EXCEEDED: the team ran out of budget"}],"isError":true},"jsonrpc":"2.0","id":7}';
  const result = found(classifyMcpResult(JSON.parse(text), exaRules));
  assert.equal(result.verdict, "exhausted");
  assert.equal(result.code, "TEAM_BUDGET_EXCEEDED");
});

test("long upstream text is truncated before it reaches the log", () => {
  const long = "X".repeat(2000);
  const result = classifyHttp(400, new Headers(), long, exaRules, false);
  assert.ok(result.message.length <= 420, `got ${result.message.length}`);
  assert.ok(result.message.startsWith("HTTP 400: "));
});
