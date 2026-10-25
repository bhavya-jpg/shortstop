// Wires configuration to concrete dependencies. Sample mode and live mode use
// separate state folders so sample precedents never mix with live ones.

import fs from "node:fs";
import path from "node:path";
import { NightshiftClient } from "./adapters/nightshift.ts";
import { NightshiftCritic, NightshiftPlanner, nightshiftTransport } from "./agents/llm.ts";
import { CompositeCritic, DeterministicPolicyPlanner, PrecedentCritic } from "./agents/sample.ts";
import type { AppConfig } from "./config.ts";
import { ConfigError } from "./config.ts";
import { SampleDataSource, ZetarisDataSource } from "./data/sources.ts";
import { PrecedentMemory } from "./memory/precedents.ts";
import { seedPrecedents, seedSyntheticPrecedents } from "./memory/seed.ts";
import { Tracer } from "./trace/tracer.ts";
import { ReviewStore } from "./workflow/review.ts";
import type { RunOutput, WorkflowDeps } from "./workflow/run.ts";

export interface AppDeps extends WorkflowDeps {
  reviews: ReviewStore;
  runsDir: string;
  nightshift?: NightshiftClient;
}

export function stateDirFor(cfg: AppConfig): string {
  return path.join(cfg.stateDir, cfg.mode);
}

export function openMemory(cfg: AppConfig): PrecedentMemory {
  return new PrecedentMemory({ persistDir: path.join(stateDirFor(cfg), "hmem") });
}

export async function buildDeps(cfg: AppConfig, runId: string, opts: { echo?: boolean } = {}): Promise<AppDeps> {
  const tracer = new Tracer({ runId, mode: cfg.mode, logDir: cfg.logDir, echo: opts.echo ?? true });
  const stateDir = stateDirFor(cfg);
  const memory = openMemory(cfg);
  const common = {
    mode: cfg.mode,
    maxRevisions: cfg.maxRevisions,
    maxCandidates: cfg.maxCandidates,
    memory,
    tracer,
    reviews: new ReviewStore(stateDir),
    runsDir: path.join(stateDir, "runs"),
  };

  if (cfg.mode === "sample") {
    const data = new SampleDataSource();
    // Sample mode starts from the synthetic precedent history.
    const seeded = seedPrecedents(memory, (await data.loadHospital()).formulary);
    tracer.emit({ stage: "SETUP", agent: "PrecedentMemory", action: "seed_synthetic_precedents", status: "info", summary: `seeded ${seeded.added}, already present ${seeded.skipped}` });
    return { ...common, data, planner: new DeterministicPolicyPlanner(), critic: new PrecedentCritic() };
  }

  if (!cfg.zetaris || !cfg.nightshift) throw new ConfigError("live mode needs Zetaris and Nightshift configuration");
  const nightshift = new NightshiftClient(cfg.nightshift);
  nightshift.onCall = (c) =>
    tracer.emit({
      stage: "MODEL_CALL",
      agent: "NightshiftAdapter",
      action: "http",
      status: c.error || (c.httpStatus ?? 0) >= 400 ? "failure" : "success",
      summary: c.error ? `request failed: ${c.error}` : `HTTP ${c.httpStatus} in ${c.durationMs} ms`,
      external: { service: "nightshift", endpoint: c.endpoint, attempts: c.attempt, duration_ms: c.durationMs, ...(c.httpStatus ? { http_status: c.httpStatus } : {}) },
    });
  const seeded = seedSyntheticPrecedents(memory);
  tracer.emit({
    stage: "SETUP", agent: "PrecedentMemory", action: "seed_synthetic_precedents", status: "info",
    summary: `live H-MEM: seeded ${seeded.added} SYNTHETIC precedents from data/synthetic/precedents.json, ${seeded.skipped} already present`,
  });
  const transport = nightshiftTransport(nightshift);
  return {
    ...common,
    data: new ZetarisDataSource(cfg.zetaris, tracer),
    planner: new NightshiftPlanner(transport),
    // The deterministic precedent critic always runs next to the LLM critic.
    critic: new CompositeCritic([new PrecedentCritic(), new NightshiftCritic(transport)]),
    nightshift,
  };
}

export function saveRun(runsDir: string, run: RunOutput): string {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `${run.run_id}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n", "utf-8");
  return file;
}

export function loadRun(runsDir: string, runId: string): RunOutput {
  const file = path.join(runsDir, `${runId}.json`);
  if (!fs.existsSync(file)) throw new Error(`run ${runId} not found in ${runsDir}`);
  return JSON.parse(fs.readFileSync(file, "utf-8")) as RunOutput;
}
