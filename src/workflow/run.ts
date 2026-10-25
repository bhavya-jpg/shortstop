// The ShortStop workflow: a bounded, traced state machine.
//
//   RETRIEVE_DATA -> IDENTIFY_AFFECTED -> per affected item:
//     CALCULATE_EXPOSURE -> (adequate stock: MONITOR, no planning)
//     RECALL_PRECEDENTS -> BUILD_EVIDENCE ->
//     PLAN -> VALIDATE -> CRITIQUE -> (REVISE -> PLAN ...) at most maxRevisions times
//     -> ESCALATE | PACKAGE (PENDING_APPROVAL)
//
// Nothing leaves this workflow as an action: every decision is a package that a
// pharmacist must approve, reject or acknowledge. Deterministic validation
// decides which candidates are admissible; agents cannot override it.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Critic, ModelCall, Planner } from "../agents/types.ts";
import type { DataSource } from "../data/sources.ts";
import { buildEvidence } from "../domain/evidence.ts";
import { calculateExposure, EXPOSURE_DEFAULTS } from "../domain/exposure.ts";
import { matchShortages, type RelatedMatch } from "../domain/matching.ts";
import { normalizeNdc } from "../domain/ndc.ts";
import { validateCandidates } from "../domain/policy.ts";
import type {
  CandidateAction,
  CandidateValidation,
  CriticVerdict,
  DecisionStatus,
  EvidenceRef,
  FormularyItem,
  ItemExposure,
  Mode,
  PolicyRecord,
  ShortageRecord,
} from "../domain/types.ts";
import { PERMITTED_ACTIONS, TARGETED_ACTIONS } from "../domain/types.ts";
import type { Precedent, PrecedentConflict, PrecedentMemory } from "../memory/precedents.ts";
import type { Tracer } from "../trace/tracer.ts";

export interface RunInput {
  run_id?: string;
  scenario_id?: string;
  as_of: string;
  trigger: { package_ndc: string } | { sweep: true };
}

export interface DecisionPackage {
  decision_id: string;
  item: FormularyItem;
  shortage: ShortageRecord;
  impact: "affected" | "listed_available";
  status: DecisionStatus;
  requires_human_review: true;
  exposure: ItemExposure;
  target_exposures: ItemExposure[];
  candidates: CandidateAction[]; // passed validation
  candidate_checks: CandidateValidation[]; // validation of the final accepted candidates
  rejected_candidates: (CandidateValidation & { revision: number })[];
  critic_verdicts: (CriticVerdict & { revision: number })[];
  revisions: number;
  escalation_reasons: string[];
  policies: PolicyRecord[];
  precedents: Precedent[];
  superseded_precedents: Precedent[];
  precedent_conflicts: PrecedentConflict[];
  evidence: EvidenceRef[];
  model_calls: (ModelCall & { agent: string; revision: number })[];
  limitations: string[];
}

export interface RunOutput {
  run_id: string;
  status: "success" | "error";
  mode: Mode;
  notice: string;
  scenario_id?: string;
  input: RunInput;
  as_of: string;
  started_at: string;
  finished_at: string;
  execution_time_seconds: number;
  agents: { name: string; kind: string; role: string }[];
  data_source: string;
  decisions: DecisionPackage[];
  related_matches: RelatedMatch[];
  data_issues: string[];
  trace_file: string | null;
  error?: { type: string; message: string; recoverable: boolean };
}

export interface WorkflowDeps {
  mode: Mode;
  maxRevisions: number;
  maxCandidates: number;
  data: DataSource;
  memory: PrecedentMemory;
  planner: Planner;
  critic: Critic;
  tracer: Tracer;
}

export const SAMPLE_NOTICE =
  "SAMPLE MODE: bundled openFDA snapshot and SYNTHETIC hospital data; deterministic rule-based agents. " +
  "No Zetaris query and no Nightshift model call was made in this run.";
