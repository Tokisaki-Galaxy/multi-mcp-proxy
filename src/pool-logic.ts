/**
 * Pure decision logic for the per-service key pool.
 *
 * Nothing here touches a Durable Object, SQLite, WebCrypto or the network, so
 * the whole file runs and is unit tested under plain Node. The runtime half
 * lives in `pool.ts`.
 *
 * Rules encoded below: how a key is ranked against its peers, when an
 * exhausted key becomes usable again, how one upstream verdict moves a key
 * between states, and how a usage probe response is read.
 */

import type { ClassifyResult, KeyRecord, QuotaRules, SelectResult, UsageProbe, Verdict } from "./types";

/** Consecutive failures after which a key is retired without upstream proof. */
export const MAX_ERRORS = 5;
/** Backoff used when the upstream rate limit gives no Retry-After. */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** Lowest weight meaningfully different from the implicit default. */
export const MIN_WEIGHT = 1;

const MASK_HEAD = 6;
const MASK_TAIL = 4;
const SHORT_KEY_MAX = 10;
export const MAX_LABEL_LENGTH = 200;
const MAX_ERROR_LENGTH = 300;
export const PROBE_TIMEOUT_MS = 8_000;

/* -------------------------------------------------------------------------- */
/* Pure logic. Everything below this banner is runtime-free and unit tested.   */
/* -------------------------------------------------------------------------- */

/** Statuses a key can hold in storage, mirroring KeyRecord["status"]. */
const STATUS_VALUES = ["active", "cooling", "exhausted", "invalid"] as const;
export type KeyStatus = (typeof STATUS_VALUES)[number];

/** Shape returned by the state machine for one report. */
export interface StateTransition {
  status: string;
  /** 0 when no cooldown applies or an existing cooldown should be cleared. */
  cooldownUntil: number;
  /** 0 when the key is not waiting on a quota window. */
  resetAt: number;
}

