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
}

export interface ForwardOutcome {
  response: Response;
  keyId: string | null;
  attempts: number;
  verdicts: ClassifyResult[];
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
 * Decide whether a peeked upstream response should cause a different key to be
 * tried. Returns null when the response is fine and should be passed through.
 */
function judgePeek(
  service: ServiceConfig,
  contentType: string,
  text: string
): ClassifyResult | null {
  if (contentType.includes("text/event-stream")) {
    for (const payload of ssePayloads(text)) {
      const verdict = classifyMcpResult(payload, service.quota);
      if (verdict) return verdict;
    }
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(text);
      return classifyMcpResult(payload, service.quota);
    } catch {
      return null;
    }
  }

  return null;
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
 */
export async function forwardMCP(
  request: Request,
  service: ServiceConfig,
  pool: PoolHandle
): Promise<ForwardOutcome> {
  // The body must be replayable. MCP requests are small JSON documents, so
  // buffering is cheaper and safer than trying to tee a stream.
  const body = request.method === "GET" || request.method === "DELETE" ? null : await request.arrayBuffer();
  const verdicts: ClassifyResult[] = [];
  let lastResponse: Response | null = null;
  let lastKeyId: string | null = null;
  let attempts = 0;

  const maxAttempts = request.method === "GET" || request.method === "DELETE" ? 1 : MAX_ATTEMPTS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const picked = await pool.pick();
    if (!picked) {
      if (lastResponse) break;
      return {
        response: new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
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
            id: null,
            error: { code: -32603, message: `Upstream unreachable: ${message}` },
          }),
          { status: 502, headers: { "content-type": "application/json" } }
        ),
        keyId: picked.keyId,
        attempts,
        verdicts,
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
      if (shouldReplay(verdict, service.retryOn5xx)) continue;
      return { response: lastResponse, keyId: picked.keyId, attempts, verdicts };
    }

    // GET and DELETE carry no JSON-RPC result to judge.
    if (!upstream.body || request.method !== "POST") {
      lastResponse = new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      });
      return { response: lastResponse, keyId: picked.keyId, attempts, verdicts };
    }

    const { peek, reader } = await peekFirstEvent(upstream.body, contentType);
    const verdict = judgePeek(service, contentType, peek.text);

    if (verdict && shouldReplay(verdict, service.retryOn5xx)) {
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
      // A real but non-retryable failure (client error). Record it so the admin
      // panel can show what happened, but hand it straight to the client.
      verdicts.push(verdict);
      await pool.report(picked.keyId, verdict, service.quota);
    } else {
      await pool.report(
        picked.keyId,
        { verdict: "ok", message: "", requestNotProcessed: false },
        service.quota
      );
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
    };
  }

  return {
    response:
      lastResponse ??
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "All upstream key attempts failed." },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      ),
    keyId: lastKeyId,
    attempts,
    verdicts,
  };
}
