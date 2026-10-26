// HTTP server for the ShortStop web UI. Serves web/ and a small JSON API backed
// by the same workflow, data sources, memory and review code as the CLI.
//   npm run ui                 (mode from SAMPLE_MODE in .env)
//   npm run ui:sample          (forces sample mode)
// Runs stream their trace events to the browser over Server-Sent Events. One
// run at a time: the H-MEM store is a local file. No configuration value is
// ever sent to the browser; trace events are already redacted.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NightshiftClient } from "./adapters/nightshift.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { buildDeps, loadRun, openMemory, saveRun, stateDirFor } from "./app.ts";
import { loadConfig, loadDotEnv, type AppConfig } from "./config.ts";
import type { ReviewOutcome } from "./domain/types.ts";
import { Tracer } from "./trace/tracer.ts";
import { recordReview, ReviewError, ReviewStore } from "./workflow/review.ts";
import { LIVE_NOTICE, newRunId, runWorkflow, SAMPLE_NOTICE, type RunInput, type RunOutput } from "./workflow/run.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const WEB_DIR = path.join(repoRoot, "web");
const EXAMPLES_DIR = path.join(repoRoot, "input_examples");

interface RunState {
  run_id: string;
  scenario_id?: string;
  status: "running" | "done" | "error";
  started_at: string;
  events: Record<string, unknown>[];
  output?: RunOutput;
  error?: string;
  listeners: Set<http.ServerResponse>;
}

export interface ServerOptions {
  config: AppConfig;
  // Overridable in tests.
  runWorkflow?: typeof runWorkflow;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}

function listScenarios(): { scenario_id: string; description: string; expected_outcome?: string; input: RunInput }[] {
  return fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), "utf-8")));
}

function summarize(run: RunOutput, reviews: ReviewStore) {
  return {
    run_id: run.run_id,
    mode: run.mode,
    status: run.status,
    scenario_id: run.scenario_id ?? null,
    started_at: run.started_at,
    execution_time_seconds: run.execution_time_seconds,
    data_source: run.data_source,
    error: run.error ?? null,
    decisions: run.decisions.map((d) => {
      const review = reviews.forDecision(d.decision_id);
      return {
        decision_id: d.decision_id,
        item_id: d.item.item_id,
        description: d.item.description,
        status: d.status,
        candidates: d.candidates.length,
        days_on_hand: d.exposure.days_on_hand,
        review: review ? { outcome: review.outcome, reviewer: review.reviewer, reviewed_at: review.reviewed_at } : null,
      };
    }),
  };
}

