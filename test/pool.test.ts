/**
 * Unit tests for the runtime-free half of src/pool.ts.
 *
 * The Durable Object itself cannot run under plain Node: there is no SQLite
 * storage binding and no workerd. Everything that can be decided without
 * storage is exported as a pure function and covered here.
 *
 * Node 24 strips types natively, so the import carries an explicit .ts
 * extension. A .js extension would not resolve, since Node never rewrites a
 * specifier to find a sibling .ts file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COOLDOWN_MS,
  MAX_ERRORS,
  buildProbeRequest,
  bumpErrorCount,
  compareCandidates,
  computeResetAt,
  decryptSecret,
  deriveCipherKey,
  deriveKeyId,
  encryptSecret,
  escalateStatus,
  maskKey,
  rankScore,
  readProbeValues,
  shareOf,
} from "../src/pool-logic.ts";
import type { ClassifyResult, QuotaRules } from "../src/types";

const monthRules: QuotaRules = { exhaustedStatuses: [402], cooldownStatuses: [429], invalidStatuses: [401], reset: "month", resetDay: 1 };
const dayRules: QuotaRules = { exhaustedStatuses: [402], cooldownStatuses: [429], invalidStatuses: [401], reset: "day" };
const manualRules: QuotaRules = { exhaustedStatuses: [402], cooldownStatuses: [429], invalidStatuses: [401], reset: "manual" };

function verdict(name: ClassifyResult["verdict"], extra: Partial<ClassifyResult> = {}): ClassifyResult {
  return { verdict: name, message: "test", requestNotProcessed: true, ...extra };
}

/* ---- masking ---- */

test("maskKey keeps head and tail of a long credential", () => {
  assert.equal(maskKey("tvly-abcdefghijklxyz"), "tvly-a...lxyz");
  assert.equal(maskKey("sk-proj-0123456789abcdef"), "sk-pro...cdef");
});

test("maskKey shortens short credentials to four characters", () => {
  assert.equal(maskKey("abcdefghij"), "abcd...");
  assert.equal(maskKey("abc"), "abc...");
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("   "), "");
});

/* ---- ranking ---- */

test("rankScore divides load by weight", () => {
  assert.equal(rankScore(0, 1), 1);
  assert.equal(rankScore(9, 1), 10);
  assert.equal(rankScore(9, 3), 10 / 3);
});

test("rankScore never divides by zero or a negative weight", () => {
  assert.equal(rankScore(3, 0), 4);
  assert.equal(rankScore(3, -5), 4);
  assert.equal(rankScore(-2, 2), 0.5);
  assert.equal(rankScore(Number.NaN, 2), 0.5);
});

test("compareCandidates prefers the lower load ratio so heavy keys take more traffic", () => {
  const heavy = { useCount: 10, weight: 5, lastUsedAt: 1000, id: "heavy" };
  const light = { useCount: 1, weight: 1, lastUsedAt: 1000, id: "light" };

  // 11/5 = 2.2 against 2/1 = 2.0: the light key is ahead until the heavy one
  // catches up, which is what spreads load in proportion to weight.
  assert.ok(compareCandidates(light, heavy) < 0);
  assert.equal(rankScore(heavy.useCount, heavy.weight), 2.2);
});

test("compareCandidates breaks ties on staleness then id", () => {
  const older = { useCount: 2, weight: 1, lastUsedAt: 500, id: "b" };
  const newer = { useCount: 2, weight: 1, lastUsedAt: 900, id: "a" };
  assert.ok(compareCandidates(older, newer) < 0);

  const same = { useCount: 2, weight: 1, lastUsedAt: 500, id: "a" };
  assert.ok(compareCandidates(older, same) > 0);
  assert.equal(compareCandidates(same, { ...same }), 0);
});

/* ---- reset windows ---- */

test("computeResetAt rolls daily quotas to the next UTC midnight", () => {
  const now = Date.UTC(2026, 4, 10, 12, 30, 0);
  assert.equal(computeResetAt(dayRules, now), Date.UTC(2026, 4, 11, 0, 0, 0));
});

test("computeResetAt crosses month boundaries for daily quotas", () => {
  const now = Date.UTC(2026, 4, 31, 23, 59, 0);
  assert.equal(computeResetAt(dayRules, now), Date.UTC(2026, 5, 1, 0, 0, 0));
});

test("computeResetAt uses next month when this month's reset day has passed", () => {
  const now = Date.UTC(2026, 4, 10, 8, 0, 0);
  assert.equal(computeResetAt(monthRules, now), Date.UTC(2026, 5, 1, 0, 0, 0));
});

