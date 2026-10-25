// LIVE integration tests against the real Zetaris and Nightshift services.
//   npm run test:live
// Excluded from `npm test`. Nothing is mocked. When a service is not running
// these tests FAIL (they never skip), so a green run is evidence that the real
// services answered. A redacted copy of each result is written to evidence/.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeps, saveRun } from "../../src/app.ts";
import { checkNightshift, checkZetaris, checkZetarisTables, saveReport } from "../../src/checks.ts";
import { loadConfig, loadDotEnv } from "../../src/config.ts";
import { normalizeNdc } from "../../src/domain/ndc.ts";
import { newRunId, runWorkflow, type RunInput } from "../../src/workflow/run.ts";

loadDotEnv();
const EVIDENCE = "evidence";
const passed = (r: Awaited<ReturnType<typeof checkNightshift>>) => {
  saveReport(EVIDENCE, r);
  const failed = r.steps.filter((s) => s.status !== "PASS").map((s) => `${s.status} ${s.name}: ${s.detail}`);
  expect(failed, failed.join("\n")).toEqual([]);
};

describe("LIVE: Meterless Nightshift", () => {
  it("auto-detects the runtime, lists models, completes a real request and rejects a bad token", async () => {
    passed(await checkNightshift(process.env));
  }, 300_000);
});

describe("LIVE: Zetaris", () => {
  it("authenticates and runs SELECT 1 and SHOW LIGHTNING DATABASES", async () => {
    passed(await checkZetaris(process.env));
  }, 120_000);

  it("reads every registered ShortStop table and joins formulary to openFDA shortages", async () => {
    const r = await checkZetarisTables(process.env);
    passed(r);
    const join = r.steps.find((s) => s.name.startsWith("cross-source join"))!;
    const rows = (join.evidence?.rows ?? []) as { ndc: string; package_ndc: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const a = normalizeNdc(row.ndc);
      const b = normalizeNdc(row.package_ndc);
      expect(a.ok && b.ok && a.ndc11 === b.ndc11).toBe(true);
    }
  }, 300_000);
});

describe("LIVE: end-to-end ShortStop run", () => {
  it("runs scenario 1 through Zetaris and Nightshift and stops at pharmacist review", async () => {
    const cfg = loadConfig({ ...process.env, SAMPLE_MODE: "false" });
    const runId = newRunId();
    const deps = await buildDeps(cfg, runId, { echo: true });
    const input = (JSON.parse(fs.readFileSync("input_examples/scenario-1-furosemide.json", "utf-8")) as { input: RunInput }).input;
    const run = await runWorkflow({ ...input, scenario_id: "scenario-1-furosemide (live)" }, deps);
    saveRun(deps.runsDir, run);
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, `live-run-${runId}.json`), JSON.stringify(run, null, 2) + "\n");
    fs.copyFileSync(deps.tracer.file!, path.join(EVIDENCE, `live-trace-${runId}.jsonl`));

    expect(run.status, JSON.stringify(run.error)).toBe("success");
    expect(run.mode).toBe("live");
    expect(run.data_source).toBe("zetaris");
    const events = deps.tracer.all();
    expect(events.every((e) => e.mode === "live")).toBe(true);
    const ok = (svc: string) => events.some((e) => e.external_call === true && (e.external as { service: string }).service === svc && e.status === "success");
    expect(ok("zetaris")).toBe(true);
    expect(ok("nightshift")).toBe(true);
    expect(events.some((e) => JSON.stringify(e).includes('"retrieved_via":"sample-file"'))).toBe(false);

    expect(run.decisions.length).toBeGreaterThan(0);
    for (const d of run.decisions) {
      expect(d.requires_human_review).toBe(true);
      expect(["PENDING_APPROVAL", "ESCALATED", "MONITOR_PENDING_ACKNOWLEDGEMENT"]).toContain(d.status);
      const ids = new Set(d.evidence.map((e) => e.evidence_id));
      for (const c of d.candidates) for (const id of c.evidence_ids) expect(ids.has(id)).toBe(true);
      expect(d.shortage.provenance.retrieved_via).toBe("zetaris");
      if (d.status !== "MONITOR_PENDING_ACKNOWLEDGEMENT") expect(d.model_calls.length).toBeGreaterThan(0);
    }
  }, 900_000);
});
