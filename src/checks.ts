// Live integration checks against the real sponsor services. Each step reports
// PASS, FAIL or BLOCKED (a prerequisite is missing, so the step was not run).
// BLOCKED is never counted as a pass. Results are redacted before they are
// printed or saved, and secret values are never included in the first place.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { autoDetect, NightshiftClient, normalizeBaseUrl } from "./adapters/nightshift.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { ConfigError, readNightshiftConfig, readZetarisConfig } from "./config.ts";
import { redact } from "./trace/tracer.ts";

export type CheckStatus = "PASS" | "FAIL" | "BLOCKED";
export interface CheckStep {
  name: string;
  status: CheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}
export interface CheckReport {
  target: string;
  started_at: string;
  steps: CheckStep[];
  ok: boolean;
}

type Env = Record<string, string | undefined>;
const PLACEHOLDER = /^(your-|rt-local$|changeme$)/;

function presence(env: Env, names: string[]): { set: string[]; missing: string[]; placeholder: string[] } {
  const set: string[] = [];
  const missing: string[] = [];
  const placeholder: string[] = [];
  for (const n of names) {
    const v = env[n]?.trim();
    if (!v) missing.push(n);
    else if (PLACEHOLDER.test(v)) placeholder.push(n);
    else set.push(n);
  }
  return { set, missing, placeholder };
}

class Steps {
  readonly steps: CheckStep[] = [];
  async run(name: string, fn: () => Promise<{ detail: string; evidence?: Record<string, unknown> }>): Promise<boolean> {
    try {
      const r = await fn();
      this.steps.push({ name, status: "PASS", ...r });
      return true;
    } catch (err) {
      const e = err as Error;
      this.steps.push({ name, status: "FAIL", detail: `${e.name}: ${e.message}` });
      return false;
    }
  }
  block(name: string, why: string): void {
    this.steps.push({ name, status: "BLOCKED", detail: why });
  }
}

function report(target: string, started: Date, s: Steps): CheckReport {
  return { target, started_at: started.toISOString(), steps: redact(s.steps) as CheckStep[], ok: s.steps.length > 0 && s.steps.every((x) => x.status === "PASS") };
}

export async function checkNightshift(env: Env): Promise<CheckReport> {
  const started = new Date();
  const s = new Steps();
  const names = presence(env, ["METERLESS_BASE_URL", "METERLESS_RUNTIME_TOKEN", "METERLESS_MODEL"]);
  s.steps.push({
    name: "configuration (names only)",
    status: names.missing.length || names.placeholder.length ? "FAIL" : "PASS",
    detail: `set: [${names.set.join(", ")}] missing: [${names.missing.join(", ")}] placeholder: [${names.placeholder.join(", ")}]`,
  });
  const token = names.set.includes("METERLESS_RUNTIME_TOKEN") ? env.METERLESS_RUNTIME_TOKEN!.trim() : undefined;

  let detected: string | undefined;
  await s.run("runtime reachable (contract Auto Detect)", async () => {
    const r = await autoDetect(token);
    if (!r.found) throw new Error(`no runtime answered on ports 8088, 8090, 8787, 11434 (127.0.0.1, localhost, [::1]); ${r.attempts.length} attempts, all refused or timed out`);
    detected = r.found.base_url;
    return { detail: `${r.found.base_url} answered GET /v1/models with HTTP ${r.found.http_status} (${r.found.status})`, evidence: { found: r.found } };
  });

  let cfg;
  try {
    cfg = readNightshiftConfig(env, { requireModel: false });
  } catch (err) {
    const why = err instanceof ConfigError ? err.message : String(err);
    for (const n of ["GET /v1/models with token", "real chat completion", "invalid token is rejected"]) s.block(n, why);
    return report("nightshift", started, s);
  }
  if (detected && normalizeBaseUrl(cfg.baseUrl) !== detected) {
    s.steps.push({ name: "configured URL matches detected runtime", status: "FAIL", detail: `METERLESS_BASE_URL normalizes to ${normalizeBaseUrl(cfg.baseUrl)}, runtime found at ${detected}` });
  }
  const client = new NightshiftClient(cfg);
  let models: string[] = [];
  const online = await s.run("GET /v1/models with token", async () => {
    const d = await client.discover();
    if (d.status !== "online") throw new Error(`${d.status}${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ""}: ${d.detail ?? ""}`);
    models = d.models;
    return { detail: `online; ${d.models.length} model ids: ${d.models.join(", ")}`, evidence: { models: d.models } };
  });
  const modelOk = online && cfg.model !== "" && models.includes(cfg.model);
  if (online && !modelOk) {
    s.steps.push({ name: "configured METERLESS_MODEL is listed", status: "FAIL", detail: `${cfg.model ? `${cfg.model} is not listed` : "METERLESS_MODEL is not set"}; choose one of: ${models.join(", ")}` });
  }
  if (modelOk) {
    await s.run(`real chat completion (${cfg.model})`, async () => {
      const r = await client.chat([{ role: "user", content: "Reply with one short sentence confirming this connection works." }]);
      if (!r.content.trim()) throw new Error("empty reply");
      return {
        detail: `HTTP ${r.httpStatus} in ${r.durationMs} ms; reply "${r.content.slice(0, 120)}"; model reported: ${r.modelReported ?? "not reported"}`,
        evidence: { model_requested: r.modelRequested, model_reported: r.modelReported, meterless: r.meterless, routing_headers: r.routingHeaders, response_id: r.responseId, usage: r.usage, finish_reason: r.finishReason, attempts: r.attempts },
      };
    });
  } else s.block("real chat completion", online ? "METERLESS_MODEL is not a listed routing mode" : "GET /v1/models did not report online");

  await s.run("invalid token is rejected", async () => {
    const d = await new NightshiftClient({ ...cfg, token: "shortstop-deliberately-invalid-token" }).discover();
    if (d.status !== "unauthorized") throw new Error(`expected unauthorized, got ${d.status} (HTTP ${d.httpStatus ?? "none"})`);
    return { detail: `HTTP ${d.httpStatus} → unauthorized` };
  });
  return report("nightshift", started, s);
}