test("computeResetAt uses this month when the reset day is still ahead", () => {
  const rules: QuotaRules = { ...monthRules, resetDay: 15 };
  const now = Date.UTC(2026, 4, 3, 0, 0, 0);
  assert.equal(computeResetAt(rules, now), Date.UTC(2026, 4, 15, 0, 0, 0));
});

test("computeResetAt treats a reset day of today at midnight as already gone", () => {
  const now = Date.UTC(2026, 4, 1, 0, 0, 0);
  assert.equal(computeResetAt(monthRules, now), Date.UTC(2026, 5, 1, 0, 0, 0));
});

test("computeResetAt clamps an impossible reset day to the month length", () => {
  const rules: QuotaRules = { ...monthRules, resetDay: 31 };
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  assert.equal(computeResetAt(rules, now), Date.UTC(2026, 1, 28, 0, 0, 0));
});

test("computeResetAt defaults the reset day to the first of the month", () => {
  const rules: QuotaRules = { exhaustedStatuses: [], cooldownStatuses: [], invalidStatuses: [], reset: "month" };
  const now = Date.UTC(2026, 6, 20, 0, 0, 0);
  assert.equal(computeResetAt(rules, now), Date.UTC(2026, 7, 1, 0, 0, 0));
});

test("computeResetAt returns the never-recover sentinel for manual resets", () => {
  assert.equal(computeResetAt(manualRules, Date.UTC(2026, 4, 10)), 0);
});

/* ---- report state machine ---- */

test("shareOf marks an ok key active with no gates", () => {
  const t = shareOf("active", verdict("ok"), monthRules, Date.UTC(2026, 4, 10));
  assert.deepEqual(t, { status: "active", cooldownUntil: 0, resetAt: 0 });
});

test("shareOf retires an invalid key", () => {
  const t = shareOf("active", verdict("invalid", { status: 401 }), monthRules, Date.UTC(2026, 4, 10));
  assert.deepEqual(t, { status: "invalid", cooldownUntil: 0, resetAt: 0 });
});

test("shareOf parks an exhausted key until its monthly window resets", () => {
  const now = Date.UTC(2026, 4, 10, 6, 0, 0);
  const t = shareOf("active", verdict("exhausted", { status: 402 }), monthRules, now);
  assert.equal(t.status, "exhausted");
  assert.equal(t.resetAt, Date.UTC(2026, 5, 1, 0, 0, 0));
  assert.equal(t.cooldownUntil, 0);
});

test("shareOf keeps manual exhaustion permanently parked", () => {
  const t = shareOf("active", verdict("exhausted"), manualRules, Date.UTC(2026, 4, 10));
  assert.equal(t.status, "exhausted");
  assert.equal(t.resetAt, 0);
});

test("shareOf keeps a rate-limited key active and sets a cooldown", () => {
  const now = Date.UTC(2026, 4, 10, 6, 0, 0);
  const t = shareOf("active", verdict("cooldown", { status: 429, retryAfterMs: 1500 }), monthRules, now);
  assert.deepEqual(t, { status: "active", cooldownUntil: now + 1500, resetAt: 0 });
});

test("shareOf falls back to the default cooldown when Retry-After is absent", () => {
  const now = Date.UTC(2026, 4, 10, 6, 0, 0);
  const t = shareOf("active", verdict("cooldown", { status: 429 }), monthRules, now);
  assert.equal(t.cooldownUntil, now + DEFAULT_COOLDOWN_MS);
});

test("shareOf ignores a nonsense Retry-After value", () => {
  const now = Date.UTC(2026, 4, 10, 6, 0, 0);
  for (const bad of [-1, 0, Number.NaN]) {
    const t = shareOf("active", verdict("cooldown", { retryAfterMs: bad }), monthRules, now);
    assert.equal(t.cooldownUntil, now + DEFAULT_COOLDOWN_MS);
  }
});

test("shareOf leaves status alone for server, network and client verdicts", () => {
  for (const name of ["server", "network", "client"] as const) {
    const t = shareOf("active", verdict(name, { status: 500 }), monthRules, Date.UTC(2026, 4, 10));
    assert.equal(t.status, "active");
    assert.equal(t.resetAt, 0);
  }
});

/* ---- error escalation ---- */

test("bumpErrorCount resets on success and ignores client faults", () => {
  assert.equal(bumpErrorCount(4, "ok"), 0);
  assert.equal(bumpErrorCount(4, "client"), 4);
  assert.equal(bumpErrorCount(4, "server"), 5);
  assert.equal(bumpErrorCount(0, "network"), 1);
});

