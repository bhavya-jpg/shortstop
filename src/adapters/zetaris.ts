// Zetaris REST adapter. Contract from the Participant Setup Guide and
// zetaris/getting-started scripts/zetaris_sql.py:
//   POST {ZETARIS_REST_URL}/sql-editor/sqls/run
//   Authorization: Bearer <API key>, X-Org-ID: <org>, X-Request-ID: <fresh UUID>
//   body {queryId, sql, source: "SqlEditor", limit}
//   response {data: [[...row values]], ...}
// One statement per call, no trailing semicolon (getting-started AGENTS.md).
// Column order in `data` is taken from the SELECT list; the adapter maps rows to
// the expected column names and fails if the shape does not match.

import { randomUUID } from "node:crypto";
import type { ZetarisConfig } from "../config.ts";

export class ZetarisError extends Error {
  override name = "ZetarisError";
  constructor(
    message: string,
    readonly kind: "config" | "unreachable" | "timeout" | "unauthorized" | "bad_request" | "server" | "upstream" | "response_shape",
    readonly httpStatus?: number,
    readonly retryable = false
  ) {
    super(message);
  }
}

export interface ZetarisQueryResult<T extends string> {
  rows: Record<T, unknown>[];
  rowCount: number;
  queryId: string;
  requestIds: string[];
  attempts: number;
  durationMs: number;
  httpStatus: number;
  responseKeys: string[];
}

export interface ZetarisRawResult extends Omit<ZetarisQueryResult<never>, "rows"> {
  rows: unknown[];
  extra: Record<string, unknown>; // response fields other than data, verbatim (strings truncated)
}

export interface ZetarisCallInfo {
  endpoint: string;
  queryId: string;
  requestId: string;
  attempt: number;
  httpStatus?: number;
  durationMs: number;
  error?: string;
}

type Fetch = typeof fetch;

export class ZetarisClient {
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  onCall?: (info: ZetarisCallInfo) => void;

  constructor(
    private readonly cfg: Pick<ZetarisConfig, "restUrl" | "orgId" | "apiKey" | "timeoutMs" | "maxRetries">,
    deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Runs one statement and maps rows to the expected SELECT columns.
  async query<T extends string>(sql: string, columns: readonly T[], opts: { limit?: number } = {}): Promise<ZetarisQueryResult<T>> {
    const r = await this.run(sql, opts.limit);
    const rows = mapRows(r.data, columns, r.extra.headers);
    return { ...r.meta, rows, rowCount: rows.length };
  }

  // Runs one statement and returns rows exactly as Zetaris sent them. For SHOW,
  // DDL and registration statements, whose result shape is not known up front.
  async execute(sql: string, opts: { limit?: number } = {}): Promise<ZetarisRawResult> {
    const r = await this.run(sql, opts.limit);
    const rows = r.data === null || r.data === undefined ? [] : Array.isArray(r.data) ? r.data : [r.data];
    return { ...r.meta, rows, rowCount: rows.length, extra: r.extra };
  }

  // GET on a REST path (e.g. /datasource/datasources), with the same headers.
  async get(pathname: string): Promise<{ httpStatus: number; body: unknown }> {
    const requestId = randomUUID();
    const t0 = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.restUrl}${pathname}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "X-Org-ID": this.cfg.orgId, "X-Request-ID": requestId, Accept: "application/json" },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const e = transportError(err, this.cfg.restUrl, this.cfg.timeoutMs);
      this.onCall?.({ endpoint: `GET ${pathname}`, queryId: "-", requestId, attempt: 1, durationMs: Date.now() - t0, error: e.message });
      throw e;
    }
    const text = await res.text();
    this.onCall?.({ endpoint: `GET ${pathname}`, queryId: "-", requestId, attempt: 1, httpStatus: res.status, durationMs: Date.now() - t0 });
    if (!res.ok) throw httpError(res.status, text);
    try {
      return { httpStatus: res.status, body: JSON.parse(text) };
    } catch {
      throw new ZetarisError(`GET ${pathname} returned non-JSON: ${text.slice(0, 200)}`, "response_shape");
    }
  }

  private async run(sql: string, limit = 10_000): Promise<{ data: unknown; extra: Record<string, unknown>; meta: Omit<ZetarisQueryResult<never>, "rows" | "rowCount"> }> {
    const statement = sql.trim().replace(/;\s*$/, "");
    if (statement.includes(";")) throw new ZetarisError("send one SQL statement per call", "bad_request");
    const queryId = randomUUID();
    const body = JSON.stringify({ queryId, sql: statement, source: "SqlEditor", limit });
    const url = `${this.cfg.restUrl}/sql-editor/sqls/run`;
    const requestIds: string[] = [];
    const started = Date.now();
    let lastError: ZetarisError | undefined;

    for (let attempt = 1; attempt <= this.cfg.maxRetries + 1; attempt++) {
      const requestId = randomUUID(); // fresh for every request, including retries
      requestIds.push(requestId);
      const t0 = Date.now();
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            "X-Org-ID": this.cfg.orgId,
            "X-Request-ID": requestId,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        const text = await res.text();
        this.onCall?.({ endpoint: "/sql-editor/sqls/run", queryId, requestId, attempt, httpStatus: res.status, durationMs: Date.now() - t0 });
        if (!res.ok) {
          lastError = httpError(res.status, text);
          if (!lastError.retryable) throw lastError;
        } else {
          const parsed = parseBody(text);
          return {
            data: parsed.data,
            extra: parsed.extra,
            meta: { queryId, requestIds, attempts: attempt, durationMs: Date.now() - started, httpStatus: res.status, responseKeys: parsed.keys },
          };
        }
      } catch (err) {
        if (err instanceof ZetarisError) {
          if (!err.retryable) throw err;
          lastError = err;
        } else {
          lastError = transportError(err, this.cfg.restUrl, this.cfg.timeoutMs);
          this.onCall?.({ endpoint: "/sql-editor/sqls/run", queryId, requestId, attempt, durationMs: Date.now() - t0, error: lastError.message });
        }
      }
      if (attempt <= this.cfg.maxRetries) await this.sleep(1000 * 2 ** (attempt - 1));
    }
    throw new ZetarisError(`${lastError?.message ?? "Zetaris request failed"} (gave up after ${this.cfg.maxRetries + 1} attempts)`, lastError?.kind ?? "server", lastError?.httpStatus);
  }
}