export async function checkZetaris(env: Env): Promise<CheckReport> {
  const started = new Date();
  const s = new Steps();
  const names = presence(env, ["ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY"]);
  s.steps.push({
    name: "configuration (names only)",
    status: names.missing.length || names.placeholder.length ? "FAIL" : "PASS",
    detail: `set: [${names.set.join(", ")}] missing: [${names.missing.join(", ")}] placeholder: [${names.placeholder.join(", ")}]`,
  });
  const restUrl = (env.ZETARIS_REST_URL?.trim() || "http://localhost:8888/api/v1.0").replace(/\/+$/, "");
  await s.run(`REST API reachable (${restUrl})`, async () => {
    try {
      const res = await fetch(`${restUrl}/sql-editor/sqls/run`, { method: "GET", signal: AbortSignal.timeout(5000) });
      return { detail: `HTTP ${res.status} (any HTTP answer proves the API is up; auth is checked next)` };
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new Error(`no HTTP answer${code ? ` (${code})` : ""}; is Zetaris running (docker compose ps in zetaris-platform)?`);
    }
  });

  let cfg;
  try {
    cfg = readZetarisConfig(env);
  } catch (err) {
    const why = err instanceof ConfigError ? err.message : String(err);
    for (const n of ["GET /datasource/datasources", "SELECT 1", "SHOW LIGHTNING DATABASES"]) s.block(n, why);
    return report("zetaris", started, s);
  }
  const z = new ZetarisClient({ ...cfg, maxRetries: 0 });
  await s.run("GET /datasource/datasources", async () => {
    const r = await z.get("/datasource/datasources");
    const n = Array.isArray(r.body) ? r.body.length : Array.isArray((r.body as { data?: unknown })?.data) ? ((r.body as { data: unknown[] }).data.length) : null;
    return { detail: `HTTP ${r.httpStatus}${n !== null ? `, ${n} datasources` : ""}`, evidence: { body_keys: r.body && typeof r.body === "object" ? Object.keys(r.body) : typeof r.body } };
  });
  await s.run("SELECT 1", async () => {
    const r = await z.query("SELECT 1 AS one", ["one"] as const);
    if (String(r.rows[0]?.one) !== "1") throw new Error(`unexpected result ${JSON.stringify(r.rows)}`);
    return { detail: `HTTP ${r.httpStatus} in ${r.durationMs} ms; response keys [${r.responseKeys.join(", ")}]`, evidence: { response_keys: r.responseKeys } };
  });
  await s.run("SHOW LIGHTNING DATABASES", async () => {
    const r = await z.execute("SHOW LIGHTNING DATABASES");
    return { detail: `${r.rowCount} rows: ${JSON.stringify(r.rows).slice(0, 400)}`, evidence: { rows: r.rows, extra: r.extra } };
  });
  return report("zetaris", started, s);
}

// Optional: checks the tables ShortStop reads, once they are registered.
export async function checkZetarisTables(env: Env): Promise<CheckReport> {
  const started = new Date();
  const s = new Steps();
  let cfg;
  try {
    cfg = readZetarisConfig(env);
  } catch (err) {
    s.block("table checks", (err as Error).message);
    return report("zetaris-tables", started, s);
  }
  const z = new ZetarisClient({ ...cfg, maxRetries: 0 });
  for (const [key, table] of Object.entries(cfg.tables)) {
    await s.run(`${key}: SELECT count(*) FROM ${table}`, async () => {
      const r = await z.query(`SELECT count(*) AS n FROM ${table}`, ["n"] as const);
      return { detail: `${String(r.rows[0]?.n)} rows`, evidence: { table, count: r.rows[0]?.n } };
    });
  }
  await s.run("cross-source join: formulary × openFDA shortages", async () => {
    const r = await z.query(
      `SELECT f.item_id, f.ndc, s.package_ndc, s.availability, s.update_date FROM ${cfg.tables.formulary} f JOIN ${cfg.tables.shortages} s ON s.package_ndc = f.ndc`,
      ["item_id", "ndc", "package_ndc", "availability", "update_date"] as const
    );
    return { detail: `${r.rowCount} joined rows: ${JSON.stringify(r.rows).slice(0, 500)}`, evidence: { rows: r.rows } };
  });
  return report("zetaris-tables", started, s);
}

export function checkPostgres(): CheckReport {
  const started = new Date();
  const s = new Steps();
  const bin = ["/Library/PostgreSQL/17/bin/pg_isready", "pg_isready"].find((b) => !b.includes("/") || fs.existsSync(b));
  try {
    const out = execFileSync(bin ?? "pg_isready", ["-h", "127.0.0.1", "-p", "5432"], { encoding: "utf-8", timeout: 5000 }).trim();
    s.steps.push({ name: "PostgreSQL accepting connections (pg_isready)", status: "PASS", detail: out });
  } catch (err) {
    s.steps.push({ name: "PostgreSQL accepting connections (pg_isready)", status: "FAIL", detail: (err as Error).message.split("\n")[0] ?? "" });
  }
  return report("postgres", started, s);
}

export function saveReport(dir: string, r: CheckReport): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `check-${r.target}-${r.started_at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
  return file;
}