export function createServer(opts: ServerOptions): http.Server {
  const cfg = opts.config;
  const run = opts.runWorkflow ?? runWorkflow;
  const stateDir = stateDirFor(cfg);
  const runsDir = path.join(stateDir, "runs");
  const reviews = new ReviewStore(stateDir);
  const runs = new Map<string, RunState>();
  let active: string | null = null;

  const broadcast = (state: RunState, event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of state.listeners) res.write(payload);
  };

  async function startRun(input: RunInput, scenarioId?: string): Promise<RunState> {
    if (active) throw new HttpError(409, `run ${active} is still in progress; wait for it to finish`);
    const runId = newRunId();
    const state: RunState = { run_id: runId, status: "running", started_at: new Date().toISOString(), events: [], listeners: new Set() };
    if (scenarioId) state.scenario_id = scenarioId;
    runs.set(runId, state);
    active = runId;
    const onEvent = (e: Record<string, unknown>) => {
      state.events.push(e);
      broadcast(state, "trace", e);
    };
    (async () => {
      try {
        const deps = await buildDeps(cfg, runId, { echo: false, onEvent });
        if (deps.nightshift) {
          const d = await deps.nightshift.discover();
          deps.tracer.emit({
            stage: "SETUP", agent: "NightshiftAdapter", action: "discover", status: d.status === "online" ? "success" : "failure",
            summary: `runtime ${d.status}${d.detail ? `: ${d.detail}` : ""}`, external: { service: "nightshift", endpoint: "GET /v1/models", ...(d.httpStatus ? { http_status: d.httpStatus } : {}) },
          });
          if (d.status !== "online") throw new Error(`Nightshift is ${d.status}: ${d.detail ?? ""}`);
        }
        const output = await run({ ...input, ...(scenarioId ? { scenario_id: scenarioId } : {}) }, deps);
        saveRun(deps.runsDir, output);
        state.output = output;
        state.status = output.status === "success" ? "done" : "error";
        if (output.error) state.error = output.error.message;
      } catch (err) {
        state.status = "error";
        state.error = `${(err as Error).name}: ${(err as Error).message}`;
      } finally {
        active = null;
        broadcast(state, "complete", { status: state.status, error: state.error ?? null, run_id: runId });
        for (const res of state.listeners) res.end();
        state.listeners.clear();
      }
    })();
    return state;
  }

  function getRun(runId: string): RunOutput {
    const mem = runs.get(runId);
    if (mem?.output) return mem.output;
    if (!/^[\w-]+$/.test(runId)) throw new HttpError(400, "invalid run id");
    try {
      return loadRun(runsDir, runId);
    } catch {
      throw new HttpError(404, `run ${runId} not found`);
    }
  }

  async function health() {
    const out: Record<string, unknown> = { mode: cfg.mode, checked_at: new Date().toISOString() };
    const memory = openMemory(cfg);
    out.hmem = { status: "ok", precedents: memory.all().length, ledger_entries: memory.hmem.ledger.all().length };
    if (cfg.mode === "sample" || !cfg.zetaris || !cfg.nightshift) {
      out.zetaris = { status: "not_used", detail: "sample mode makes no Zetaris query" };
      out.nightshift = { status: "not_used", detail: "sample mode makes no Nightshift call" };
      return out;
    }
    const t0 = Date.now();
    try {
      await new ZetarisClient({ ...cfg.zetaris, maxRetries: 0, timeoutMs: 10_000 }).query("SELECT 1 AS one", ["one"] as const);
      out.zetaris = { status: "ok", latency_ms: Date.now() - t0 };
    } catch (err) {
      out.zetaris = { status: "down", detail: (err as Error).message };
    }
    const t1 = Date.now();
    const d = await new NightshiftClient({ ...cfg.nightshift, timeoutMs: 10_000 }).discover();
    out.nightshift = d.status === "online"
      ? { status: "ok", latency_ms: Date.now() - t1, models: d.models.length, nemotron_models: d.models.filter((m) => m.startsWith("nvidia/nemotron")).length }
      : { status: d.status === "unauthorized" ? "unauthorized" : "down", detail: d.detail ?? null };
    return out;
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
    const method = req.method ?? "GET";

    if (method === "GET" && parts[0] === "meta") {
      return sendJson(res, 200, {
        mode: cfg.mode,
        notice: cfg.mode === "sample" ? SAMPLE_NOTICE : LIVE_NOTICE,
        max_revisions: cfg.maxRevisions,
        max_candidates: cfg.maxCandidates,
        active_run: active,
      });
    }
    if (method === "GET" && parts[0] === "health") return sendJson(res, 200, await health());
    if (method === "GET" && parts[0] === "scenarios") return sendJson(res, 200, listScenarios());

    if (parts[0] === "runs" && parts.length === 1) {
      if (method === "GET") {
        const saved = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")) : [];
        const list = saved
          .map((f) => {
            try {
              return summarize(JSON.parse(fs.readFileSync(path.join(runsDir, f), "utf-8")) as RunOutput, reviews);
            } catch {
              return null;
            }
          })
          .filter(Boolean) as ReturnType<typeof summarize>[];
        const running = [...runs.values()].filter((r) => r.status === "running").map((r) => ({ run_id: r.run_id, mode: cfg.mode, status: "running", scenario_id: r.scenario_id ?? null, started_at: r.started_at, decisions: [] }));
        const all = [...running, ...list].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
        return sendJson(res, 200, all);
      }
      if (method === "POST") {
        const body = await readBody(req);
        let input: RunInput;
        let scenarioId: string | undefined;
        if (typeof body.scenario_id === "string") {
          const sc = listScenarios().find((s) => s.scenario_id === body.scenario_id);
          if (!sc) throw new HttpError(404, `unknown scenario ${body.scenario_id}`);
          input = sc.input;
          scenarioId = sc.scenario_id;
        } else if (typeof body.package_ndc === "string") {
          if (!/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(body.package_ndc)) throw new HttpError(400, "package_ndc must look like 0409-6102-26");
          const asOf = typeof body.as_of === "string" ? body.as_of : new Date().toISOString().slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new HttpError(400, "as_of must be YYYY-MM-DD");
          input = { as_of: asOf, trigger: { package_ndc: body.package_ndc } };
        } else throw new HttpError(400, "send scenario_id or package_ndc");
        const state = await startRun(input, scenarioId);
        return sendJson(res, 202, { run_id: state.run_id, mode: cfg.mode });
      }
    }

    if (parts[0] === "runs" && parts[1]) {
      const runId = parts[1];
      if (method === "GET" && parts.length === 2) {
        const mem = runs.get(runId);
        if (mem && mem.status === "running") return sendJson(res, 200, { run_id: runId, status: "running", events: mem.events });
        const r = getRun(runId);
        const rv = Object.fromEntries(r.decisions.map((d) => [d.decision_id, reviews.forDecision(d.decision_id) ?? null]));
        return sendJson(res, 200, { ...r, reviews: rv });
      }
      if (method === "GET" && parts[2] === "events") {
        const state = runs.get(runId);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        if (!state) {
          // A finished run from an earlier server process: replay its trace file.
          const r = getRun(runId);
          const file = r.trace_file ? path.resolve(repoRoot, r.trace_file) : null;
          const lines = file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean) : [];
          for (const l of lines) res.write(`event: trace\ndata: ${l}\n\n`);
          res.write(`event: complete\ndata: ${JSON.stringify({ status: r.status === "success" ? "done" : "error", run_id: runId, replay: true })}\n\n`);
          return void res.end();
        }
        for (const e of state.events) res.write(`event: trace\ndata: ${JSON.stringify(e)}\n\n`);
        if (state.status !== "running") {
          res.write(`event: complete\ndata: ${JSON.stringify({ status: state.status, error: state.error ?? null, run_id: runId })}\n\n`);
          return void res.end();
        }
        state.listeners.add(res);
        req.on("close", () => state.listeners.delete(res));
        return;
      }
      if (method === "POST" && parts[2] === "decisions" && parts[3] && parts[4] === "review") {
        if (active) throw new HttpError(409, "a run is in progress; review after it finishes");
        const body = await readBody(req);
        const outcome = body.outcome;
        if (outcome !== "approved" && outcome !== "rejected" && outcome !== "acknowledged") throw new HttpError(400, "outcome must be approved, rejected or acknowledged");
        const r = getRun(runId);
        const tracer = new Tracer({ runId: r.run_id, mode: r.mode, logDir: cfg.logDir });
        try {
          const rec = recordReview(
            r,
            {
              decision_id: decodeURIComponent(parts[3]),
              outcome: outcome as ReviewOutcome,
              reviewer: typeof body.reviewer === "string" ? body.reviewer : "",
              note: typeof body.note === "string" ? body.note : "",
              ...(Array.isArray(body.wrong_precedents) ? { wrong_precedents: body.wrong_precedents.filter((x): x is string => typeof x === "string") } : {}),
            },
            { memory: openMemory(cfg), store: reviews, tracer }
          );
          return sendJson(res, 200, rec);
        } catch (err) {
          if (err instanceof ReviewError) throw new HttpError(400, err.message);
          throw err;
        }
      }
    }

    if (method === "GET" && parts[0] === "precedents") {
      const memory = openMemory(cfg);
      const item = url.searchParams.get("item");
      const list = item ? memory.forItem(item) : memory.all();
      return sendJson(res, 200, list.map((p) => ({ ...p, history: memory.history(p.memory_id) })));
    }

    throw new HttpError(404, `no API route for ${method} ${url.pathname}`);
  }

  function serveStatic(res: http.ServerResponse, url: URL): void {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) && file !== WEB_DIR) throw new HttpError(403, "forbidden");
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(WEB_DIR, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(target).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else serveStatic(res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
      else res.end();
    }
  });
}
