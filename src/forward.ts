/**
 * Transparent forwarding with per-request key selection.
 *
 * The proxy never rewrites the MCP payload. It replaces only the credential
 * header, forwards the client's headers and body verbatim, and decides whether
 * to replay based on what the upstream answered.
 *
 * Why a first-event peek instead of pure pass-through: all three target
 * upstreams (Tavily, Firecrawl, Exa) put quota and auth failures inside an
 * HTTP 200 body, as `result.isError` or an embedded error string. A header-only
 * proxy cannot see them, so it would pin every request to a dead key forever.
 * Reading until the first complete SSE event costs about one round trip that
 * the client would have waited for anyway, and lets the rest of the stream flow
 * untouched.
 */

import type { ClassifyResult, QuotaRules, SelectResult, ServiceConfig } from "./types";
import { classifyHttp, classifyMcpResult } from "./classify";
import { collectCandidateIds, collectResultIds } from "./pool-logic";

/** Abort the upstream header phase after this long. */
const HEADER_TIMEOUT_MS = 120_000;
/** Give up peeking after this many bytes and just stream. */
const PEEK_BYTE_CAP = 64 * 1024;
/** Give up peeking after this long and just stream. */
const PEEK_TIME_CAP_MS = 15_000;
/** Cap for the JSON path, which must read the whole object to parse it. */
const JSON_BYTE_CAP = 8 * 1024 * 1024;
/** Hard ceiling on key attempts per client request. */
const MAX_ATTEMPTS = 3;

/** Headers that must not be copied in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-proxy-key",
]);

export interface PoolHandle {
  pick(): Promise<SelectResult | null>;
  report(keyId: string, result: ClassifyResult, rules: QuotaRules): Promise<void>;
  /** Which key minted any of these ids, or null when none is known. */
  lookupAffinity?(ids: string[]): Promise<string | null>;
  /** Remember that a key minted these ids. */
  recordAffinity?(ids: string[], keyId: string, ttlSecs: number): Promise<number>;
  /** Resolve a pinned key, reporting why it cannot serve when it cannot. */
  pickPinned?(keyId: string): Promise<
    | { ok: true; key: SelectResult }
    | { ok: false; reason: "missing" | "unusable"; status: string; cooldownUntil: number }
  >;
}

export interface ForwardOutcome {
  response: Response;
  keyId: string | null;
  attempts: number;
  verdicts: ClassifyResult[];
  /** True when the key was chosen by a resource binding rather than rotation. */
  pinned?: boolean;
}

function upstreamHeaders(
  incoming: Headers,
  service: ServiceConfig,
  secret: string
): Headers {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });

  // Never let a client-supplied upstream credential through.
  headers.delete("authorization");
  headers.delete("x-api-key");

  // Some clients omit text/event-stream and get a hard 406 from the upstream.
  // Every MCP client is required to handle both encodings, so widening the
  // advertisement is safe and fixes those clients in one place.
  const accept = headers.get("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    headers.set(
      "accept",
      accept ? `${accept}, text/event-stream` : "application/json, text/event-stream"
    );
  }

  if (service.auth.type === "header") {
    headers.set(service.auth.name, `${service.auth.prefix ?? ""}${secret}`);
  }

  return headers;
}

function upstreamUrl(service: ServiceConfig, secret: string): string {
  const url = new URL(service.upstreamUrl);
  if (service.auth.type === "query") url.searchParams.set(service.auth.name, secret);
  return url.toString();
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });
  // The Workers runtime hands back a decoded body, so a forwarded
  // content-encoding or stale content-length would corrupt the response.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return headers;
}

interface PeekResult {
  /** Bytes already pulled from the upstream, to replay before the rest. */
  buffered: Uint8Array[];
  /** Decoded prefix, for classification. */
  text: string;
  /** True when a whole SSE event was captured. */
  complete: boolean;
}

/**
 * Read just enough of the upstream body to judge it.
 *
 * SSE: stop at the first complete event. A synchronous tool answers with a
 * single event, so this is normally the whole response.
 * JSON: read to the end, because a truncated object cannot be parsed. These
 * responses are single MCP results and are small in practice.
 */
async function peekFirstEvent(
  body: ReadableStream<Uint8Array>,
  contentType: string
): Promise<{ peek: PeekResult; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  const isJson = contentType.includes("application/json");
  let text = "";
  let bytes = 0;
  const startedAt = Date.now();

  const byteCap = isJson ? JSON_BYTE_CAP : PEEK_BYTE_CAP;

  while (bytes < byteCap) {
    if (!isJson && Date.now() - startedAt > PEEK_TIME_CAP_MS) break;
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffered.push(value);
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (!isJson && text.includes("\n\n")) {
      return { peek: { buffered, text, complete: true }, reader };
    }
  }

  return { peek: { buffered, text, complete: false }, reader };
}