function clampInteger(value: number, min: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function daysInMonthUtc(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Human safe preview of a credential: `tvly-a...9xyz` style.
 *
 * Short keys would be mostly revealed by a head+tail slice, so they degrade to
 * the first four characters plus an ellipsis.
 */
export function maskKey(secret: string): string {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (value.length === 0) return "";

  // Short keys would collapse to the same mask if only the head were shown,
  // which makes two different keys look identical in the panel. Keep a tail
  // for anything long enough to have one.
  if (value.length <= SHORT_KEY_MAX) {
    return value.length <= 6 ? `${value.slice(0, 2)}...` : `${value.slice(0, 4)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, MASK_HEAD)}...${value.slice(-MASK_TAIL)}`;
}

/**
 * Load ratio used to schedule keys: how many uses this key has carried per
 * unit of weight. Comparing (uses + 1) / weight means a higher weight reaches
 * the same ratio only after proportionally more traffic, so the pool spreads
 * load in proportion to weight instead of pinning one key.
 *
 * The +1 keeps unused keys from scoring exactly zero, which would otherwise
 * make every fresh key collide at the same rank.
 */
export function rankScore(useCount: number, weight: number): number {
  const uses = Number.isFinite(useCount) && useCount > 0 ? Math.trunc(useCount) : 0;
  const w = Number.isFinite(weight) && weight >= MIN_WEIGHT ? Math.trunc(weight) : MIN_WEIGHT;
  return (uses + 1) / w;
}

export interface RankInput {
  useCount: number;
  weight: number;
  lastUsedAt: number;
  id: string;
}

/** Ascending: lowest load ratio first, then least recently used, then id. */
export function compareCandidates(a: RankInput, b: RankInput): number {
  const delta = rankScore(a.useCount, a.weight) - rankScore(b.useCount, b.weight);
  if (delta !== 0) return delta;
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * When an exhausted key becomes usable again.
 *
 * `day` rolls to the next UTC midnight. `month` targets `resetDay` at 00:00 UTC,
 * using this month's date when it is still ahead and next month's otherwise.
 * `manual` returns 0, the sentinel for "never recovers on its own", which also
 * keeps the lazy revive in `pick` from touching it.
 */
export function computeResetAt(rules: QuotaRules, now: number): number {
  if (!rules || rules.reset === "manual") return 0;

  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();

  if (rules.reset === "day") {
    return Date.UTC(year, month, at.getUTCDate() + 1, 0, 0, 0, 0);
  }

  const wanted = clampInteger(rules.resetDay ?? 1, 1, 31);
  const thisMonth = Date.UTC(year, month, Math.min(wanted, daysInMonthUtc(year, month)), 0, 0, 0, 0);
  if (thisMonth > now) return thisMonth;

  return Date.UTC(year, month + 1, Math.min(wanted, daysInMonthUtc(year, month + 1)), 0, 0, 0, 0);
}

/** Retry-After wins when present, otherwise the pool's default backoff. */
export function normaliseRetryAfter(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || retryAfterMs === null) return DEFAULT_COOLDOWN_MS;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.trunc(retryAfterMs);
}

/**
 * Report state machine. The first argument is the key's current status; the
 * result describes the state it should hold after this verdict.
 *
 * Cooldown keeps `active` because the key is healthy, only temporarily limited:
 * `pick` filters on cooldown_until, so a separate status would just duplicate
 * that gate. `client` and transport/server faults never change status here;
 * escalation lives in `escalateStatus` because it needs the error counter.
 */
export function shareOf(
  currentStatus: string,
  result: ClassifyResult,
  rules: QuotaRules,
  now: number
): StateTransition {
  const verdict = result?.verdict;

  switch (verdict) {
    case "ok":
      return { status: "active", cooldownUntil: 0, resetAt: 0 };
    case "invalid":
      return { status: "invalid", cooldownUntil: 0, resetAt: 0 };
    case "exhausted":
      return { status: "exhausted", cooldownUntil: 0, resetAt: computeResetAt(rules, now) };
    case "cooldown":
      // The classifier reports milliseconds; cooldown_until is unix seconds.
      return {
        status: "active",
        cooldownUntil: now + Math.ceil(normaliseRetryAfter(result.retryAfterMs) / 1000),
        resetAt: 0,
      };
    case "server":
    case "network":
    case "client":
    default:
      return { status: currentStatus, cooldownUntil: 0, resetAt: 0 };
  }
}

/** Counters only move for verdicts that can be blamed on the key. */
export function bumpErrorCount(current: number, verdict: Verdict): number {
  const base = Number.isFinite(current) && current > 0 ? Math.trunc(current) : 0;
  if (verdict === "ok") return 0;
  if (verdict === "client") return base;
  return base + 1;
}

/**
 * Repeated transient failures quietly kill a key. Only statuses that the pool
 * still considers usable are escalated: an exhausted key is already parked
 * until its window resets, and an invalid key needs no further evidence.
 */
export function escalateStatus(status: string, errorCount: number): string {
  if (status !== "active" && status !== "cooling") return status;
  return errorCount > MAX_ERRORS ? "invalid" : status;
}

/** Accepts a numeric string because some quota endpoints return strings. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readPath(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const part of path.split(".")) {
    if (part === "") continue;
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Request shape for a usage probe, split out so the auth styles stay testable. */
export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
}

export function buildProbeRequest(probe: UsageProbe, secret: string): ProbeRequest {
  const headers: Record<string, string> = { accept: "application/json" };

  if (probe.style.type === "header") {
    headers[probe.style.name] = `${probe.style.prefix ?? ""}${secret}`;
    return { url: probe.url, headers };
  }

  const url = new URL(probe.url);
  url.searchParams.set(probe.style.name, secret);
  return { url: url.toString(), headers };
}

/**
 * Pulls used/limit out of a probe response. `remainingPath` wins over the
 * used/limit pair, and used is reconstructed from limit - remaining when only
 * the remainder is reported.
 */
export function readProbeValues(body: unknown, probe: UsageProbe): { used: number | null; limit: number | null } {
  // The limit sometimes sits in a different field depending on the plan, so a
  // second path is tried before giving up.
  let limit = probe.limitPath ? asNumber(readPath(body, probe.limitPath)) : null;
  if (limit === null && probe.limitFallbackPath) {
    limit = asNumber(readPath(body, probe.limitFallbackPath));
  }

  if (probe.remainingPath) {
    const remaining = asNumber(readPath(body, probe.remainingPath));
    if (remaining === null) return { used: null, limit };
    return { used: limit === null ? null : Math.max(0, limit - remaining), limit };
  }

  const used = probe.usedPath ? asNumber(readPath(body, probe.usedPath)) : null;
  return { used, limit };
}

/** Identifier of a credential: truncated SHA-256, so re-adding the same key dedupes. */
export async function deriveKeyId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toHex(new Uint8Array(digest)).slice(0, 16);
}

/** AES-GCM key derived from the configured secret material. */
export async function deriveCipherKey(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(key: CryptoKey, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  return `${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(key: CryptoKey, sealed: string): Promise<string> {
  const split = sealed.indexOf(":");
  if (split <= 0) throw new Error("malformed ciphertext");
  const iv = fromBase64(sealed.slice(0, split));
  const ciphertext = fromBase64(sealed.slice(split + 1));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Resource affinity.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Bounds on what counts as a possible resource id.
 *
 * Ids are opaque tokens: UUIDs, or upstream prefixed forms such as `fc1.xxx`.
 * They never contain whitespace and are never a whole sentence. Filtering on that
 * keeps a search query or a long instruction from being treated as an id.
 */
export const AFFINITY_MIN_ID_LENGTH = 8;
export const AFFINITY_MAX_ID_LENGTH = 128;
/** Cap on candidates pulled out of one request, so a huge argument cannot bloat the lookup. */
export const AFFINITY_MAX_CANDIDATES = 64;
/** How deep to walk an argument tree looking for ids. */
export const AFFINITY_MAX_DEPTH = 4;

function looksLikeResourceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < AFFINITY_MIN_ID_LENGTH || value.length > AFFINITY_MAX_ID_LENGTH) return false;
  return !/\s/.test(value);
}

/**
 * Collect string values from a request argument tree that could be resource ids.
 *
 * This does not consult the ledger; it only narrows the input. The final say
 * belongs to the lookup, which matches against ids the proxy actually minted.
 */
export function collectCandidateIds(args: unknown, limit = AFFINITY_MAX_CANDIDATES): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown, depth: number): void => {
    if (found.length >= limit || depth > AFFINITY_MAX_DEPTH) return;

    if (looksLikeResourceId(value)) {
      if (!seen.has(value)) {
        seen.add(value);
        found.push(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (found.length >= limit) return;
        walk(item, depth + 1);
      }
      return;
    }

    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (found.length >= limit) return;
        walk(item, depth + 1);
      }
    }
  };

  walk(args, 0);
  return found;
}

/**
 * Pull resource ids out of an MCP tool result.
 *
 * Only the declared field names are read, and only at the top level of each
 * result object. Searching deeper would pick up ids belonging to unrelated rows,
 * such as every hit in a search response, which would then pin future requests to
 * keys that never created them.
 */
export function collectResultIds(payload: unknown, fields: string[]): string[] {
  if (!payload || typeof payload !== "object" || fields.length === 0) return [];
  const envelope = payload as Record<string, unknown>;
  const inner = envelope.result;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return [];

  const result = inner as Record<string, unknown>;
  const objects: unknown[] = [result.structuredContent];

  const blocks = Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const text = record.text.trim();
    if (!text.startsWith("{")) continue;
    try {
      objects.push(JSON.parse(text));
    } catch {
      // Prose output, not a resource envelope.
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const record = object as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (!looksLikeResourceId(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Storage plumbing.                                                           */
/* -------------------------------------------------------------------------- */

/** Type alias, not an interface: the SQLite cursor generic needs an index signature. */
export type KeyRow = {
  id: string;
  secret: string;
  label: string;
  weight: number;
  status: string;
  cooldown_until: number;
  exhausted_at: number;
  reset_at: number;
  last_used_at: number;
  use_count: number;
  error_count: number;
  last_error: string | null;
  quota_used: number | null;
  quota_limit: number | null;
  quota_synced_at: number;
  created_at: number;
};

export const SCHEMA_TABLE = `
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  exhausted_at INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  quota_used INTEGER,
  quota_limit INTEGER,
  quota_synced_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`;

export const SCHEMA_INDEX = "CREATE INDEX IF NOT EXISTS keys_status_idx ON keys (status)";

/**
 * Which key minted a given upstream resource id.
 *
 * Rows are disposable: once `expires_at` passes the id is no longer worth
 * pinning, so the table is swept lazily on write rather than by a cron.
 */
export const SCHEMA_TASK_TABLE = `
CREATE TABLE IF NOT EXISTS task_affinity (
  resource_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;

export const SCHEMA_TASK_INDEX = "CREATE INDEX IF NOT EXISTS task_expiry_idx ON task_affinity (expires_at)";

export function normaliseWeight(weight: number | undefined, fallback: number): number {
  if (weight === undefined || weight === null || !Number.isFinite(weight)) return fallback;
  const value = Math.trunc(weight);
  return value >= MIN_WEIGHT ? value : fallback;
}

export function isKeyStatus(value: unknown): value is KeyStatus {
  return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value);
}

export function summariseError(result: ClassifyResult): string {
  const code = result?.code ? `${result.code}: ` : "";
  const message = typeof result?.message === "string" ? result.message : "";
  return `${code}${message}`.slice(0, MAX_ERROR_LENGTH);
}

export function toRecord(serviceId: string, row: KeyRow, mask: string): KeyRecord {
  return {
    id: row.id,
    serviceId,
    label: row.label,
    mask,
    weight: row.weight,
    status: row.status as KeyRecord["status"],
    cooldownUntil: row.cooldown_until,
    exhaustedAt: row.exhausted_at,
    resetAt: row.reset_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    errorCount: row.error_count,
    lastError: row.last_error,
    quotaUsed: row.quota_used,
    quotaLimit: row.quota_limit,
    quotaSyncedAt: row.quota_synced_at,
    createdAt: row.created_at,
  };
}

