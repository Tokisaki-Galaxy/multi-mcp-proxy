/**
 * Per-service API key pool, backed by a SQLite Durable Object.
 *
 * This file holds only the runtime half: the Durable Object class and its
 * storage plumbing. Every decision that can be made without a database lives
 * in `pool-logic.ts`, which is dependency free and unit tested under plain Node.
 *
 * One DO instance per service, named by service id. The DO's single-threaded
 * execution model makes `pick()` atomic: select, rank and reserve happen with
 * no interleaving, so two concurrent requests can never grab the same slot.
 *
 * The plaintext credential never touches storage. `secret` holds
 * base64(iv):base64(ciphertext) from AES-GCM, under a key derived from
 * env.ENCRYPTION_KEY. `listKeys` returns a mask only; `pick` is the single
 * decrypt path.
 */

import { DurableObject } from "cloudflare:workers";
import type { ClassifyResult, KeyRecord, QuotaRules, SelectResult, UsageProbe } from "./types";
import {
  DEFAULT_COOLDOWN_MS,
  MAX_ERRORS,
  MAX_LABEL_LENGTH,
  MIN_WEIGHT,
  PROBE_TIMEOUT_MS,
  SCHEMA_INDEX,
  SCHEMA_TABLE,
  SCHEMA_TASK_INDEX,
  SCHEMA_TASK_TABLE,
  SCHEMA_TOOL_TABLE,
  bumpErrorCount,
  buildProbeRequest,
  compareCandidates,
  decryptSecret,
  deriveCipherKey,
  deriveKeyId,
  encryptSecret,
  escalateStatus,
  isKeyStatus,
  maskKey,
  normaliseWeight,
  readProbeValues,
  shareOf,
  summariseError,
  TOOL_FLAG_MAX,
  toRecord,
  type KeyRow,
  type RankInput,
  type ToolFlag,
} from "./pool-logic";

export interface PoolEnv {
  ENCRYPTION_KEY?: string;
}

export class KeyPool extends DurableObject<PoolEnv> {
  private readonly serviceId: string;
  private schema: Promise<void> | null = null;
  private cipher: Promise<CryptoKey> | null = null;

