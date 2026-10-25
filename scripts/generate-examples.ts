// Runs the three sample scenarios from a clean state and writes their outputs
// and traces to output_examples/. Sample mode only: these files show the
// deterministic sample agents, not a live Nightshift or Zetaris run.
//   npm run examples

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeps, saveRun } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { runWorkflow, type RunInput } from "../src/workflow/run.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "output_examples");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-examples-"));
const cfg = loadConfig({ SAMPLE_MODE: "true", SHORTSTOP_STATE_DIR: path.join(tmp, "var"), SHORTSTOP_LOG_DIR: path.join(tmp, "logs") });
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(path.join(root, "input_examples")).filter((f) => f.endsWith(".json")).sort()) {
  const body = JSON.parse(fs.readFileSync(path.join(root, "input_examples", file), "utf-8")) as { scenario_id: string; input: RunInput };
  const runId = `example-${body.scenario_id}`;
  const deps = await buildDeps(cfg, runId, { echo: false });
  const run = await runWorkflow({ ...body.input, scenario_id: body.scenario_id }, deps);
  saveRun(deps.runsDir, run);
  const name = body.scenario_id;
  fs.writeFileSync(path.join(outDir, `${name}.output.json`), JSON.stringify({ ...run, trace_file: `output_examples/${name}.trace.jsonl` }, null, 2) + "\n");
  fs.copyFileSync(deps.tracer.file!, path.join(outDir, `${name}.trace.jsonl`));
  console.log(`${name}: ${run.decisions.map((d) => `${d.item.item_id}=${d.status}`).join(", ")}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
