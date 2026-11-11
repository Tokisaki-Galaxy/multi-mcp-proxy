/**
 * Reading an SSE response far enough to judge it.
 *
 * A stream may carry one-way messages before the outcome. Anything that stops at
 * the first event sees a progress notification, which has neither a result nor an
 * error, and mistakes it for a healthy call. These helpers decide which event
 * actually ends the request.
 *
 * Framing follows the SSE specification, because an upstream is free to use any
 * of it: lines end in CRLF, CR or LF, an event ends at a blank line, several
 * `data:` lines in one event are joined with a newline into a single payload, and
 * a payload is only complete once that blank line arrives.
 *
 * No runtime dependencies, so this module is also unit tested under plain Node.
 */

/** Parsed `data:` payloads, plus the offset where the unfinished event starts. */
interface EventScan {
  payloads: unknown[];
  next: number;
}

/**
 * Walk the events in `text` from `from` onward.
 *
 * `from` must sit on an event boundary. `next` is where the next call should
 * resume: the start of the event that was still arriving, so a payload split
 * across chunks is re-read rather than lost.
 */
function scanEvents(text: string, from: number, closedOnly: boolean): EventScan {
  const payloads: unknown[] = [];
  let data: string[] = [];
  let hasData = false;
  let cursor = from;
  let eventStart = from;

  const flush = () => {
    if (!hasData) return;
    hasData = false;
    const json = data.join("\n").trim();
    data = [];
    if (json === "") return;
    try {
      payloads.push(JSON.parse(json));
    } catch {
      // Not JSON, or not all of it yet. Either way it decides nothing.
    }
  };

  while (cursor < text.length) {
    let end = cursor;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
    // The last line is still arriving; leave it for the next chunk.
    if (end === text.length) break;
    const line = text.slice(cursor, end);
    // CRLF is one line ending, not two.
    cursor = text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1;
    if (line === "") {
      flush();
      eventStart = cursor;
      continue;
    }
    // A comment line, the usual keep-alive.
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
    hasData = true;
  }

  // A payload whose event has not been closed may still grow, so it only counts
  // when the caller is reading the buffer for classification rather than for the
  // end of the request.
  if (!closedOnly) flush();
  return { payloads, next: eventStart };
}

/** Pull the JSON-RPC objects out of the `data:` lines of an SSE body. */
export function ssePayloads(text: string): unknown[] {
  return scanEvents(text, 0, false).payloads;
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
  return conclusionProbe().feed(text);
}

/** Incremental form of {@link hasConclusion}, for a stream that arrives in chunks. */
export interface ConclusionProbe {
  /** Feed the whole buffer read so far; true once a closed event concludes. */
  feed(text: string): boolean;
}

/**
 * Build a probe that remembers how far it has read.
 *
 * Re-scanning the whole buffer on every chunk would compare every byte against
 * every other one, which a tool emitting notifications for a long time can turn
 * into real CPU work inside a Worker. The probe picks up where the last call
 * stopped instead, so the whole peek costs one pass over the bytes.
 */
export function conclusionProbe(): ConclusionProbe {
  let from = 0;
  return {
    feed(text: string): boolean {
      const { payloads, next } = scanEvents(text, from, true);
      from = next;
      return payloads.some(isConclusion);
    },
  };
}
