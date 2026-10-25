// Meterless Nightshift (Meterless Runtime) adapter. Contract: the POWER
// "Add Meterless as a provider" prompt at meterless.ai/engines.html (Runtime
// 1.4, provider contract v4) and docs/agent-ready/add-meterless-provider.md:
//   - base URL normalized to <host>/v1, never /v1/v1
//   - Authorization: Bearer <runtime token> on every call; rt-local is rejected
//   - meterless-app: <stable lowercase id> on every call; meterless-scope: user on chat
//   - model ids are routing modes (meterless/*), read from GET /v1/models
//   - GET /v1/models decides status: 401/403 unauthorized, 200 with meterless ids
//     online, anything else offline
//   - OpenAI-compatible POST /v1/chat/completions, 180 s timeout
//   - 429 retries after 2 s, 4 s, 8 s (engines page, "Read every answer it sends")
// The adapter records the routing information the runtime returns and never
// infers which underlying model handled a request.

import type { NightshiftConfig } from "../config.ts";

export class NightshiftError extends Error {
  override name = "NightshiftError";
  constructor(
    message: string,
    readonly kind: "config" | "unauthorized" | "offline" | "timeout" | "rate_limited" | "server" | "response_shape" | "refused",
    readonly httpStatus?: number,
    readonly retryable = false
  ) {
    super(message);
  }
}

export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (s === "") throw new NightshiftError("METERLESS_BASE_URL is empty", "config");
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new NightshiftError(`METERLESS_BASE_URL is not a URL: "${input}"`, "config");
  }
  let p = u.pathname.replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/models", "/healthz"]) {
    if (p.endsWith(suffix)) p = p.slice(0, -suffix.length);
  }
  p = p.replace(/(\/v1)+$/, "");
  return `${u.protocol}//${u.host}${p}/v1`;
}

export interface DiscoveryResult {
  status: "online" | "unauthorized" | "offline";
  httpStatus?: number;
  models: string[];
  detail?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  modelRequested: string;
  modelReported: string | null; // the response's `model` field, verbatim
  meterless: unknown; // the response's top-level `meterless` block, verbatim, if any
  routingHeaders: Record<string, string>; // response headers starting with meterless- / x-meterless-
  responseId: string | null;
  usage: unknown;
  finishReason: string | null;
  attempts: number;
  durationMs: number;
  httpStatus: number;
}

export interface NightshiftCallInfo {
  endpoint: string;
  attempt: number;
  httpStatus?: number;
  durationMs: number;
  error?: string;
}

type Fetch = typeof fetch;
const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000];

export class NightshiftClient {
  readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  onCall?: (info: NightshiftCallInfo) => void;