/** Splice already-read bytes back in front of the remaining upstream stream. */
function replayThenStream(
  buffered: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Pull the JSON-RPC object out of an SSE `data:` line. */
function ssePayloads(text: string): unknown[] {
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
 * Pull the parsed JSON-RPC objects out of a peeked response body.
 *
 * Shared by failure classification and by affinity extraction so the body is
 * only ever parsed once.
 */
function payloadsOf(contentType: string, text: string): unknown[] {
  if (contentType.includes("text/event-stream")) return ssePayloads(text);
  if (contentType.includes("application/json")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Decide whether a peeked upstream response should cause a different key to be
 * tried. Returns null when the response is fine and should be passed through.
 */
function judgePeek(
  service: ServiceConfig,
  contentType: string,
  text: string
): ClassifyResult | null {
  for (const payload of payloadsOf(contentType, text)) {
    const verdict = classifyMcpResult(payload, service.quota);
    if (verdict) return verdict;
  }
  return null;
}

/** Minimal view of the inbound request needed for affinity. */
interface RequestInfo {
  /** JSON-RPC id, echoed on proxy-generated errors. */
  jsonrpcId: unknown;
  /** `params.arguments` for a tool call; undefined for everything else. */
  args: unknown;
}

function readRequestInfo(raw: ArrayBuffer | null): RequestInfo {
  if (!raw || raw.byteLength === 0) return { jsonrpcId: null, args: undefined };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { jsonrpcId: null, args: undefined };
    }
    const record = parsed as Record<string, unknown>;
    const params = record.params;
    const args =
      params && typeof params === "object" ? (params as Record<string, unknown>).arguments : undefined;
    return { jsonrpcId: record.id ?? null, args };
  } catch {
    return { jsonrpcId: null, args: undefined };
  }
}

/**
 * Error returned when a request references a resource whose owning key can no
 * longer serve it.
 *
 * A JSON-RPC error at HTTP 200 is deliberate: clients surface it as a tool
 * failure with our message intact, whereas an HTTP error status gets flattened
 * into "request failed with status N" and the reason is lost.
 */
function affinityError(jsonrpcId: unknown, message: string, reason: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: jsonrpcId,
      error: {
        code: -32001,
        message,
        data: { reason, retryable: reason === "cooling" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function shouldReplay(verdict: ClassifyResult, retryOn5xx: boolean): boolean {
  if (verdict.verdict === "invalid" || verdict.verdict === "exhausted") return true;
  if (verdict.verdict === "cooldown") return true;
  if (verdict.verdict === "server") return retryOn5xx && verdict.requestNotProcessed;
  return false;
}

/**
 * Forward one MCP request to the upstream, rotating keys when the upstream
 * reports that the current key is unusable.
 *
 * Two selection paths exist. A request that mentions a resource id the proxy
 * has already seen is pinned to the key that created that resource, because the
 * upstream keeps the resource on that account. Everything else rotates.
 */
export async function forwardMCP(
  request: Request,
  service: ServiceConfig,
  pool: PoolHandle
): Promise<ForwardOutcome> {
  // The body must be replayable. MCP requests are small JSON documents, so
  // buffering is cheaper and safer than trying to tee a stream.
  const body = request.method === "GET" || request.method === "DELETE" ? null : await request.arrayBuffer();
  const info = readRequestInfo(body);
  const affinity = service.affinity;

  // Resolve a binding before anything is sent. Only ids the proxy minted itself
  // can match, so a search query that happens to look like an id is ignored.
  let pinnedKeyId: string | null = null;
  if (affinity && pool.lookupAffinity) {
    const candidates = collectCandidateIds(info.args);
    if (candidates.length > 0) pinnedKeyId = await pool.lookupAffinity(candidates);
  }

  const verdicts: ClassifyResult[] = [];
  let lastResponse: Response | null = null;
  let lastKeyId: string | null = null;
  let attempts = 0;

  // A pinned request gets exactly one attempt: another key would not know the
  // resource, so retrying would only turn a clear failure into a 404.
  const maxAttempts = pinnedKeyId
    ? 1
    : request.method === "GET" || request.method === "DELETE"
      ? 1
      : MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let picked: SelectResult | null = null;

    if (pinnedKeyId) {
      const resolved = pool.pickPinned
        ? await pool.pickPinned(pinnedKeyId)
        : { ok: false as const, reason: "missing" as const, status: "missing", cooldownUntil: 0 };
      if (!resolved.ok) {
        const message =
          resolved.reason === "missing"
            ? "The key that created this resource is no longer in the pool. The resource cannot be reached; start a new task."
            : resolved.status === "cooling"
              ? "The key that created this resource is rate limited right now. Retry when the cooldown ends; the resource is still there."
              : `The key that created this resource is ${resolved.status}. The resource cannot be reached; start a new task.`;
        return {
          response: affinityError(info.jsonrpcId, message, resolved.reason === "missing" ? "missing" : resolved.status),
          keyId: pinnedKeyId,
          attempts,
          verdicts,
          pinned: true,
        };
      }
      picked = resolved.key;
    } else {
      picked = await pool.pick();
    }

    if (!picked) {
      if (lastResponse) break;
      return {
        response: new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: info.jsonrpcId,
            error: { code: -32603, message: "No available API key for this service." },
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        ),
        keyId: null,
        attempts,
        verdicts,
      };
    }

    attempts++;
    lastKeyId = picked.keyId;

    const headers = upstreamHeaders(request.headers, service, picked.secret);

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl(service, picked.secret), {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(HEADER_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      // Transport failure. We cannot know whether the upstream acted, so this
      // is never replayed.
      const message = err instanceof Error ? err.message : String(err);
      verdicts.push({
        verdict: "network",
        message,
        requestNotProcessed: false,
      });
      await pool.report(picked.keyId, { verdict: "network", message, requestNotProcessed: false }, service.quota);
      return {
        response: new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: info.jsonrpcId,
            error: { code: -32603, message: `Upstream unreachable: ${message}` },
          }),
          { status: 502, headers: { "content-type": "application/json" } }
        ),
        keyId: picked.keyId,
        attempts,
        verdicts,
        pinned: pinnedKeyId !== null,
      };
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    // Non-2xx: classify from status plus a bounded read of the error body.
    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "");
      const verdict = classifyHttp(
        upstream.status,
        upstream.headers,
        errorText,
        service.quota,
        service.retryOn5xx
      );
      verdicts.push(verdict);
      await pool.report(picked.keyId, verdict, service.quota);
      lastResponse = new Response(errorText, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      });
      if (!pinnedKeyId && shouldReplay(verdict, service.retryOn5xx)) continue;
      return { response: lastResponse, keyId: picked.keyId, attempts, verdicts, pinned: pinnedKeyId !== null };
    }

    // GET and DELETE carry no JSON-RPC result to judge.
    if (!upstream.body || request.method !== "POST") {
      lastResponse = new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      });
      return { response: lastResponse, keyId: picked.keyId, attempts, verdicts, pinned: pinnedKeyId !== null };
    }

    const { peek, reader } = await peekFirstEvent(upstream.body, contentType);
    const verdict = judgePeek(service, contentType, peek.text);

    if (verdict && !pinnedKeyId && shouldReplay(verdict, service.retryOn5xx)) {
      verdicts.push(verdict);
      await pool.report(picked.keyId, verdict, service.quota);
      await reader.cancel().catch(() => undefined);
      lastResponse = new Response(peek.text, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      });
      continue;
    }

    if (verdict) {
      // A real but non-retryable failure (client error), or any failure on a
      // pinned key. Record it so the panel shows what happened, then hand it to
      // the client unchanged.
      verdicts.push(verdict);
      await pool.report(picked.keyId, verdict, service.quota);
    } else {
      await pool.report(
        picked.keyId,
        { verdict: "ok", message: "", requestNotProcessed: false },
        service.quota
      );

      // Successful result: remember any resource ids it minted, so follow-up
      // calls land on this same key.
      if (affinity?.responseFields.length && pool.recordAffinity) {
        const minted: string[] = [];
        for (const payload of payloadsOf(contentType, peek.text)) {
          minted.push(...collectResultIds(payload, affinity.responseFields));
        }
        if (minted.length > 0) {
          // A failed bookkeeping write must not fail a request the upstream
          // already served and charged for.
          await pool.recordAffinity(minted, picked.keyId, affinity.ttlSecs).catch(() => 0);
        }
      }
    }

    const stream = replayThenStream(peek.buffered, reader);

    return {
      response: new Response(stream, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      }),
      keyId: picked.keyId,
      attempts,
      verdicts,
      pinned: pinnedKeyId !== null,
    };
  }

  return {
    response:
      lastResponse ??
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: info.jsonrpcId,
          error: { code: -32603, message: "All upstream key attempts failed." },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      ),
    keyId: lastKeyId,
    attempts,
    verdicts,
    pinned: pinnedKeyId !== null,
  };
}
