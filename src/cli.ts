// ShortStop command line.
//   npm run shortstop -- run --input input_examples/scenario-1-furosemide.json
//   npm run shortstop -- run --ndc 0409-6102-26 --as-of 2026-10-24
//   npm run shortstop -- review --run <run_id> --decision <decision_id> --outcome approved --reviewer "A. Pharmacist" --note "..."
//   npm run shortstop -- precedents [--item FUR-INJ-40]
//   npm run shortstop -- check nightshift | zetaris | zetaris-tables | postgres | all   (real services only)
//   npm run shortstop -- seed-postgres [--yes]        npm run shortstop -- register openfda|hospital [--yes] [--skip-exists]

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { checkNightshift, checkPostgres, checkZetaris, checkZetarisTables, saveReport, type CheckReport } from "./checks.ts";
import { hospitalStatements, openfdaStatements, postgresTargetFromEnv, printable, runStatements, seedPostgres } from "./setup/registration.ts";
import { buildDeps, loadRun, openMemory, saveRun, stateDirFor } from "./app.ts";
import { loadConfig, loadDotEnv, readZetarisConfig } from "./config.ts";
import { Tracer } from "./trace/tracer.ts";
import { recordReview, ReviewStore } from "./workflow/review.ts";
import { newRunId, runWorkflow, type RunInput, type RunOutput } from "./workflow/run.ts";
import type { ReviewOutcome } from "./domain/types.ts";

function usage(): never {
  console.error(fs.readFileSync(new URL(import.meta.url), "utf-8").split("\n").slice(0, 7).join("\n"));
  process.exit(2);
}

function printRun(run: RunOutput, runFile: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(`ShortStop ${run.run_id}  [${run.mode.toUpperCase()} MODE]  status=${run.status}`);
  console.log(run.notice);
  if (run.error) console.log(`ERROR ${run.error.type}: ${run.error.message}`);
  for (const d of run.decisions) {
    console.log("-".repeat(78));
    console.log(`${d.decision_id}\n  ${d.item.item_id} ${d.item.description}`);
    console.log(`  shortage: ${d.shortage.presentation} | availability "${d.shortage.availability_raw}" | updated ${d.shortage.update_date ?? d.shortage.update_date_raw}`);
    console.log(`  exposure: ${d.exposure.status} | ${d.exposure.calculation}`);
    for (const l of d.exposure.locations) {
      console.log(`    ${l.location_id.padEnd(8)} on hand ${String(l.on_hand_units ?? "?").padStart(4)}  avg/day ${String(l.avg_daily_usage ?? "?").padStart(5)}  DOH ${String(l.days_on_hand ?? "-").padStart(6)}  ${l.status}`);
    }
    console.log(`  precedents: ${d.precedents.map((p) => `${p.memory_id} ${p.outcome} ${p.action}`).join("; ") || "none"}${d.superseded_precedents.length ? ` | superseded: ${d.superseded_precedents.map((p) => p.memory_id).join(", ")}` : ""}`);
    console.log(`  STATUS: ${d.status} (revisions: ${d.revisions}, rejected candidates: ${d.rejected_candidates.length})`);
    for (const c of d.candidates) console.log(`    - ${c.action}${c.policy_id ? ` [${c.policy_id}]` : ""}${c.target_item_id ? ` -> ${c.target_item_id}` : ""}: ${c.rationale}\n      evidence: ${c.evidence_ids.join(", ")}`);
    for (const r of d.escalation_reasons) console.log(`    ! ${r}`);
  }
  if (run.decisions.length === 0 && run.status === "success") console.log("No affected formulary items for this input.");
  console.log("-".repeat(78));
  console.log(`run file:   ${runFile}\ntrace file: ${run.trace_file}`);
  console.log("All decisions require pharmacist review: npm run shortstop -- review --run <run_id> --decision <decision_id> ...");
}

async function cmdRun(args: string[]) {
  const { values } = parseArgs({ args, options: { input: { type: "string" }, ndc: { type: "string" }, "as-of": { type: "string" }, sweep: { type: "boolean" } } });
  let input: RunInput;
  if (values.input) {
    const body = JSON.parse(fs.readFileSync(values.input, "utf-8")) as { scenario_id?: string; input: RunInput };
    input = { ...body.input, ...(body.scenario_id ? { scenario_id: body.scenario_id } : {}) };
  } else if (values.ndc || values.sweep) {
    input = { as_of: values["as-of"] ?? new Date().toISOString().slice(0, 10), trigger: values.ndc ? { package_ndc: values.ndc } : { sweep: true } };
  } else usage();
  const cfg = loadConfig();
  const runId = input.run_id ?? newRunId();
  const deps = await buildDeps(cfg, runId);
  if (deps.nightshift) {
    // Fail fast on a dead or unauthorized runtime instead of mid-run.
    const d = await deps.nightshift.discover();
    deps.tracer.emit({ stage: "SETUP", agent: "NightshiftAdapter", action: "discover", status: d.status === "online" ? "success" : "failure", summary: `runtime ${d.status}${d.detail ? `: ${d.detail}` : ""}`, external: { service: "nightshift", endpoint: "GET /v1/models", ...(d.httpStatus ? { http_status: d.httpStatus } : {}) }, details: { models: d.models } });
    if (d.status !== "online") throw new Error(`Nightshift is ${d.status}: ${d.detail ?? ""}`);
  }
  const run = await runWorkflow(input, deps);
  const file = saveRun(deps.runsDir, run);
  printRun(run, file);
  process.exitCode = run.status === "success" ? 0 : 1;
}