  constructor(
    private readonly cfg: NightshiftConfig,
    deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}
  ) {
    if (!cfg.token || cfg.token === "rt-local") {
      throw new NightshiftError("a real Nightshift runtime token is required (rt-local is rejected by the runtime)", "config");
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(cfg.app)) {
      throw new NightshiftError(`meterless-app must be a stable lowercase id, got "${cfg.app}"`, "config");
    }
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl);
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(chat: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      "meterless-app": this.cfg.app,
      ...(chat ? { "meterless-scope": this.cfg.scope } : {}),
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async discover(): Promise<DiscoveryResult> {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.headers(false),
        signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs, 15_000)),
      });
    } catch (err) {
      const detail = (err as Error)?.message ?? String(err);
      this.onCall?.({ endpoint: "GET /v1/models", attempt: 1, durationMs: Date.now() - t0, error: detail });
      return { status: "offline", models: [], detail: `cannot reach ${this.baseUrl}: ${detail}` };
    }
    this.onCall?.({ endpoint: "GET /v1/models", attempt: 1, httpStatus: res.status, durationMs: Date.now() - t0 });
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized", httpStatus: res.status, models: [], detail: "the runtime rejected the token; copy the Runtime API key from Nightshift's Console" };
    }
    if (res.status !== 200) return { status: "offline", httpStatus: res.status, models: [], detail: `GET /v1/models returned HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = Array.isArray(body?.data) ? body!.data.map((m) => m?.id).filter((x): x is string => typeof x === "string") : [];
    const meterless = ids.filter((id) => id.startsWith("meterless/"));
    if (meterless.length === 0) {
      return { status: "offline", httpStatus: 200, models: ids, detail: "GET /v1/models answered but listed no meterless/* routing modes" };
    }
    return { status: "online", httpStatus: 200, models: ids };
  }

  async chat(messages: ChatMessage[], opts: { model?: string; temperature?: number } = {}): Promise<ChatResult> {
    const model = opts.model ?? this.cfg.model;
    const body = JSON.stringify({ model, messages, stream: false, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) });
    const started = Date.now();
    let rateLimitRetries = 0;
    let otherRetries = 0;
    let lastError: NightshiftError | undefined;

    for (let attempt = 1; ; attempt++) {
      const t0 = Date.now();
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(true),
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        lastError =
          e?.name === "TimeoutError" || e?.name === "AbortError"
            ? new NightshiftError(`Nightshift did not answer within ${this.cfg.timeoutMs} ms`, "timeout", undefined, true)
            : new NightshiftError(`cannot reach Nightshift at ${this.baseUrl}: ${e?.message ?? String(err)}`, "offline", undefined, true);
        this.onCall?.({ endpoint: "POST /v1/chat/completions", attempt, durationMs: Date.now() - t0, error: lastError.message });
      }

      if (res) {
        const text = await res.text();
        this.onCall?.({ endpoint: "POST /v1/chat/completions", attempt, httpStatus: res.status, durationMs: Date.now() - t0 });
        if (res.ok) return { ...parseChat(text, model, res), attempts: attempt, durationMs: Date.now() - started, httpStatus: res.status };
        lastError = chatHttpError(res.status, text);
        if (lastError.kind === "rate_limited" && rateLimitRetries < RATE_LIMIT_BACKOFF_MS.length) {
          await this.sleep(RATE_LIMIT_BACKOFF_MS[rateLimitRetries++]!);
          continue;
        }
        if (!lastError.retryable || lastError.kind === "rate_limited") throw lastError;
      }
      if (otherRetries >= this.cfg.maxRetries) {
        throw new NightshiftError(`${lastError!.message} (gave up after ${attempt} attempts)`, lastError!.kind, lastError!.httpStatus);
      }
      otherRetries++;
      await this.sleep(1000 * 2 ** (otherRetries - 1));
    }
  }
}

export interface AutoDetectAttempt {
  base_url: string;
  status: DiscoveryResult["status"];
  http_status?: number;
}

// Contract "Auto Detect": try ports 8088, 8090, 8787 and 11434 on 127.0.0.1,
// localhost and [::1]; the first online or unauthorized answer wins. Without a
// token an existing runtime answers 401, which still proves it is there.
export async function autoDetect(
  token: string | undefined,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ found?: AutoDetectAttempt; attempts: AutoDetectAttempt[] }> {
  const f = deps.fetch ?? fetch;
  const attempts: AutoDetectAttempt[] = [];
  for (const port of [8088, 8090, 8787, 11434]) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const base = `http://${host}:${port}/v1`;
      let attempt: AutoDetectAttempt;
      try {
        const res = await f(`${base}/models`, {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "meterless-app": "shortstop" },
          signal: AbortSignal.timeout(deps.timeoutMs ?? 1500),
        });
        let status: DiscoveryResult["status"] = "offline";
        if (res.status === 401 || res.status === 403) status = "unauthorized";
        else if (res.status === 200) {
          const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
          if (body?.data?.some((m) => typeof m?.id === "string" && m.id.startsWith("meterless/"))) status = "online";
        }
        attempt = { base_url: base, status, http_status: res.status };
      } catch {
        attempt = { base_url: base, status: "offline" };
      }
      attempts.push(attempt);
      if (attempt.status !== "offline") return { found: attempt, attempts };
    }
  }
  return { attempts };
}

function chatHttpError(status: number, body: string): NightshiftError {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return new NightshiftError(`Nightshift rejected the runtime token (HTTP ${status}). Copy the Runtime API key from Nightshift's Console into METERLESS_RUNTIME_TOKEN.`, "unauthorized", status);
  }
  if (status === 429) return new NightshiftError(`Nightshift rate limit or quota (HTTP 429): ${detail}`, "rate_limited", status, true);
  if (status >= 500) return new NightshiftError(`Nightshift returned HTTP ${status}: ${detail}`, "server", status, true);
  // A typed refusal (e.g. an unknown routing mode) goes back with its real reason.
  return new NightshiftError(`Nightshift refused the request (HTTP ${status}): ${detail}`, "refused", status);
}

function parseChat(text: string, modelRequested: string, res: Response): Omit<ChatResult, "attempts" | "durationMs" | "httpStatus"> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new NightshiftError(`Nightshift returned non-JSON: ${text.slice(0, 200)}`, "response_shape");
  }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new NightshiftError(`Nightshift response has no choices (keys: ${Object.keys(json).join(", ")})`, "response_shape");
  }
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown };
  const content = flattenContent(first?.message?.content);
  if (content === null) throw new NightshiftError("Nightshift response has no text content in choices[0].message", "response_shape");
  const routingHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/^(x-)?meterless-/i.test(k)) routingHeaders[k.toLowerCase()] = v;
  });
  return {
    content,
    modelRequested,
    modelReported: typeof json.model === "string" ? json.model : null,
    meterless: json.meterless ?? null,
    routingHeaders,
    responseId: typeof json.id === "string" ? json.id : null,
    usage: json.usage ?? null,
    finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
  };
}

// content is a string, or an array of parts; only text parts are read here.
function flattenContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? (p as { text?: unknown }).text : null))
      .filter((t): t is string => typeof t === "string");
    return texts.length > 0 ? texts.join("") : null;
  }
  return null;
}
