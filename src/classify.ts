/**
 * Upstream failure classification.
 *
 * Two layers feed one decision:
 *   - classifyHttp reads the transport answer, meaning the status line plus
 *     whatever Retry-After the upstream sent.
 *   - classifyPayload and classifyMcpResult read the JSON-RPC answer, because
 *     several upstreams report a dead key or an empty balance inside a 200 OK
 *     with a perfectly ordinary looking body.
 *
 * Nothing here trusts prose from a successful tool result. Text patterns are
 * only consulted once the response already looks like a failure envelope, so a
 * search hit whose title happens to contain "Unauthorized" never costs a key.
 */

import type { ClassifyResult, QuotaRules, Verdict } from "./types";

/** Cool-down applied when an upstream rate limits us without saying for how long. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** An upstream hint never parks a key for more than a day. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Upstream error text is quoted into admin logs, so keep it short. */
const MAX_MESSAGE = 400;

/** Upstream error tags and the status they stand for. */
const TAG_STATUS: Record<string, number> = {
  INVALID_API_KEY: 401,
  API_KEY_REVOKED: 401,
  API_KEY_EXPIRED: 401,
  NO_MORE_CREDITS: 402,
  API_KEY_BUDGET_EXCEEDED: 402,
  TEAM_BUDGET_EXCEEDED: 402,
  FEATURE_DISABLED: 403,
  PROHIBITED_CONTENT: 403,
  TEAM_BLOCKED: 403,
  CONTENT_FILTER_ERROR: 403,
  RATE_LIMIT_EXCEEDED: 429,
  CONCURRENCY_LIMIT_REACHED: 429,
  SERVICE_OVERLOADED: 503,
  INVALID_REQUEST_BODY: 400,
  INVALID_REQUEST: 400,
};

const AUTH_TAGS = new Set(["INVALID_API_KEY", "API_KEY_REVOKED", "API_KEY_EXPIRED", "TEAM_BLOCKED"]);
const QUOTA_TAGS = new Set(["NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"]);
const RATE_TAGS = new Set(["RATE_LIMIT_EXCEEDED", "CONCURRENCY_LIMIT_REACHED"]);

/** Longest first, so INVALID_REQUEST_BODY is not shadowed by INVALID_REQUEST. */
const TAG_NAMES = Object.keys(TAG_STATUS).sort((a, b) => b.length - a.length);

const QUOTA_TEXT =
  /(?:no more|insufficient|not enough|exhausted|out of|ran out of).{0,30}credits|credits?.{0,30}(?:exhausted|depleted|exceeded)|quota.{0,30}(?:exceeded|exhausted)|(?:exceeds?|reached).{0,40}(?:usage|pay.as.you.go|plan).{0,15}limit|insufficient balance/i;

const AUTH_TEXT =
  /(?:invalid|expired|revoked|missing|disabled).{0,16}(?:api[ _-]?key|authentication)|unauthorized|(?:api[ _-]?key).{0,16}(?:invalid|expired|revoked)|(?:account|team).{0,20}(?:disabled|suspended|blocked)/i;

const RATE_TEXT = /rate[ _-]?limit|too many requests|concurrency.{0,20}(?:limit|exceeded)/i;