test("escalateStatus retires a key only after MAX_ERRORS repeated failures", () => {
  assert.equal(escalateStatus("active", MAX_ERRORS), "active");
  assert.equal(escalateStatus("active", MAX_ERRORS + 1), "invalid");
  assert.equal(escalateStatus("cooling", MAX_ERRORS + 1), "invalid");
  assert.equal(escalateStatus("exhausted", MAX_ERRORS + 1), "exhausted");
  assert.equal(escalateStatus("invalid", MAX_ERRORS + 1), "invalid");
});

/* ---- credential handling ---- */

test("deriveKeyId is a stable 16 character fingerprint", async () => {
  const id = await deriveKeyId("tvly-secret-value");
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, await deriveKeyId("tvly-secret-value"));
  assert.notEqual(id, await deriveKeyId("tvly-secret-valuE"));
});

test("encryptSecret round-trips and never embeds the plaintext", async () => {
  const key = await deriveCipherKey("unit-test-encryption-key");
  const secret = "tvly-live-abcdefghijklmnop";
  const sealed = await encryptSecret(key, secret);

  const parts = sealed.split(":");
  assert.equal(parts.length, 2);
  assert.ok(!sealed.includes(secret));
  assert.equal(await decryptSecret(key, sealed), secret);
});

test("encryptSecret uses a fresh IV per call", async () => {
  const key = await deriveCipherKey("unit-test-encryption-key");
  const first = await encryptSecret(key, "same-plaintext");
  const second = await encryptSecret(key, "same-plaintext");
  assert.notEqual(first, second);
  assert.notEqual(first.split(":")[0], second.split(":")[0]);
});

test("decryptSecret rejects a mismatched key and a malformed payload", async () => {
  const key = await deriveCipherKey("first-material");
  const other = await deriveCipherKey("second-material");
  const sealed = await encryptSecret(key, "tvly-secret");

  await assert.rejects(() => decryptSecret(other, sealed));
  await assert.rejects(() => decryptSecret(key, "no-separator"));
});

test("deriveCipherKey is deterministic for the same material", async () => {
  const a = await deriveCipherKey("material");
  const b = await deriveCipherKey("material");
  const sealed = await encryptSecret(a, "value");
  assert.equal(await decryptSecret(b, sealed), "value");
});

/* ---- usage probe ---- */

test("buildProbeRequest carries a header credential with its prefix", () => {
  const request = buildProbeRequest(
    { url: "https://api.example.com/usage", style: { type: "header", name: "Authorization", prefix: "Bearer " } },
    "tvly-abc"
  );
  assert.equal(request.url, "https://api.example.com/usage");
  assert.equal(request.headers["Authorization"], "Bearer tvly-abc");
});

test("buildProbeRequest appends a query credential", () => {
  const request = buildProbeRequest(
    { url: "https://api.example.com/usage?x=1", style: { type: "query", name: "api_key" } },
    "tvly abc"
  );
  assert.equal(request.url, "https://api.example.com/usage?x=1&api_key=tvly+abc");
  assert.equal(request.headers["Authorization"], undefined);
});

test("readProbeValues walks dotted paths for used and limit", () => {
  const body = { key: { usage: 42, limit: 1000 } };
  const values = readProbeValues(body, { url: "", style: { type: "query", name: "k" }, usedPath: "key.usage", limitPath: "key.limit" });
  assert.deepEqual(values, { used: 42, limit: 1000 });
});

test("readProbeValues prefers remaining and derives used from it", () => {
  const body = { key: { remaining: 250, limit: 1000, usage: 7 } };
  const values = readProbeValues(body, {
    url: "",
    style: { type: "query", name: "k" },
    usedPath: "key.usage",
    limitPath: "key.limit",
    remainingPath: "key.remaining",
  });
  assert.deepEqual(values, { used: 750, limit: 1000 });
});

test("readProbeValues accepts numeric strings and survives missing paths", () => {
  const numeric = readProbeValues({ used: "12", limit: "40" }, { url: "", style: { type: "query", name: "k" }, usedPath: "used", limitPath: "limit" });
  assert.deepEqual(numeric, { used: 12, limit: 40 });

  const missing = readProbeValues({}, { url: "", style: { type: "query", name: "k" }, usedPath: "a.b", limitPath: "a.c" });
  assert.deepEqual(missing, { used: null, limit: null });
});

test("readProbeValues reports a null used when only remaining is known", () => {
  const values = readProbeValues({ remaining: 5 }, { url: "", style: { type: "query", name: "k" }, remainingPath: "remaining" });
  assert.deepEqual(values, { used: null, limit: null });
});