function httpError(status: number, body: string): ZetarisError {
  const detail = body.includes("<html") ? "the server returned an HTML page; check that ZETARIS_REST_URL ends in /api/v1.0" : body.slice(0, 300);
  // Observed on the live service (2026-10-25): an invalid or revoked API key is
  // answered with HTTP 400 {"msg":"Not Allowed"}, not 401.
  const notAllowed = status === 400 && /"msg"\s*:\s*"Not Allowed"/i.test(body);
  // Observed live (2026-10-26): when the source behind a REST table (openFDA)
  // has a transient 5xx, Zetaris reports it as HTTP 400 "REST API call failed:
  // Server returned HTTP response code: 500 for URL ...". That is retryable.
  const upstream = /REST API call failed: Server returned HTTP response code: 5\d\d/i.exec(body);
  if (upstream) {
    const url = /for URL: (\S+)/.exec(body)?.[1]?.replace(/\\n.*$/, "") ?? "the REST source";
    return new ZetarisError(`The source behind a Zetaris REST table failed transiently (${upstream[0].replace(/^.*code: /, "HTTP ")} from ${url.split("?")[0]})`, "upstream", status, true);
  }
  if (status === 401 || status === 403 || notAllowed) {
    return new ZetarisError(`Zetaris rejected the API key (HTTP ${status}${notAllowed ? ' "Not Allowed"' : ""}). Create a new key under Management → API Tokens and update ZETARIS_API_KEY.`, "unauthorized", status);
  }
  if (status === 400) {
    const hint = /org/i.test(detail) || /request.?id/i.test(detail) ? "Check ZETARIS_ORG_ID (1 on a local install)." : "Check the SQL statement.";
    return new ZetarisError(`Zetaris returned HTTP 400: ${detail}. ${hint}`, "bad_request", status);
  }
  if (status === 404) return new ZetarisError(`Zetaris returned HTTP 404 for /sql-editor/sqls/run: ${detail}`, "bad_request", status);
  const retryable = status === 429 || status >= 500;
  return new ZetarisError(`Zetaris returned HTTP ${status}: ${detail}`, "server", status, retryable);
}

function transportError(err: unknown, url: string, timeoutMs: number): ZetarisError {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return new ZetarisError(`Zetaris did not answer within ${timeoutMs} ms`, "timeout", undefined, true);
  }
  const code = e?.cause?.code ? ` (${e.cause.code})` : "";
  return new ZetarisError(`Cannot reach Zetaris at ${url}${code}. Is the platform running (docker compose ps)?`, "unreachable", undefined, true);
}

function parseBody(text: string): { data: unknown; keys: string[]; extra: Record<string, unknown> } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ZetarisError(`Zetaris returned non-JSON: ${text.slice(0, 200)}`, "response_shape");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ZetarisError("Zetaris response is not a JSON object", "response_shape");
  }
  const obj = json as Record<string, unknown>;
  if (!("data" in obj)) {
    throw new ZetarisError(`Zetaris response has no "data" field (keys: ${Object.keys(obj).join(", ")})`, "response_shape");
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k !== "data") extra[k] = typeof v === "string" ? v.slice(0, 200) : v;
  return { data: obj.data, keys: Object.keys(obj), extra };
}

// Live Zetaris (verified 2026-10-25) answers {headers: [column names], data:
// [[values]], total, timeUsed}, with numbers as strings. When headers are
// present, rows are mapped by name; positional mapping is only a fallback.
function mapRows<T extends string>(data: unknown, columns: readonly T[], headers?: unknown): Record<T, unknown>[] {
  if (data === null) return [];
  if (!Array.isArray(data)) throw new ZetarisError(`Zetaris "data" is ${typeof data}, expected an array of rows`, "response_shape");
  let index: number[] | undefined;
  if (Array.isArray(headers) && headers.every((h) => typeof h === "string")) {
    const names = (headers as string[]).map((h) => h.toLowerCase());
    index = columns.map((c) => {
      const j = names.indexOf(c.toLowerCase());
      if (j < 0) throw new ZetarisError(`Zetaris result has no column "${c}" (headers: ${(headers as string[]).join(", ")})`, "response_shape");
      return j;
    });
  }
  return data.map((row, i) => {
    const out = {} as Record<T, unknown>;
    if (Array.isArray(row) && index) {
      columns.forEach((c, j) => (out[c] = row[index![j]!]));
    } else if (Array.isArray(row)) {
      if (row.length !== columns.length) {
        throw new ZetarisError(`row ${i} has ${row.length} values; expected ${columns.length} (${columns.join(", ")})`, "response_shape");
      }
      columns.forEach((c, j) => (out[c] = row[j]));
    } else if (row && typeof row === "object") {
      const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
      for (const c of columns) {
        if (!lower.has(c.toLowerCase())) throw new ZetarisError(`row ${i} has no column "${c}"`, "response_shape");
        out[c] = lower.get(c.toLowerCase());
      }
    } else {
      throw new ZetarisError(`row ${i} is neither an array nor an object`, "response_shape");
    }
    return out;
  });
}
