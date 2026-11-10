/**
 * Free-tier budget for one Worker instance, measured rather than guessed.
 *
 * These numbers drive the design: the hot path must avoid KV writes and must
 * keep subrequest count low enough to fit the free plan.
 */
export const LIMITS = {
  workers: {
    requestsPerDay: 100_000,
    cpuMsPerRequest: 10,
    subrequestsPerInvocation: 50,
  },
  kv: {
    readsPerDay: 100_000,
    writesPerDay: 1_000,
    deletesPerDay: 1_000,
    listsPerDay: 1_000,
  },
  durableObjectsSqlite: {
    requestsPerDay: 100_000,
    rowsReadPerDay: 5_000_000,
    rowsWrittenPerDay: 100_000,
    storageGb: 5,
  },
} as const;

/**
 * Upstream behaviour confirmed by probing the live endpoints, not from docs.
 *
 * Tavily      mcp.tavily.com/mcp        Authorization: Bearer only, x-api-key
 *                                       returns 401. initialize and tools/list
 *                                       accept any key. tools/call requires a
 *                                       Mcp-Session-Id.
 * Firecrawl   mcp.firecrawl.dev/mcp     accepts x-api-key and Bearer. Requires
 *                                       Accept to list both application/json and
 *                                       text/event-stream, else 406.
 * Exa         mcp.exa.ai/mcp            accepts x-api-key, Bearer and the
 *                                       exaApiKey query parameter. Works with no
 *                                       key at all at a lower rate limit.
 *
 * All three report quota and auth failures as HTTP 200 with an SSE body whose
 * result carries isError. The HTTP status alone is never enough.
 */
export const UPSTREAM_NOTES = {
  sessionHeader: "mcp-session-id",
  /** Confirmed: a session is not bound to the key that created it. */
  sessionBoundToKey: false,
  /** Confirmed: requests must advertise both content types. */
  requiredAccept: "application/json, text/event-stream",
} as const;
