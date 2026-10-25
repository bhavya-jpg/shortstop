// Structured JSONL tracing: one file per run (logs/trace-<run_id>.jsonl) plus a
// readable line on stdout. Every event records the run mode and whether it was
// a real call to an external service, so sample-mode events can never be read
// as sponsor-service activity. Secrets are redacted before anything is written.

import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../domain/types.ts";

export type ExternalService = "zetaris" | "nightshift";

export interface TraceEvent {
  stage: string;
  agent: string;
  action: string;
  status: "start" | "success" | "failure" | "info" | "rejected" | "escalated";
  summary: string;
  // Present only for a real network call to a sponsor service.
  external?: { service: ExternalService; endpoint: string; http_status?: number; duration_ms?: number; attempts?: number };
  model?: { requested: string; reported?: string | null; routing?: unknown };
  decision_id?: string;
  revision?: number;
  details?: Record<string, unknown>;
}

// Credential-like keys only. Usage counters such as input_tokens or tokensIn
// (seen in real Nightshift receipts) are data, not secrets, and are kept.
const SECRET_KEY = /(^|[_-])(access[_-]?|refresh[_-]?|id[_-]?|runtime[_-]?|proxy[_-]?|auth[_-]?)?token$|^token$|authorization|api[_-]?key|password|passwd|secret|bearer|cookie/i;
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "$1[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface TracerOptions {
  runId: string;
  mode: Mode;
  logDir?: string; // omit to keep events in memory only (tests)
  echo?: boolean;
  clock?: () => Date;
}

export class Tracer {
  readonly runId: string;
  readonly mode: Mode;
  readonly file?: string;
  private seq = 0;
  private readonly events: Record<string, unknown>[] = [];
  private readonly echo: boolean;
  private readonly clock: () => Date;

  constructor(opts: TracerOptions) {
    this.runId = opts.runId;
    this.mode = opts.mode;
    this.echo = opts.echo ?? false;
    this.clock = opts.clock ?? (() => new Date());
    if (opts.logDir) {
      fs.mkdirSync(opts.logDir, { recursive: true });
      this.file = path.join(opts.logDir, `trace-${opts.runId}.jsonl`);
      // A later step for the same run (human review) continues the numbering.
      if (fs.existsSync(this.file)) this.seq = fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).length;
    }
  }

  emit(e: TraceEvent): void {
    const line = redact({
      timestamp: this.clock().toISOString(),
      run_id: this.runId,
      seq: ++this.seq,
      mode: this.mode,
      external_call: e.external !== undefined,
      ...e,
    }) as Record<string, unknown>;
    this.events.push(line);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(line) + "\n", "utf-8");
    if (this.echo) {
      const level = e.status === "failure" ? "ERROR" : e.status === "rejected" || e.status === "escalated" ? "WARN" : "INFO";
      const ext = e.external ? ` [${e.external.service} ${e.external.endpoint}${e.external.http_status ? ` ${e.external.http_status}` : ""}]` : "";
      const model = e.model ? ` (model requested=${e.model.requested} reported=${e.model.reported ?? "not reported"})` : "";
      console.log(`[${level}] run_id=${this.runId} mode=${this.mode} ${e.stage}/${e.agent}: ${e.summary}${ext}${model}`);
    }
  }

  all(): readonly Record<string, unknown>[] {
    return this.events;
  }
}
