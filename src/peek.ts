/**
 * Reading an SSE response far enough to judge it.
 *
 * A stream may carry one-way messages before the outcome. Anything that stops at
 * the first event sees a progress notification, which has neither a result nor an
 * error, and mistakes it for a healthy call. These helpers decide which event
 * actually ends the request.
 *
 * No runtime dependencies, so this module is also unit tested under plain Node.
 */

/** Pull the JSON-RPC objects out of the `data:` lines of an SSE body. */
export function ssePayloads(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice(5).trim();
    if (!json) continue;
    try {
      out.push(JSON.parse(json));
    } catch {
      // Partial or non-JSON event, ignore.
    }
  }
  return out;
}

/**
 * True when this parsed JSON-RPC object concludes the request.
 *
 * A one-way message such as `notifications/progress` carries neither a `result`
 * nor an `error`, and says nothing about how the call will end. The 2026
 * revision adds `resultType: "input_required"`, which is still a result and so
 * already a conclusion; the client answers it with a follow-up request.
 */
export function isConclusion(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.result !== undefined && record.result !== null) return true;
  // Matches the error test in classifyMcpResult: an explicit empty carrier is
  // not a failure, and treating it as one would stop the peek too early.
  const error = record.error;
  return error !== undefined && error !== null && error !== false && error !== "";
}

/**
 * True when the peeked text already holds a complete event that concludes the
 * request.
 *
 * Partial JSON is harmless: it fails to parse and the caller reads more bytes.
 */
export function hasConclusion(text: string): boolean {
  if (!text.includes("\n\n")) return false;
  for (const payload of ssePayloads(text)) {
    if (isConclusion(payload)) return true;
  }
  return false;
}
