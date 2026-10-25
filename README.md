# ShortStop

ShortStop helps hospital pharmacy teams respond to drug shortages. It matches public openFDA shortage records to the hospital formulary, calculates stock exposure, recalls precedents, and checks every proposed response against the hospital's own policy records. The result is an auditable decision package that a pharmacist must review.

> **Demonstration system, not clinical decision support.** All hospital data, policies and precedents in this repository are **synthetic**. ShortStop never recommends doses, never makes patient-specific recommendations, and never places orders or sends messages. Every output waits for pharmacist approval, or is escalated.

Hackathon track: **Reasoning Architecture** (Open Agent Hackathon 2026).

## Status

The table lists only what has actually been verified. Live evidence is in [`output_examples/live/`](output_examples/live/); sample-mode output is in `output_examples/`.

| Component | Status | Evidence |
|---|---|---|
| Deterministic exposure, matching, policy validation | Working | `npm test` (unit tests) |
| H-MEM precedent memory (Meterless Engine) | Working | upstream conformance 13/13, upstream unit tests 10/10, ShortStop feature tests (`tests/memory`) |
| Sample-mode workflow (3 scenarios) | Working | `tests/workflow`, `output_examples/` |
| Human review → H-MEM feedback | Working | `tests/workflow` ("human review and memory feedback") |
| Zetaris data layer | **Verified live 2026-10-25**: auth, SQL, openFDA REST tables (1,142 rows, matching openFDA's own total), PostgreSQL datasource, and the cross-source join | `npm run shortstop -- check zetaris`, `check zetaris-tables`, `npm run test:live` |
| Meterless Nightshift (primary LLM gateway) | **Verified live 2026-10-25**: `/v1/models`, real completions, invalid token → 401, compute receipts recorded per call | `npm run shortstop -- check nightshift`, `npm run test:live` |
| Zetaris registration (`register openfda`, `register hospital`) | **Verified live**: all statements succeeded after one correction based on the service's error | `src/setup/registration.ts` |
| Live scenario 1 (furosemide) | **Verified live**: Zetaris data → H-MEM → Nemotron planner (3/3 candidates valid) → validator → Nemotron critic accepts → `PENDING_APPROVAL` | `output_examples/live/scenario-1-*`, `npm run test:live` |
| Live scenario 2 (sodium bicarbonate) | **Verified live**: 45 days of stock, planning skipped, no chat call → `MONITOR_PENDING_ACKNOWLEDGEMENT` | `output_examples/live/scenario-2-*` |
| Live scenario 3 (dexmedetomidine) | **Verified live**: ICU usage missing and conflicting precedents. Escalated by the validator's exposure rule, the deterministic precedent critic, the Nemotron critic and the planner → `ESCALATED` | `output_examples/live/scenario-3-*` |
| Zetaris restart after Docker stops | **Verified**: `docker compose stop` makes live runs fail explicitly; after `docker compose start`, `verify.sh` passes 9/9 and the registrations survive | see [Restarting Zetaris](#restarting-zetaris) |
| Live-mode failure handling | Working: explicit error, no fallback | `tests/adapters/failure-paths.test.ts` (real sockets) |
| NVIDIA Nemotron via Nightshift | **Every observed live call was served by `nvidia/nemotron-3.5-bolt-e4b`** (NVIDIA cloud), per Nightshift's compute receipts. ShortStop sends `meterless/auto` and does **not** pin a model. The documented class routes `meterless/text` and `meterless/judge` also resolved through `meterless/auto`. See [AI and model usage](#ai-and-model-usage) | `output_examples/live/nemotron-class-route-test.json` |

## Quick start (sample mode)

Sample mode runs without Zetaris, Nightshift or network access. It uses a bundled snapshot of real openFDA records, synthetic hospital data, and deterministic rule-based agents, and every output says so.

```bash
npm install
npm run check                      # typecheck + tests + H-MEM conformance
SAMPLE_MODE=true npm run shortstop -- run --input input_examples/scenario-1-furosemide.json
```

This prints the decision package and writes `var/sample/runs/<run_id>.json` and `logs/trace-<run_id>.jsonl`. To record a pharmacist decision:

```bash
SAMPLE_MODE=true npm run shortstop -- review --run <run_id> --decision <decision_id> \
  --outcome approved --reviewer "Pharmacist name" --note "why"
SAMPLE_MODE=true npm run shortstop -- precedents --item FUR-INJ-40   # memory and audit history
```

### Scenarios

| Input | What happens | Outcome |
|---|---|---|
| `scenario-1-furosemide` | Furosemide 40 mg/4 mL is Unavailable. Stock covers 2.55 days. Three in-force policies apply, and H-MEM holds a current precedent plus the one it superseded | `PENDING_APPROVAL`, 3 validated candidates |
| `scenario-2-sodium-bicarbonate` | The product is Unavailable nationally, but the hospital holds 45 days of stock | `MONITOR_PENDING_ACKNOWLEDGEMENT`, planner skipped |
| `scenario-3-dexmedetomidine` | ICU usage feed is missing. The openFDA record has no `openfda` block, and H-MEM holds conflicting precedents | `ESCALATED` |

## How it works

```
RETRIEVE_DATA → IDENTIFY_AFFECTED → CALCULATE_EXPOSURE ─┬─ adequate stock → MONITOR
                                                       └→ RECALL_PRECEDENTS (H-MEM) → BUILD_EVIDENCE
   → PLAN → VALIDATE (deterministic) → CRITIQUE ─┬─ accept   → PENDING_APPROVAL
        ↑                                        ├─ escalate → ESCALATED
        └──────── REVISE (≤ SHORTSTOP_MAX_REVISIONS) ─┘
   → HUMAN_REVIEW → H-MEM precedent + feedback
```

- **Matching** uses the exact normalized package NDC only. It handles the 4-4-2, 5-3-2 and 5-4-1 formats. Another package of the same product is flagged for confirmation and never joined. Names are never used to match.
- **Exposure** is deterministic. Missing usage or inventory means *unknown*, never zero. Zero usage means days-on-hand is undefined, not infinite. Stale or sparse data marks the result incomplete. No policy trigger can fire on incomplete data.
- **Permitted actions**: `RESTRICT_PER_POLICY`, `SWITCH_PRESENTATION`, `APPROVED_INTERCHANGE`, `ALTERNATE_SOURCING`, `ESCALATE`. Every action except `ESCALATE` must cite an active, in-date policy record for that item, and that policy's trigger must be met. A targeted action also needs a target with stock that openFDA doesn't report as unavailable.
- **Evidence IDs** are derived from the records themselves, for example `EV-POLICY-POL-FUR-001`. The validator rejects any cited ID that is not in the bundle, and any days-on-hand figure that doesn't match a computed value.
- **Agents.** The planner proposes and the validator decides admissibility. The critic can only make an outcome stricter. A deterministic precedent critic always runs alongside the LLM critic, so a model's "accept" cannot clear a precedent conflict.
- **Traces** (`logs/trace-<run_id>.jsonl`) record every stage, validation result, revision, escalation, H-MEM read and write, and review. Each event carries `mode` and `external_call`, and secrets are redacted.

## Sponsor technology

- **Meterless H-MEM** (vendored, unmodified, Apache-2.0; see `vendor/hmem/VENDORED.md`) stores precedents in `src/memory/precedents.ts`:
  - each precedent is a long-term record with provenance;
  - recall uses the engine's hybrid ranking, scoped to the item;
  - supersession marks the old record `supersededBy`, keeping it and penalizing it, never deleting it;
  - pharmacist outcomes apply the engine's documented feedback deltas;
  - every change goes to the append-only trust ledger.
- **Zetaris** is the live data layer (`src/data/sources.ts`, `src/adapters/zetaris.ts`). The openFDA shortage API is registered as two paged REST tables and a view, `shortstop.shortages_v`. The synthetic hospital tables are in PostgreSQL, registered as `hospital_pg`. One Zetaris query can join both.
- **Meterless Nightshift** is the only LLM gateway (`src/adapters/nightshift.ts`, `src/agents/llm.ts`). It follows provider contract v4: Bearer token, `meterless-app` and `meterless-scope` headers, routing modes discovered through `/v1/models`. Each call's `meterless.compute_receipt.v1` is stored, including the routed model, provider and token usage.

## Data sources

| Data | Source | Notes |
|---|---|---|
| Drug shortages | openFDA `drug/shortages` (real, [license](https://open.fda.gov/license/)) | `npm run data:openfda` refreshes `data/openfda/`, which also records an NDC Directory check per formulary NDC |
| Formulary, inventory, usage, policies, precedents | **Synthetic**, generated deterministically by `npm run data:synthetic` | NDCs are real FDA package codes, used only as join keys |

## Configuration

Copy `.env.example` to `.env`; never commit `.env`. `SAMPLE_MODE=true` selects sample mode. If `SAMPLE_MODE` is unset or `false`, ShortStop runs in live mode, and live mode fails with an explicit error if Zetaris or Nightshift is misconfigured or unreachable. It never falls back to sample data.

## Live setup (Zetaris + Nightshift)

Run each step only after the one before it passes. Every `check` prints PASS, FAIL or BLOCKED per step and saves a redacted report under `evidence/`.

1. **Nightshift.** Install the Mac edition from meterless.ai and launch it. Copy the Runtime URL and API key from its Console into `.env` as `METERLESS_BASE_URL` and `METERLESS_RUNTIME_TOKEN`.
   ```bash
   npm run shortstop -- check nightshift   # Auto Detect, /v1/models, then lists the routing modes
   ```
   Set `METERLESS_MODEL` to one of the listed modes and re-run. Passing means a real completion succeeded and an invalid token is rejected.
2. **Zetaris.** Follow the Participant Setup Guide: `docker compose up -d`, `./verify.sh` passing 9/9, and an API key created in the web UI. Put `ZETARIS_REST_URL`, `ZETARIS_ORG_ID` and `ZETARIS_API_KEY` in `.env`.
   ```bash
   npm run shortstop -- check zetaris      # /datasource/datasources, SELECT 1, SHOW LIGHTNING DATABASES
   ```
3. **Synthetic hospital data in PostgreSQL.** Put `PGUSER` and `PGPASSWORD` in `.env` or export them; they are never written anywhere.
   ```bash
   npm run shortstop -- seed-postgres          # explains what it will do
   npm run shortstop -- seed-postgres --yes
   ```
4. **Register the sources in Zetaris.** Without `--yes` this is a dry run that prints the statements, with the password redacted.
   ```bash
   npm run shortstop -- register openfda
   npm run shortstop -- register openfda --yes --skip-exists
   npm run shortstop -- register hospital --yes --skip-exists
   npm run shortstop -- check zetaris-tables   # row counts + the formulary × openFDA join
   ```
5. **Live run and evidence.**
   ```bash
   npm run test:live                           # real services only; fails, never skips, if one is down
   SAMPLE_MODE=false npm run shortstop -- run --input input_examples/scenario-1-furosemide.json
   ```

## Demo sequence

**Live (about 6 minutes of runtime; cut the model waits in the video).** Before recording, start Docker Desktop and Nightshift, and close any window showing `.env`.

```bash
npm run shortstop -- check all                       # Nightshift + Zetaris + Postgres, PASS per step
SAMPLE_MODE=false npm run shortstop -- run --input input_examples/scenario-1-furosemide.json      # PENDING_APPROVAL
SAMPLE_MODE=false npm run shortstop -- run --input input_examples/scenario-3-dexmedetomidine.json # ESCALATED
SAMPLE_MODE=false npm run shortstop -- review --run <run_id> --decision <decision_id> \
  --outcome approved --reviewer "Pharmacist (demo)" --note "why"                                    # writes H-MEM precedent
```

Point at the trace lines tagged `[zetaris /sql-editor/sqls/run 200]` and `[nightshift POST /v1/chat/completions 200]`, and at `model requested=meterless/auto reported=nvidia/nemotron-3.5-bolt-e4b`. Scenario 2 (`MONITOR`, about 8 s, no model call) shows that adequate stock skips planning.

**Fallback if a sponsor service is down during the demo: sample mode, labelled as such.** Run the same commands with `SAMPLE_MODE=true`. Every output and trace line then says `SAMPLE MODE` and that no Zetaris query and no Nightshift model call was made. Do not present it as a live run. The recorded live evidence in `output_examples/live/` can be shown alongside it.

## Restarting Zetaris

Zetaris stops when Docker Desktop quits. Verified on 2026-10-25:

```bash
open -a Docker                                   # if Docker Desktop is not running; wait for it to start
cd ~/zetaris-extracted/zetaris-platform          # your platform bundle folder
docker compose start                             # keeps data, registrations and API keys
./verify.sh                                      # expect: All 9 checks passed (about 1 minute after start)
cd -; npm run shortstop -- check zetaris && npm run shortstop -- check zetaris-tables
```

Do not use `docker compose down -v`: it deletes the data, the registrations and the encryption keys.

## AI and model usage

Models, all through Meterless Nightshift (the only model provider in the app):
- **Planner** (`NightshiftPlanner`): proposes candidate actions from the policy contract, exposure, evidence and precedents. It requests `meterless/auto`. In every live run, Nightshift routed it to `nvidia/nemotron-3.5-bolt-e4b`.
- **Critic** (`NightshiftCritic`): challenges validated candidates and can request a revision or escalate, never approve. Same routing observed.
- ShortStop does not pin a model. Per the Nightshift docs, the app picks a routing mode and the runtime picks the model; pinning a specific model is a lane setting inside Nightshift. Each call's compute receipt (routed model, provider, phases, token usage) is stored in the run output and the trace.
- **Data egress:** receipts show `privacy.path: cloud-ok` and `egress.destination: nvidia`. Live-mode prompts, which contain synthetic hospital data, leave the machine for NVIDIA's hosted endpoint.

Sponsor technology:
- **Zetaris**: the data layer. It serves the openFDA shortage API (REST tables + view) and the synthetic hospital tables (PostgreSQL datasource). ShortStop reads only through `POST /sql-editor/sqls/run` in live mode.
- **Meterless Engine: H-MEM**: precedent memory with provenance, supersession, feedback and an audit ledger. Tests: `npm run test:hmem:conformance` (13/13) and `tests/memory/precedents.test.ts`.
- **Meterless Nightshift**: the primary and only AI provider, under provider contract v4.
- **NVIDIA**: Nemotron models served the planner and critic, through Nightshift. The NVIDIA key lives in Nightshift's Providers tab, not in this app.

Agent framework: none. The orchestration is a small custom TypeScript state machine (`src/workflow/run.ts`).

Development tools: built with **Claude Code** (Anthropic) as the AI coding assistant, used for scaffolding, implementation, debugging, tests and documentation. Generated code was reviewed and tested. Cursor was not used.

Deterministic parts (no model): NDC matching, exposure calculation, policy and evidence validation, the precedent critic, and the sample-mode planner.

## Third-party code and licences

| Component | Licence | Use |
|---|---|---|
| **ShortStop** (this repository, excluding `vendor/` and third-party data) | Apache-2.0 | See `LICENSE` |
| Meterless H-MEM reference engine and conformance suite (commit `1742dec`) | Apache-2.0 | Vendored unmodified in `vendor/hmem/`; attribution in `vendor/hmem/VENDORED.md` |
| openFDA drug shortages and NDC Directory data | [openFDA terms](https://open.fda.gov/license/) | Public records; snapshot in `data/openfda/` |
| TypeScript, tsx, Vitest, @types/node | Apache-2.0 / MIT | Dev dependencies only; no runtime dependencies |

Zetaris recipes and the Meterless provider contract were followed as documentation; no code was copied from them.

## Pre-existing components

All ShortStop code, data and documentation in this repository were created on 25 October 2026, inside the build window that opened 22 October 2026 00:00 UTC. The one pre-existing component is the open-source **Meterless H-MEM reference engine** (upstream commit `1742dec`, dated 19 October 2026), vendored unmodified under Apache-2.0. The openFDA snapshot is public data fetched during the build window.

## Limitations

- Days-on-hand assumes recent average usage continues; it is not a forecast.
- Precedent recall uses the H-MEM reference engine's deterministic hash embedder, not semantic embeddings.
- This is a single-hospital model, with no purchasing, wholesaler or patient data.
- Live LLM calls through `meterless/auto` took 49–168 s each, so a live run with planning takes 3–6 minutes. The slowest call (168 s) was close to the 180 s timeout from the provider contract, and earlier critic calls did time out and were retried.
- The 2-revision cap was reached once in live testing, before the planner prompt was fixed. That run escalated instead of approving.
- Single run per scenario in live mode: model outputs can vary between runs, while the validator's rules do not.