export const LIVE_NOTICE =
  "LIVE MODE: data retrieved through Zetaris; planner and critic called through Meterless Nightshift. " +
  "Hospital data, policies and precedents are SYNTHETIC. Demonstration only: not clinical decision support.";

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${randomUUID().slice(0, 6)}`;
}

export async function runWorkflow(input: RunInput, deps: WorkflowDeps): Promise<RunOutput> {
  const { tracer } = deps;
  const runId = tracer.runId;
  const startedAt = new Date();
  const base = {
    run_id: runId,
    mode: deps.mode,
    notice: deps.mode === "sample" ? SAMPLE_NOTICE : LIVE_NOTICE,
    ...(input.scenario_id ? { scenario_id: input.scenario_id } : {}),
    input,
    as_of: input.as_of,
    started_at: startedAt.toISOString(),
    agents: [
      { name: deps.planner.name, kind: deps.planner.kind, role: "Proposes candidate actions from policy records, exposure and precedents" },
      { name: "PolicyValidator", kind: "deterministic", role: "Rejects actions not backed by in-force policy, unknown evidence IDs and unsupported figures" },
      { name: deps.critic.name, kind: deps.critic.kind, role: "Challenges validated candidates; can request revision or escalate" },
      { name: "PrecedentMemory (H-MEM)", kind: "engine", role: "Recalls, supersedes and scores precedents with provenance" },
    ],
    data_source: deps.data.name,
    trace_file: tracer.file ? path.relative(process.cwd(), tracer.file) : null,
  };
  const finish = (rest: Pick<RunOutput, "status" | "decisions" | "related_matches" | "data_issues"> & { error?: RunOutput["error"] }): RunOutput => {
    const finishedAt = new Date();
    const out: RunOutput = { ...base, ...rest, finished_at: finishedAt.toISOString(), execution_time_seconds: (finishedAt.getTime() - startedAt.getTime()) / 1000 };
    tracer.emit({
      stage: "COMPLETE",
      agent: "Orchestrator",
      action: "run_complete",
      status: rest.status === "success" ? "success" : "failure",
      summary: `${rest.decisions.length} decision package(s): ${rest.decisions.map((d) => `${d.item.item_id}=${d.status}`).join(", ") || "none"}`,
      details: { execution_time_seconds: out.execution_time_seconds },
    });
    return out;
  };

  tracer.emit({ stage: "START", agent: "Orchestrator", action: "run_start", status: "start", summary: base.notice, details: { input, data_source: deps.data.name, planner: deps.planner.name, critic: deps.critic.name } });

  // ---- RETRIEVE_DATA ---------------------------------------------------------
  let hospital, lookup;
  try {
    hospital = await deps.data.loadHospital({ asOf: input.as_of, usageWindowDays: EXPOSURE_DEFAULTS.windowDays });
    const ndcs = "package_ndc" in input.trigger ? [input.trigger.package_ndc] : hospital.formulary.filter((f) => f.status === "active").map((f) => f.ndc);
    // Look up every formulary NDC so policy targets can be checked against shortages too.
    const lookupNdcs = [...new Set([...ndcs, ...hospital.formulary.map((f) => f.ndc)])];
    lookup = await deps.data.loadShortages(lookupNdcs);
    tracer.emit({
      stage: "RETRIEVE_DATA",
      agent: "DataAgent",
      action: "load_data",
      status: "success",
      summary: `${hospital.formulary.length} formulary items, ${hospital.inventory.length} inventory rows, ${hospital.usage.length} usage rows, ${hospital.policies.length} policies, ${lookup.records.length} shortage records (${deps.data.name})`,
      details: { hospital_provenance: hospital.provenance, shortage_source: lookup.source_detail, shortage_record_keys: lookup.records.map((r) => r.record_key) },
    });
  } catch (err) {
    const e = err as Error;
    tracer.emit({ stage: "RETRIEVE_DATA", agent: "DataAgent", action: "load_data", status: "failure", summary: `${e.name}: ${e.message}`, details: { recoverable: false } });
    return finish({
      status: "error",
      decisions: [],
      related_matches: [],
      data_issues: [],
      error: { type: e.name || "DataError", message: `${e.message}. No sample data was substituted.`, recoverable: true },
    });
  }

  // ---- IDENTIFY_AFFECTED -----------------------------------------------------
  const match = matchShortages(lookup.records, hospital.formulary);
  let affected = match.affected;
  if ("package_ndc" in input.trigger) {
    const n = normalizeNdc(input.trigger.package_ndc);
    affected = affected.filter((a) => n.ok && a.shortage.package_ndc === n.ndc11);
  }
  const dataIssues = [...match.issues, ...lookup.records.flatMap((r) => r.data_issues.map((i) => `${r.record_key}: ${i}`))];
  tracer.emit({
    stage: "IDENTIFY_AFFECTED",
    agent: "MatchingAgent",
    action: "match_formulary",
    status: "success",
    summary: `${affected.length} affected formulary item(s) by exact package NDC; ${match.related.length} same-product match(es) flagged for confirmation`,
    details: { affected: affected.map((a) => ({ item_id: a.item.item_id, ndc11: a.item_ndc11, shortage: a.shortage.record_key, impact: a.impact })), related: match.related.map((r) => r.note), issues: dataIssues },
  });

  const shortagesByItem = new Map<string, ShortageRecord>(match.affected.map((a) => [a.item.item_id, a.shortage]));
  const declaredLocations = (itemId: string) => [...new Set(hospital.inventory.filter((i) => i.item_id === itemId).map((i) => i.location_id))];
  const exposureOf = (itemId: string) =>
    calculateExposure(itemId, hospital.inventory, hospital.usage, { asOf: input.as_of }, declaredLocations(itemId));

  const decisions: DecisionPackage[] = [];
  for (const a of affected) {
    const item = a.item;
    const decisionId = `DEC-${runId}-${item.item_id}`;
    const emit = (e: Parameters<Tracer["emit"]>[0]) => tracer.emit({ decision_id: decisionId, ...e });
    const limitations: string[] = [
      "Hospital formulary, inventory, usage, policies and precedents are SYNTHETIC.",
      "Days-on-hand assumes recent average usage continues; it is not a demand forecast.",
    ];
    if (!a.shortage.has_openfda_block) limitations.push("The openFDA record has no openfda cross-reference block (no RxCUI); identity rests on the package NDC alone.");

    // ---- CALCULATE_EXPOSURE ----------------------------------------------------
    const exposure = exposureOf(item.item_id);
    const policies = hospital.policies.filter((p) => p.applies_to_item_id === item.item_id);
    const targetIds = [...new Set(policies.filter((p) => (TARGETED_ACTIONS as readonly string[]).includes(p.action) && p.target_item_id).map((p) => p.target_item_id!))];
    const targetItems = targetIds.map((id) => hospital.formulary.find((f) => f.item_id === id)).filter((f): f is FormularyItem => Boolean(f));
    const targetExposures = targetItems.map((t) => exposureOf(t.item_id));
    const exposures = new Map<string, ItemExposure>([[item.item_id, exposure], ...targetExposures.map((e) => [e.item_id, e] as const)]);
    emit({
      stage: "CALCULATE_EXPOSURE",
      agent: "ExposureCalculator",
      action: "days_on_hand",
      status: exposure.complete ? "success" : "rejected",
      summary: `${item.item_id}: ${exposure.status}; ${exposure.calculation}`,
      details: {
        exposure: { status: exposure.status, days_on_hand: exposure.days_on_hand, complete: exposure.complete, min_location_days_on_hand: exposure.min_location_days_on_hand, issues: exposure.issues, locations: exposure.locations },
        targets: targetExposures.map((t) => ({ item_id: t.item_id, status: t.status, days_on_hand: t.days_on_hand, total_on_hand: t.total_on_hand })),
      },
    });

    // ---- RECALL_PRECEDENTS (H-MEM) ---------------------------------------------
    const recall = deps.memory.recall(item);
    emit({
      stage: "RECALL_PRECEDENTS",
      agent: "PrecedentMemory",
      action: "hmem_query",
      status: "success",
      summary: `H-MEM recalled ${recall.precedents.length} precedent(s), ${recall.lineage.length} superseded ancestor(s), ${recall.conflicts.length} unresolved conflict(s)`,
      details: { trace: recall.trace, precedents: recall.precedents.map((p) => ({ memory_id: p.memory_id, action: p.action, outcome: p.outcome, relevance: p.relevance, confidence: p.confidence, supersedes: p.supersedes, source_ref: p.source_ref })), lineage: recall.lineage.map((p) => p.memory_id), conflicts: recall.conflicts },
    });

    // ---- BUILD_EVIDENCE --------------------------------------------------------
    const allPrecedents = [...recall.precedents, ...recall.lineage];
    const evidence = buildEvidence({
      item,
      shortage: a.shortage,
      exposure,
      hospital,
      policies,
      targets: targetItems.map((t, i) => {
        const ts = shortagesByItem.get(t.item_id);
        return { item: t, exposure: targetExposures[i]!, ...(ts ? { shortage: ts } : {}) };
      }),
      precedents: allPrecedents.map((p) => ({
        memory_id: p.memory_id, content: p.content, synthetic: p.synthetic, outcome: p.outcome, action: p.action,
        confidence: p.confidence, source_ref: p.source_ref, ...(p.superseded_by ? { superseded_by: p.superseded_by } : {}),
      })),
    });
    emit({ stage: "BUILD_EVIDENCE", agent: "EvidenceBuilder", action: "bundle", status: "success", summary: `${evidence.ids().length} evidence references`, details: { evidence_ids: evidence.ids() } });

    const pkg: DecisionPackage = {
      decision_id: decisionId,
      item,
      shortage: a.shortage,
      impact: a.impact,
      status: "PENDING_APPROVAL",
      requires_human_review: true,
      exposure,
      target_exposures: targetExposures,
      candidates: [],
      candidate_checks: [],
      rejected_candidates: [],
      critic_verdicts: [],
      revisions: 0,
      escalation_reasons: [],
      policies,
      precedents: recall.precedents,
      superseded_precedents: recall.lineage,
      precedent_conflicts: recall.conflicts,
      evidence: evidence.all(),
      model_calls: [],
      limitations,
    };

    // ---- Branch: no urgent action needed ----------------------------------------
    if (a.impact === "listed_available" || exposure.status === "ADEQUATE" || exposure.status === "NO_RECENT_USAGE") {
      pkg.status = "MONITOR_PENDING_ACKNOWLEDGEMENT";
      const why =
        a.impact === "listed_available"
          ? `openFDA lists this package as "${a.shortage.availability_raw}"`
          : `exposure is ${exposure.status}${exposure.days_on_hand !== null ? ` (${exposure.days_on_hand} days on hand)` : ""}`;
      pkg.limitations.push(`No candidate actions were planned because ${why}. Monitoring is recommended; a pharmacist should acknowledge.`);
      emit({ stage: "PACKAGE", agent: "Orchestrator", action: "monitor_only", status: "info", summary: `planning skipped: ${why}` });
      decisions.push(pkg);
      continue;
    }

    if (!exposure.complete) pkg.escalation_reasons.push(`Exposure is incomplete (${exposure.issues.join("; ")}); no policy trigger can be evaluated.`);

    // ---- PLAN -> VALIDATE -> CRITIQUE -> REVISE (bounded) --------------------------
    const ctx = {
      item, exposure, policies: hospital.policies, formulary: hospital.formulary, exposures, shortagesByItem,
      evidence, asOf: input.as_of, maxCandidates: deps.maxCandidates,
    };
    let feedback: string[] = [];
    let previous: unknown[] = [];
    let settled = false;
    for (let rev = 0; rev <= deps.maxRevisions && !settled; rev++) {
      pkg.revisions = rev;
      const req = {
        run_id: runId, decision_id: decisionId, revision: rev, item, shortage: a.shortage, exposure,
        permitted_actions: PERMITTED_ACTIONS, policies, evidence: evidence.all(), precedents: recall.precedents,
        lineage: recall.lineage, precedent_conflicts: recall.conflicts, max_candidates: deps.maxCandidates,
        feedback, previous_candidates: previous,
      };

      let plan;
      try {
        plan = await deps.planner.propose(req);
      } catch (err) {
        const msg = `${(err as Error).name}: ${(err as Error).message}`;
        emit({ stage: "PLAN", agent: deps.planner.name, action: "propose", status: "failure", revision: rev, summary: `planner failed: ${msg}` });
        pkg.escalation_reasons.push(`Planner unavailable (${msg}); no candidates were generated and none were invented.`);
        break;
      }
      if (plan.model) pkg.model_calls.push({ ...plan.model, agent: deps.planner.name, revision: rev });
      emit({
        stage: "PLAN",
        agent: deps.planner.name,
        action: "propose",
        status: "success",
        revision: rev,
        summary: `${plan.candidates.length} candidate(s) proposed${plan.notes ? `; ${plan.notes}` : ""}`,
        ...(plan.model ? { model: { requested: plan.model.requested, reported: plan.model.reported, routing: { meterless: plan.model.meterless, headers: plan.model.routing_headers } } } : {}),
        details: { candidates: plan.candidates, agent_kind: deps.planner.kind },
      });

      const report = validateCandidates(plan.candidates, ctx);
      const rejected = report.results.filter((r) => !r.valid);
      pkg.rejected_candidates.push(...rejected.map((r) => ({ ...r, revision: rev })));
      emit({
        stage: "VALIDATE",
        agent: "PolicyValidator",
        action: "validate",
        status: rejected.length || report.issues.length ? "rejected" : "success",
        revision: rev,
        summary: `${report.valid.length} valid, ${rejected.length} rejected`,
        details: { results: report.results.map((r) => ({ action: r.candidate?.action, policy_id: r.candidate?.policy_id, valid: r.valid, issues: r.issues, checks: r.checks })), issues: report.issues },
      });

      const validatorFeedback = [...report.issues, ...rejected.flatMap((r) => r.issues)].map((i) => `${i.code}${i.candidate_index !== undefined ? ` (candidate ${i.candidate_index})` : ""}: ${i.message}`);
      if (report.valid.length === 0) {
        if (rev < deps.maxRevisions) {
          emit({ stage: "REVISE", agent: "Orchestrator", action: "request_revision", status: "info", revision: rev, summary: `no valid candidates; asking ${deps.planner.name} to revise`, details: { feedback: validatorFeedback } });
          feedback = validatorFeedback;
          previous = plan.candidates;
          continue;
        }
        pkg.escalation_reasons.push(`No candidate passed validation after ${rev + 1} attempt(s): ${validatorFeedback.join(" | ") || "no candidates"}`);
        break;
      }

      let critique;
      try {
        critique = await deps.critic.review({ ...req, candidates: report.valid, validation: report.results });
      } catch (err) {
        const msg = `${(err as Error).name}: ${(err as Error).message}`;
        emit({ stage: "CRITIQUE", agent: deps.critic.name, action: "review", status: "failure", revision: rev, summary: `critic failed: ${msg}` });
        pkg.candidates = report.valid;
        pkg.candidate_checks = report.results.filter((r) => r.valid);
        pkg.escalation_reasons.push(`Critic unavailable (${msg}); candidates were not independently reviewed.`);
        break;
      }
      if (critique.model) pkg.model_calls.push({ ...critique.model, agent: deps.critic.name, revision: rev });
      pkg.critic_verdicts.push({ ...critique.verdict, revision: rev });
      emit({
        stage: "CRITIQUE",
        agent: deps.critic.name,
        action: "review",
        status: critique.verdict.verdict === "accept" ? "success" : critique.verdict.verdict === "escalate" ? "escalated" : "rejected",
        revision: rev,
        summary: `verdict ${critique.verdict.verdict}${critique.verdict.issues.length ? `: ${critique.verdict.issues.map((i) => i.code).join(", ")}` : ""}`,
        ...(critique.model ? { model: { requested: critique.model.requested, reported: critique.model.reported, routing: { meterless: critique.model.meterless, headers: critique.model.routing_headers } } } : {}),
        details: { issues: critique.verdict.issues },
      });

      pkg.candidates = report.valid;
      pkg.candidate_checks = report.results.filter((r) => r.valid);
      if (critique.verdict.verdict === "accept") {
        settled = true;
      } else if (critique.verdict.verdict === "escalate") {
        pkg.escalation_reasons.push(...critique.verdict.issues.map((i) => `Critic: ${i.message}`));
        settled = true;
      } else if (rev < deps.maxRevisions) {
        feedback = [...critique.verdict.issues.map((i) => `${i.code}: ${i.message}`), ...validatorFeedback];
        previous = plan.candidates;
        emit({ stage: "REVISE", agent: "Orchestrator", action: "request_revision", status: "info", revision: rev, summary: `critic requested revision`, details: { feedback } });
      } else {
        pkg.escalation_reasons.push(`Revision limit (${deps.maxRevisions}) reached with unresolved critic issues: ${critique.verdict.issues.map((i) => i.message).join(" | ")}`);
      }
    }

    for (const c of pkg.candidates.filter((c) => c.action === "ESCALATE")) pkg.escalation_reasons.push(`Planner escalated: ${c.rationale}`);
    pkg.escalation_reasons = [...new Set(pkg.escalation_reasons)];
    pkg.status = pkg.escalation_reasons.length > 0 ? "ESCALATED" : "PENDING_APPROVAL";
    emit({
      stage: pkg.status === "ESCALATED" ? "ESCALATE" : "PACKAGE",
      agent: "Orchestrator",
      action: pkg.status === "ESCALATED" ? "escalate" : "package_for_review",
      status: pkg.status === "ESCALATED" ? "escalated" : "success",
      summary: `${item.item_id}: ${pkg.status} with ${pkg.candidates.length} validated candidate(s) after ${pkg.revisions} revision(s); awaiting pharmacist review`,
      details: { escalation_reasons: pkg.escalation_reasons, candidates: pkg.candidates.map((c) => `${c.action}${c.policy_id ? ` ${c.policy_id}` : ""}`) },
    });
    decisions.push(pkg);
  }

  return finish({ status: "success", decisions, related_matches: match.related, data_issues: dataIssues });
}