async function cmdReview(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { run: { type: "string" }, decision: { type: "string" }, outcome: { type: "string" }, reviewer: { type: "string" }, note: { type: "string", default: "" }, wrong: { type: "string", multiple: true } },
  });
  if (!values.run || !values.decision || !values.outcome || !values.reviewer) usage();
  if (!["approved", "rejected", "acknowledged"].includes(values.outcome)) throw new Error("--outcome must be approved, rejected or acknowledged");
  const cfg = loadConfig();
  const stateDir = stateDirFor(cfg);
  const run = loadRun(path.join(stateDir, "runs"), values.run);
  const tracer = new Tracer({ runId: run.run_id, mode: run.mode, logDir: cfg.logDir, echo: true });
  const rec = recordReview(
    run,
    { decision_id: values.decision, outcome: values.outcome as ReviewOutcome, reviewer: values.reviewer, note: values.note ?? "", ...(values.wrong ? { wrong_precedents: values.wrong } : {}) },
    { memory: openMemory(cfg), store: new ReviewStore(stateDir), tracer }
  );
  console.log(JSON.stringify(rec, null, 2));
}

function cmdPrecedents(args: string[]) {
  const { values } = parseArgs({ args, options: { item: { type: "string" } } });
  const memory = openMemory(loadConfig());
  const list = values.item ? memory.forItem(values.item) : memory.all();
  for (const p of list) {
    console.log(`${p.memory_id} ${p.item_id} ${p.outcome} ${p.action}${p.policy_id ? ` ${p.policy_id}` : ""} conf=${p.confidence}${p.superseded_by ? ` superseded_by=${p.superseded_by}` : ""}${p.supersedes ? ` supersedes=${p.supersedes}` : ""}\n  ${p.content}\n  provenance: ${p.provenance_label} (${p.source_ref})`);
    for (const e of memory.history(p.memory_id)) console.log(`    ${new Date(e.timestamp).toISOString()} ${e.action} by ${e.actor}${e.details ? ` ${JSON.stringify(e.details)}` : ""}`);
  }
}

// Live integration checks against the real services. Reports are saved
// (redacted) under evidence/ so a result can be shown without re-running it.
async function cmdCheck(args: string[]) {
  const target = args[0];
  const targets = target === "all" ? ["nightshift", "zetaris", "postgres"] : [target];
  let ok = true;
  for (const t of targets) {
    const r =
      t === "nightshift" ? await checkNightshift(process.env)
      : t === "zetaris" ? await checkZetaris(process.env)
      : t === "zetaris-tables" ? await checkZetarisTables(process.env)
      : t === "postgres" ? checkPostgres()
      : usage();
    for (const step of r.steps) console.log(`${step.status.padEnd(7)} ${t}: ${step.name} — ${step.detail}`);
    console.log(`        evidence: ${path.relative(process.cwd(), saveReport("evidence", r))}`);
    ok &&= r.ok;
  }
  process.exitCode = ok ? 0 : 1;
}

// Registers the Zetaris sources. Dry run unless --yes is given.
async function cmdRegister(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yes: { type: "boolean" }, "skip-exists": { type: "boolean" } } });
  const which = positionals[0];
  const statements =
    which === "openfda" ? openfdaStatements()
    : which === "hospital" ? hospitalStatements(postgresTargetFromEnv(process.env))
    : usage();
  for (const st of statements) console.log(`-- [${st.id}]\n${printable(st)}\n`);
  if (!values.yes) {
    console.log(`DRY RUN: ${statements.length} statement(s) above were not sent. Re-run with --yes to execute them against Zetaris.`);
    return;
  }
  const z = new ZetarisClient({ ...readZetarisConfig(process.env), maxRetries: 0 });
  const results = await runStatements(z, statements, { skipExists: Boolean(values["skip-exists"]) });
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(14)} ${r.id}: ${r.detail}`);
  const report = { target: `register-${which}`, started_at: new Date().toISOString(), steps: results.map((r) => ({ name: r.id, status: r.status === "failed" ? "FAIL" : "PASS", detail: r.detail })), ok: results.length === statements.length && results.every((r) => r.status !== "failed") } as CheckReport;
  console.log(`evidence: ${path.relative(process.cwd(), saveReport("evidence", report))}`);
  process.exitCode = report.ok ? 0 : 1;
}

// Loads the SYNTHETIC hospital data into local PostgreSQL. Needs --yes.
function cmdSeedPostgres(args: string[]) {
  const { values } = parseArgs({ args, options: { yes: { type: "boolean" } } });
  if (!values.yes) {
    console.log("This creates database shortstop_synthetic (if missing) and replaces its formulary, inventory, usage and policies tables with SYNTHETIC data, using PGUSER/PGPASSWORD from your environment. Re-run with --yes.");
    return;
  }
  for (const line of seedPostgres(process.env)) console.log(line);
}

async function main() {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "run") await cmdRun(rest);
  else if (cmd === "review") await cmdReview(rest);
  else if (cmd === "precedents") cmdPrecedents(rest);
  else if (cmd === "check") await cmdCheck(rest);
  else if (cmd === "register") await cmdRegister(rest);
  else if (cmd === "seed-postgres") cmdSeedPostgres(rest);
  else usage();
}

main().catch((err) => {
  console.error(`ERROR ${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
});