/** Status embedded in prose: "HTTP 401", "status code 504", `"status":401`, "error (401):". */
const STATUS_TEXT = /\berror \((\d{3})\):|\b(?:HTTP|status(?: code)?)["']?\s*[: ]\s*(\d{3})\b/i;

/**
 * Shape some MCP servers use for tool failures: "web_search_exa error (401): ...".
 * It is an explicit error envelope even when the server forgets to set isError.
 */
const FORMATTED_ERROR = /^[a-z][\w.-]*\s+error(?: \(\d{3}\))?\s*:/i;

/** What one error envelope said, before the rules turn it into a verdict. */
interface Finding {
  message: string;
  status?: number;
  code?: string;
  retryAfterMs?: number;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE)}...` : flat;
}

/** Flattens the usual error carriers of a JSON body into one readable line. */
function textOf(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => textOf(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [record.message, record.error, record.detail, record.msg, record.reason]
    .map((item) => textOf(item, depth + 1))
    .filter(Boolean)
    .join("; ");
}

/** Reads the tag/code field of an error body, skipping JSON-RPC numeric codes. */
function tagOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
  for (const candidate of [record.tag, record.code, nested?.tag, nested?.code]) {
    if (typeof candidate !== "string") continue;
    const upper = candidate.toUpperCase();
    if (TAG_STATUS[upper] !== undefined) return upper;
  }
  return undefined;
}

/** Finds a known tag spelled out inside a message. */
function tagOfText(message: string): string | undefined {
  if (message === "") return undefined;
  const upper = message.toUpperCase();
  for (const tag of TAG_NAMES) {
    if (upper.includes(tag)) return tag;
  }
  return undefined;
}

/** Pulls a 4xx/5xx status out of prose, when the text happens to carry one. */
function statusFromText(message: string): number | undefined {
  const match = STATUS_TEXT.exec(message);
  if (!match) return undefined;
  const raw = match[1] ?? match[2];
  if (raw === undefined) return undefined;
  const status = Number(raw);
  return status >= 400 && status < 600 ? status : undefined;
}

/** Retry-After accepts delta-seconds and HTTP-date; anything else means "wait a minute". */
function parseRetryAfter(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (raw === null) return DEFAULT_COOLDOWN_MS;
  const value = raw.trim();
  if (value === "") return DEFAULT_COOLDOWN_MS;
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1000, MAX_COOLDOWN_MS);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return DEFAULT_COOLDOWN_MS;
  return Math.max(0, Math.min(at - Date.now(), MAX_COOLDOWN_MS));
}

/** A retry hint carried inside a JSON body: seconds when numeric, an absolute time when not. */
function retryAfterOf(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const candidate of [record.retryAfter, record.retry_after]) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return Math.min(candidate * 1000, MAX_COOLDOWN_MS);
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const seconds = Number(candidate);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
      const at = Date.parse(candidate);
      if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), MAX_COOLDOWN_MS));
    }
  }
  return undefined;
}

/** Turns a status plus the failure wording into a verdict. */
function decide(status: number | undefined, message: string, code: string | undefined, rules: QuotaRules): Verdict {
  if (status !== undefined) {
    if (rules.invalidStatuses.includes(status)) return "invalid";
    if (rules.exhaustedStatuses.includes(status)) return "exhausted";
    if (rules.cooldownStatuses.includes(status)) return "cooldown";
  }
  // An explicit tag beats the status: the tag names the cause, the status only ranks it.
  if (code !== undefined && AUTH_TAGS.has(code)) return "invalid";
  if (code !== undefined && QUOTA_TAGS.has(code)) return "exhausted";
  if (code !== undefined && RATE_TAGS.has(code)) return "cooldown";
  if (status === 401) return "invalid";
  if (status === 402) return "exhausted";
  if (status === 429) return "cooldown";
  // A server fault is never the key's fault, so stop before reading the prose.
  if (status !== undefined && status >= 500) return "server";
  if (AUTH_TEXT.test(message)) return "invalid";
  if (QUOTA_TEXT.test(message)) return "exhausted";
  if (RATE_TEXT.test(message)) return "cooldown";
  return "client";
}

/** Fills the optional fields of a classification once the verdict is known. */
function assemble(
  verdict: Verdict,
  status: number | undefined,
  code: string | undefined,
  message: string,
  retryAfterMs: number | undefined
): ClassifyResult {
  return {
    verdict,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    message,
    ...(verdict === "cooldown" ? { retryAfterMs: retryAfterMs ?? DEFAULT_COOLDOWN_MS } : {}),
    // A rejected request, a dead key or an empty balance means no tool ever ran.
    requestNotProcessed: verdict !== "server" && verdict !== "network",
  };
}

/** Derives the missing half of a finding, then applies the service rules. */
function resolve(finding: Finding, rules: QuotaRules): ClassifyResult {
  const raw = finding.message;
  const message = clip(raw) || "Upstream returned an error";
  const code = finding.code ?? tagOfText(raw);
  const status = finding.status ?? statusFromText(raw) ?? (code !== undefined ? TAG_STATUS[code] : undefined);
  const verdict = decide(status, message, code, rules);
  return assemble(verdict, status, code, message, finding.retryAfterMs);
}

/** True when a parsed JSON body declares itself a failure rather than a result. */
function payloadFailure(value: unknown): Finding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const explicit = [record.statusCode, record.status_code, record.httpStatusCode].find(
    (item): item is number => typeof item === "number" && item >= 400 && item < 600
  );
  const bodyStatus =
    typeof record.status === "number" && record.status >= 400 && record.status < 600 ? record.status : undefined;

  const declaresFailure =
    Boolean(record.error) ||
    record.success === false ||
    record.ok === false ||
    (typeof record.status === "string" && /^(?:error|failed|failure)$/i.test(record.status)) ||
    explicit !== undefined ||
    bodyStatus !== undefined ||
    tagOf(record) !== undefined;
  if (!declaresFailure) return null;

  const finding: Finding = { message: textOf(record) || "Upstream returned an error" };
  const status = explicit ?? bodyStatus;
  if (status !== undefined) finding.status = status;
  const code = tagOf(record);
  if (code !== undefined) finding.code = code;
  const retryAfterMs = retryAfterOf(record);
  if (retryAfterMs !== undefined) finding.retryAfterMs = retryAfterMs;
  return finding;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function readBody(bodyText: string): Finding {
  const text = bodyText.trim();
  if (text === "") return { message: "" };
  const parsed = parseJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const finding: Finding = { message: clip(textOf(parsed)) || clip(text) };
    const code = tagOf(parsed);
    if (code !== undefined) finding.code = code;
    return finding;
  }
  return { message: clip(text) };
}

export function classifyHttp(
  status: number,
  headers: Headers,
  bodyText: string,
  rules: QuotaRules,
  retryOn5xx: boolean
): ClassifyResult {
  const body = readBody(bodyText);
  const detail = body.message === "" ? "" : `: ${body.message}`;
  const code = body.code;

  if (rules.invalidStatuses.includes(status)) {
    return assemble("invalid", status, code, `HTTP ${status}${detail}`, undefined);
  }
  if (rules.exhaustedStatuses.includes(status)) {
    return assemble("exhausted", status, code, `HTTP ${status}${detail}`, undefined);
  }
  if (rules.cooldownStatuses.includes(status)) {
    return assemble("cooldown", status, code, `HTTP ${status}${detail}`, parseRetryAfter(headers));
  }
  if (status >= 500) {
    // Replaying a tool call after a 5xx is only safe when the service opts in.
    return {
      verdict: "server",
      status,
      ...(code !== undefined ? { code } : {}),
      message: `HTTP ${status}${detail}`,
      requestNotProcessed: retryOn5xx,
    };
  }
  if (status >= 400) {
    return assemble("client", status, code, `HTTP ${status}${detail}`, undefined);
  }
  // Some upstreams wrap a quota error in a 200; the body still has to be read.
  return { verdict: "ok", status, message: `HTTP ${status}`, requestNotProcessed: false };
}

export function classifyPayload(payload: unknown, rules: QuotaRules): ClassifyResult | null {
  const finding = payloadFailure(payload);
  return finding === null ? null : resolve(finding, rules);
}

export function classifyMcpResult(result: unknown, rules: QuotaRules): ClassifyResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const envelope = result as Record<string, unknown>;

  // 1. JSON-RPC protocol level error, e.g. {"error":{"code":-32600,...}}.
  const rpcError = envelope.error;
  if (rpcError !== undefined && rpcError !== null && rpcError !== "" && rpcError !== false) {
    return resolve({ message: textOf(rpcError) || "Upstream returned a JSON-RPC error", code: tagOf(rpcError) }, rules);
  }

  const inner = envelope.result;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  const toolResult = inner as Record<string, unknown>;
  const isError = toolResult.isError === true;

  const meta = toolResult._meta;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>)["ai.exa/rateLimited"]) {
    return assemble(
      "cooldown",
      429,
      "RATE_LIMIT_EXCEEDED",
      "Upstream marked the response as rate limited",
      DEFAULT_COOLDOWN_MS
    );
  }

  const texts: string[] = [];
  const blocks = Array.isArray(toolResult.content) ? toolResult.content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
  }

  // 2. Structured payloads that declare themselves failures, such as the JSON
  //    string Tavily puts in a text block.
  const candidates: unknown[] = [toolResult.structuredContent, ...texts.map(parseJson)];
  for (const candidate of candidates) {
    const finding = payloadFailure(candidate);
    if (finding !== null) return resolve(finding, rules);
  }

  // 3. Plain text only counts when the result is flagged as an error, or when
  //    the server used its explicit "tool error (status): ..." shape.
  const formatted = texts.find((text) => FORMATTED_ERROR.test(text.trim()));
  if (!isError && formatted === undefined) return null;

  const message = clip(texts.join("\n")) || "Upstream MCP returned an error";
  return resolve({ message }, rules);
}
