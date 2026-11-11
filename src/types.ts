/**
 * Shared types for the multi-service MCP proxy.
 *
 * The proxy is transparent on the wire: it forwards the client's MCP JSON-RPC
 * bytes untouched and only replaces the upstream credential header. Everything
 * here exists to support key selection and failure classification.
 */

/** How the upstream expects its credential to arrive. */
export type AuthStyle =
  | { type: "header"; name: string; prefix?: string }
  | { type: "query"; name: string };

/** Rules that turn an upstream response into a key-pool decision. */
export interface QuotaRules {
  /** Statuses that mean this key is out of credits for the current window. */
  exhaustedStatuses: number[];
  /** Statuses that mean back off for a while, then retry this key later. */
  cooldownStatuses: number[];
  /** Statuses that mean the key itself is dead. */
  invalidStatuses: number[];
  /** When an exhausted key becomes usable again. */
  reset: "month" | "day" | "manual";
  /** Day of month for monthly resets, defaults to 1. */
  resetDay?: number;
}

/** Optional endpoint used to sync real remaining quota for the admin panel. */
export interface UsageProbe {
  url: string;
  style: AuthStyle;
  /** Dotted path into the JSON response, e.g. "key.usage". */
  usedPath?: string;
  /** Dotted path to the limit, e.g. "key.limit". */
  limitPath?: string;
  /** Second place to look when limitPath is absent or null. */
  limitFallbackPath?: string;
  /** Dotted path to remaining, takes precedence over used/limit. */
  remainingPath?: string;
}

/**
 * Optional resource affinity. Some upstream tools create a job or session that
 * only the account which created it can read back. Rotating the key between the
 * create call and the follow-up call makes that task disappear.
 *
 * With this enabled the pool remembers which key created which id and pins every
 * later request that mentions the id to that key.
 */
export interface AffinityRules {
  /**
   * Field names in a tool result whose string values identify a resource,
   * for example `id`, `scrapeId`, `uploadRef`.
   */
  responseFields: string[];
  /** How long a binding stays valid, in seconds. */
  ttlSecs: number;
}

export interface ServiceConfig {
  /** Path segment, also the Durable Object name. Lowercase, no slashes. */
  id: string;
  name: string;
  enabled: boolean;
  /** Full upstream MCP endpoint, e.g. https://mcp.exa.ai/mcp */
  upstreamUrl: string;
  auth: AuthStyle;
  quota: QuotaRules;
  usage?: UsageProbe;
  /** Resource-to-key binding. Omit to keep plain stateless rotation. */
  affinity?: AffinityRules;
  /** Retry upstream 5xx once with another key. Off by default: risk of double charge. */
  retryOn5xx: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What the classifier concluded about one upstream response. */
export type Verdict =
  | "ok"
  /** Key is out of credits for this window. */
  | "exhausted"
  /** Key rejected by upstream, treat as dead. */
  | "invalid"
  /** Rate limited, cool down then reuse. */
  | "cooldown"
  /** Upstream server fault. Only retry when the service opts in. */
  | "server"
  /** Request itself was wrong, never retry, never blame the key. */
  | "client"
  /** Transport failure, ambiguous whether the upstream acted. */
  | "network";

export interface ClassifyResult {
  verdict: Verdict;
  /** HTTP status that drove the verdict, when known. */
  status?: number;
  /** Upstream error tag, e.g. NO_MORE_CREDITS. */
  code?: string;
  /** Human readable, already safe to show in admin logs. */
  message: string;
  /** Milliseconds to wait before this key is usable again. */
  retryAfterMs?: number;
  /**
   * True when the failure arrived at the transport layer, so the tool never
   * started: a configured 4xx on the status line, or a 5xx on a service that
   * opted into `retryOn5xx`. A failure carried inside an HTTP 200 body always
   * leaves this false, because the tool may already have run.
   */
  requestNotProcessed: boolean;
}

export interface KeyRecord {
  id: string;
  serviceId: string;
  label: string;
  /** Encrypted at rest, never returned by the list API in plaintext. */
  mask: string;
  weight: number;
  status: "active" | "cooling" | "exhausted" | "invalid";
  cooldownUntil: number;
  exhaustedAt: number;
  resetAt: number;
  lastUsedAt: number;
  useCount: number;
  errorCount: number;
  lastError: string | null;
  quotaUsed: number | null;
  quotaLimit: number | null;
  quotaSyncedAt: number;
  createdAt: number;
}

export interface SelectResult {
  keyId: string;
  secret: string;
  label: string;
}

export interface PoolEnv {
  KEY_POOL: DurableObjectNamespace;
  REGISTRY: KVNamespace;
  PROXY_KEY?: string;
  ENCRYPTION_KEY?: string;
}