  constructor(state: DurableObjectState, env: PoolEnv) {
    super(state, env);
    this.serviceId = state.id?.name ?? "";
    // Miniflare leaves `id.name` empty; production sets it from idFromName.
    // The API layer overwrites serviceId anyway, so this is only cosmetic.

    // Constructors cannot await. blockConcurrencyWhile gates every incoming
    // event until the schema lands; the memoised promise also lets a method
    // that slips through create it lazily.
    const boot = this.ctx.blockConcurrencyWhile(() => this.ensureSchema());
    boot.catch(() => {
      // Real failures surface again through the memoised promise in each method.
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): Promise<void> {
    if (!this.schema) {
      this.schema = (async () => {
        this.sql.exec(SCHEMA_TABLE);
        this.sql.exec(SCHEMA_INDEX);
        this.sql.exec(SCHEMA_TASK_TABLE);
        this.sql.exec(SCHEMA_TASK_INDEX);
        this.sql.exec(SCHEMA_TOOL_TABLE);
      })();
    }
    return this.schema;
  }

  private async storageKey(): Promise<CryptoKey> {
    if (!this.cipher) {
      const material = String(this.env.ENCRYPTION_KEY ?? "");
      if (!material) throw new Error("ENCRYPTION_KEY is not configured");
      this.cipher = deriveCipherKey(material);
    }
    return this.cipher;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /* ---------------------------------------------------------------------- */
  /* Public RPC surface.                                                     */
  /* ---------------------------------------------------------------------- */

  async addKeys(
    keys: { secret: string; label?: string }[],
    weight?: number
  ): Promise<{ added: number; skipped: number }> {
    await this.ensureSchema();
    if (!Array.isArray(keys) || keys.length === 0) return { added: 0, skipped: 0 };

    const cipher = await this.storageKey();
    const useWeight = normaliseWeight(weight, MIN_WEIGHT);
    const now = this.now();

    let added = 0;
    let skipped = 0;

    for (const entry of keys) {
      const secret = typeof entry?.secret === "string" ? entry.secret.trim() : "";
      if (secret.length === 0) {
        skipped += 1;
        continue;
      }

      const id = await deriveKeyId(secret);
      const existing = this.sql.exec("SELECT id FROM keys WHERE id = ?", id).toArray();
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      const sealed = await encryptSecret(cipher, secret);
      const label = String(entry.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);

      this.sql.exec(
        `INSERT INTO keys (id, secret, label, weight, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        id,
        sealed,
        label,
        useWeight,
        now
      );
      added += 1;
    }

    return { added, skipped };
  }

  async listKeys(): Promise<KeyRecord[]> {
    await this.ensureSchema();
    const rows = this.sql
      .exec("SELECT * FROM keys ORDER BY created_at ASC, id ASC")
      .toArray() as KeyRow[];

    const out: KeyRecord[] = [];
    for (const row of rows) {
      let mask = "unreadable";
      try {
        const secret = await this.decryptKey(row.secret);
        mask = secret ? maskKey(secret) : "";
      } catch {
        // Leave the placeholder rather than failing the whole listing.
      }
      out.push(toRecord(this.serviceId, row, mask));
    }
    return out;
  }

  private async decryptKey(sealed: string): Promise<string> {
    return decryptSecret(await this.storageKey(), sealed);
  }

  async deleteKeys(ids: string[]): Promise<number> {
    await this.ensureSchema();
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let removed = 0;
    for (const id of ids) {
      const before = this.sql.exec("SELECT COUNT(*) AS n FROM keys WHERE id = ?", String(id)).one() as {
        n: number;
      };
      if (!before || before.n === 0) continue;
      this.sql.exec("DELETE FROM keys WHERE id = ?", String(id));
      removed += 1;
    }
    return removed;
  }

  async patchKey(
    id: string,
    patch: { weight?: number; status?: string; label?: string }
  ): Promise<boolean> {
    await this.ensureSchema();
    const keyId = String(id ?? "");
    if (!keyId) return false;

    const row = this.sql.exec("SELECT * FROM keys WHERE id = ?", keyId).toArray() as KeyRow[];
    if (row.length === 0) return false;

    const current = row[0]!;
    const nextWeight =
      patch?.weight === undefined ? current.weight : normaliseWeight(patch.weight, current.weight);
    const nextLabel =
      patch?.label === undefined
        ? current.label
        : String(patch.label).trim().slice(0, MAX_LABEL_LENGTH);
    const nextStatus = isKeyStatus(patch?.status) ? patch.status : current.status;

    this.sql.exec(
      "UPDATE keys SET weight = ?, status = ?, label = ? WHERE id = ?",
      nextWeight,
      nextStatus,
      nextLabel,
      keyId
    );

    // Reviving a key by hand also clears the parking state, otherwise the next
    // pick would immediately re-park it.
    if (nextStatus === "active" && current.status !== "active") {
      this.sql.exec(
        "UPDATE keys SET cooldown_until = 0, exhausted_at = 0, reset_at = 0 WHERE id = ?",
        keyId
      );
    }

    return true;
  }

  async pick(): Promise<SelectResult | null> {
    await this.ensureSchema();
    const now = this.now();

    // Lazy revive: keys whose quota window has rolled over become usable here,
    // so no cron or alarm is needed on the free plan.
    this.sql.exec(
      `UPDATE keys SET status = 'active', exhausted_at = 0, reset_at = 0
       WHERE status = 'exhausted' AND reset_at > 0 AND reset_at <= ?`,
      now
    );

    const rows = this.sql
      .exec(
        `SELECT * FROM keys
         WHERE status = 'active' AND cooldown_until <= ?
         ORDER BY last_used_at ASC, id ASC`,
        now
      )
      .toArray() as KeyRow[];

    if (rows.length === 0) return null;

    const ranked: RankInput[] = rows.map((row) => ({
      useCount: row.use_count,
      weight: Math.max(MIN_WEIGHT, row.weight),
      lastUsedAt: row.last_used_at,
      id: row.id,
    }));
    ranked.sort(compareCandidates);

    const chosenId = ranked[0]!.id;
    const chosen = rows.find((row) => row.id === chosenId)!;

    this.sql.exec(
      "UPDATE keys SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
      now,
      chosenId
    );

    const secret = await this.decryptKey(chosen.secret);
    return { keyId: chosenId, secret, label: chosen.label };
  }

  /* ---------------------------------------------------------------------- */
  /* Resource affinity                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Which key minted any of these ids, if the proxy still remembers.
   *
   * Returns null when none of the candidates is a known resource id, which is
   * the common case: most requests carry only queries and URLs.
   */
  async lookupAffinity(ids: string[]): Promise<string | null> {
    await this.ensureSchema();
    const candidates = Array.isArray(ids) ? ids.filter((v) => typeof v === "string" && v.length > 0) : [];
    if (candidates.length === 0) return null;

    const now = this.now();
    // One statement per candidate keeps the query shape fixed; the list is small
    // and already capped by collectCandidateIds.
    for (const id of candidates.slice(0, 64)) {
      const row = this.sql
        .exec("SELECT key_id FROM task_affinity WHERE resource_id = ? AND expires_at > ?", id, now)
        .toArray() as { key_id: string }[];
      if (row.length > 0) return row[0]!.key_id;
    }
    return null;
  }

  /**
   * Remember that `keyId` created these ids.
   *
   * Called after a successful tool result. Sweeps expired rows on the way
   * through so the table does not grow without a cron.
   */
  async recordAffinity(ids: string[], keyId: string, ttlSecs: number): Promise<number> {
    await this.ensureSchema();
    const key = String(keyId ?? "");
    if (!key) return 0;

    const list = Array.isArray(ids) ? ids.filter((v) => typeof v === "string" && v.length > 0) : [];
    if (list.length === 0) return 0;

    const now = this.now();
    const ttl = Number.isFinite(ttlSecs) && ttlSecs > 0 ? Math.trunc(ttlSecs) : 86_400;
    const expiresAt = now + ttl;

    this.sql.exec("DELETE FROM task_affinity WHERE expires_at <= ?", now);

    let written = 0;
    for (const id of list.slice(0, 16)) {
      this.sql.exec(
        `INSERT INTO task_affinity (resource_id, key_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(resource_id) DO UPDATE SET key_id = excluded.key_id, expires_at = excluded.expires_at`,
        id,
        key,
        expiresAt
      );
      written += 1;
    }
    return written;
  }

  /**
   * Resolve a pinned key for a request that references an existing resource.
   *
   * The caller must not silently fall back to another key: the resource lives on
   * this account, so a different key would answer 404 and hide the real cause.
   */
  async pickPinned(keyId: string): Promise<
    | { ok: true; key: SelectResult }
    | { ok: false; reason: "missing" | "unusable"; status: string; cooldownUntil: number }
  > {
    await this.ensureSchema();
    const id = String(keyId ?? "");
    const rows = this.sql.exec("SELECT * FROM keys WHERE id = ?", id).toArray() as KeyRow[];
    if (rows.length === 0) {
      return { ok: false, reason: "missing", status: "missing", cooldownUntil: 0 };
    }

    const row = rows[0]!;
    const now = this.now();
    const cooling = row.cooldown_until > now;
    if (row.status !== "active" || cooling) {
      return {
        ok: false,
        reason: "unusable",
        status: cooling ? "cooling" : row.status,
        cooldownUntil: row.cooldown_until,
      };
    }

    this.sql.exec(
      "UPDATE keys SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
      now,
      id
    );

    const secret = await this.decryptKey(row.secret);
    return { ok: true, key: { keyId: id, secret, label: row.label } };
  }

  /** Bindings still live, for the admin panel. */
  async affinityStats(): Promise<{ live: number; expired: number }> {
    await this.ensureSchema();
    const now = this.now();
    const live = this.sql
      .exec("SELECT COUNT(*) AS n FROM task_affinity WHERE expires_at > ?", now)
      .one() as { n: number };
    const expired = this.sql
      .exec("SELECT COUNT(*) AS n FROM task_affinity WHERE expires_at <= ?", now)
      .one() as { n: number };
    return { live: live?.n ?? 0, expired: expired?.n ?? 0 };
  }

  /* ---------------------------------------------------------------------- */
  /* Tool annotations                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Store the annotations published by a `tools/list` response.
   *
   * Rewriting rather than merging matters: a server that removes or downgrades
   * a hint takes effect on the next list. A tool that disappears keeps its stale
   * row and is simply never looked up again.
   */
  async recordToolFlags(flags: ToolFlag[]): Promise<number> {
    await this.ensureSchema();
    if (!Array.isArray(flags) || flags.length === 0) return 0;

    const now = this.now();
    let written = 0;
    for (const flag of flags.slice(0, TOOL_FLAG_MAX)) {
      const name = String(flag?.name ?? "");
      if (!name) continue;
      this.sql.exec(
        `INSERT INTO tool_flags (name, read_only, idempotent, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           read_only = excluded.read_only,
           idempotent = excluded.idempotent,
           seen_at = excluded.seen_at`,
        name,
        flag.readOnly === true ? 1 : 0,
        flag.idempotent === true ? 1 : 0,
        now
      );
      written += 1;
    }
    return written;
  }

  /**
   * Whether repeating a call to this tool cannot double an effect.
   *
   * Unknown tools answer false. The specification defaults both hints to false,
   * so absence is treated exactly like a tool that declared nothing.
   */
  async isToolSafe(name: string): Promise<boolean> {
    await this.ensureSchema();
    const key = String(name ?? "");
    if (!key) return false;

    const rows = this.sql
      .exec("SELECT read_only, idempotent FROM tool_flags WHERE name = ?", key)
      .toArray() as { read_only: number; idempotent: number }[];
    if (rows.length === 0) return false;
    const row = rows[0]!;
    return row.read_only === 1 || row.idempotent === 1;
  }

  async report(keyId: string, result: ClassifyResult, rules: QuotaRules): Promise<void> {
    await this.ensureSchema();
    const id = String(keyId ?? "");
    if (!id) return;

    const rows = this.sql.exec("SELECT * FROM keys WHERE id = ?", id).toArray() as KeyRow[];
    if (rows.length === 0) return;
    const row = rows[0]!;

    // A client error is not the key's fault; leave the row untouched.
    if (result.verdict === "client") return;

    const now = this.now();
    const next = shareOf(row.status, result, rules, now);
    const errorCount = bumpErrorCount(row.error_count, result.verdict);
    const status = escalateStatus(next.status, errorCount);
    const lastError = result.verdict === "ok" ? null : summariseError(result);

    this.sql.exec(
      `UPDATE keys
       SET status = ?, cooldown_until = ?, exhausted_at = ?, reset_at = ?,
           error_count = ?, last_error = ?, last_used_at = ?
       WHERE id = ?`,
      status,
      next.cooldownUntil,
      result.verdict === "exhausted" ? now : 0,
      next.resetAt,
      errorCount,
      lastError,
      now,
      id
    );
  }

  async syncUsage(probe: UsageProbe): Promise<{ synced: number; failed: number }> {
    await this.ensureSchema();
    const rows = this.sql
      .exec("SELECT * FROM keys WHERE status != 'invalid'")
      .toArray() as KeyRow[];

    let synced = 0;
    let failed = 0;

    for (const row of rows) {
      let secret: string;
      try {
        secret = await this.decryptKey(row.secret);
      } catch {
        failed += 1;
        continue;
      }

      try {
        const request = buildProbeRequest(probe, secret);
        const res = await fetch(request.url, {
          headers: request.headers,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) {
          failed += 1;
          continue;
        }
        const body = await res.json();
        const { used, limit } = readProbeValues(body, probe);
        this.sql.exec(
          "UPDATE keys SET quota_used = ?, quota_limit = ?, quota_synced_at = ? WHERE id = ?",
          used,
          limit,
          this.now(),
          row.id
        );
        synced += 1;
      } catch {
        failed += 1;
      }
    }

    return { synced, failed };
  }

  async stats(): Promise<{
    total: number;
    active: number;
    cooling: number;
    exhausted: number;
    invalid: number;
  }> {
    await this.ensureSchema();
    const now = this.now();
    const rows = this.sql.exec("SELECT status, cooldown_until FROM keys").toArray() as {
      status: string;
      cooldown_until: number;
    }[];

    let active = 0;
    let cooling = 0;
    let exhausted = 0;
    let invalid = 0;

    for (const row of rows) {
      if (row.status === "invalid") invalid += 1;
      else if (row.status === "exhausted") exhausted += 1;
      else if (row.cooldown_until > now) cooling += 1;
      else active += 1;
    }

    return { total: rows.length, active, cooling, exhausted, invalid };
  }

  async resetAll(): Promise<number> {
    await this.ensureSchema();
    const before = this.sql.exec("SELECT COUNT(*) AS n FROM keys").one() as { n: number };
    this.sql.exec(
      `UPDATE keys SET status = 'active', cooldown_until = 0, exhausted_at = 0,
       reset_at = 0, error_count = 0, last_error = NULL`
    );
    return before?.n ?? 0;
  }

  /** The Durable Object fetch handler is unused; RPC is the whole interface. */
  async fetch(): Promise<Response> {
    return new Response("Use RPC, not fetch.", { status: 501 });
  }
}

export { MAX_ERRORS, DEFAULT_COOLDOWN_MS };
