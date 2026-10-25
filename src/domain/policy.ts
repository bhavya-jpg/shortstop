// Deterministic validation of proposed actions. This is the safety boundary:
// whatever a planner (LLM or not) proposes, only candidates that pass every
// check here reach the review package. A model can never override it.

import { evidenceId, type EvidenceBundle } from "./evidence.ts";
import type {
  CandidateAction,
  CandidateValidation,
  FormularyItem,
  ItemExposure,
  PolicyRecord,
  ShortageRecord,
  ValidationIssue,
} from "./types.ts";
import { TARGETED_ACTIONS, isActionType } from "./types.ts";

export interface ValidationContext {
  item: FormularyItem;
  exposure: ItemExposure;
  policies: readonly PolicyRecord[];
  formulary: readonly FormularyItem[];
  exposures: ReadonlyMap<string, ItemExposure>; // exposure for every item in the bundle, incl. targets
  shortagesByItem: ReadonlyMap<string, ShortageRecord>; // exact-NDC shortage record per formulary item
  evidence: EvidenceBundle;
  asOf: string;
  maxCandidates: number;
}

export interface ValidationReport {
  results: CandidateValidation[];
  issues: ValidationIssue[]; // issues not tied to one candidate
  valid: CandidateAction[];
}

// Matches claims such as "2.6 days on hand" or "5 days of supply".
const DAYS_CLAIM = /(\d+(?:\.\d+)?)\s*days?\s+(?:of\s+(?:supply|stock)|on[\s-]hand|remaining|left)/gi;

export function parseCandidate(raw: unknown): { candidate?: CandidateAction; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!raw || typeof raw !== "object") return { issues: [{ code: "MALFORMED_CANDIDATE", message: "candidate is not an object" }] };
  const r = raw as Record<string, unknown>;
  if (!isActionType(r.action)) {
    issues.push({ code: "ACTION_NOT_PERMITTED", message: `action ${JSON.stringify(r.action)} is not in the permitted action set` });
  }
  if (typeof r.item_id !== "string") issues.push({ code: "MALFORMED_CANDIDATE", message: "item_id must be a string" });
  if (typeof r.rationale !== "string" || r.rationale.trim() === "") {
    issues.push({ code: "MISSING_RATIONALE", message: "rationale must be a non-empty string" });
  }
  const ev = Array.isArray(r.evidence_ids) ? r.evidence_ids : null;
  if (!ev || ev.length === 0 || !ev.every((x) => typeof x === "string")) {
    issues.push({ code: "MISSING_EVIDENCE", message: "evidence_ids must be a non-empty array of strings" });
  }
  for (const k of ["policy_id", "target_item_id"] as const) {
    if (r[k] !== undefined && r[k] !== null && typeof r[k] !== "string") {
      issues.push({ code: "MALFORMED_CANDIDATE", message: `${k} must be a string when present` });
    }
  }
  if (issues.length > 0) return { issues };
  const candidate: CandidateAction = {
    action: r.action as CandidateAction["action"],
    item_id: r.item_id as string,
    rationale: (r.rationale as string).trim(),
    evidence_ids: [...new Set(ev as string[])],
  };
  if (typeof r.policy_id === "string" && r.policy_id !== "") candidate.policy_id = r.policy_id;
  if (typeof r.target_item_id === "string" && r.target_item_id !== "") candidate.target_item_id = r.target_item_id;
  return { candidate, issues };
}

export function validateCandidates(raw: readonly unknown[], ctx: ValidationContext): ValidationReport {
  const results: CandidateValidation[] = [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  raw.forEach((rawCandidate, index) => {
    const parsed = parseCandidate(rawCandidate);
    if (!parsed.candidate) {
      results.push({
        candidate: rawCandidate as CandidateAction,
        valid: false,
        issues: parsed.issues.map((i) => ({ ...i, candidate_index: index })),
        checks: [],
      });
      return;
    }
    const c = parsed.candidate;
    const { issues: ci, checks } = checkCandidate(c, ctx);
    if (index >= ctx.maxCandidates) {
      ci.push({ code: "TOO_MANY_CANDIDATES", message: `only ${ctx.maxCandidates} candidates are allowed per item` });
    }
    const key = `${c.action}|${c.policy_id ?? ""}|${c.target_item_id ?? ""}`;
    if (seen.has(key)) ci.push({ code: "DUPLICATE_CANDIDATE", message: "an identical candidate was already proposed" });
    seen.add(key);
    results.push({ candidate: c, valid: ci.length === 0, issues: ci.map((i) => ({ ...i, candidate_index: index })), checks });
  });

  if (raw.length === 0) issues.push({ code: "NO_CANDIDATES", message: "the planner proposed no candidate actions" });
  return { results, issues, valid: results.filter((r) => r.valid).map((r) => r.candidate) };
}

function checkCandidate(c: CandidateAction, ctx: ValidationContext): { issues: ValidationIssue[]; checks: string[] } {
  const issues: ValidationIssue[] = [];
  const checks: string[] = [];
  const fail = (code: string, message: string) => issues.push({ code, message });

  if (c.item_id !== ctx.item.item_id) fail("ITEM_MISMATCH", `candidate targets ${c.item_id}, but this decision is for ${ctx.item.item_id}`);
  else checks.push("item matches the affected formulary item");

  const missing = c.evidence_ids.filter((id) => !ctx.evidence.has(id));
  for (const id of missing) fail("EVIDENCE_NOT_FOUND", `cited evidence ${id} does not exist in the evidence bundle`);
  if (missing.length === 0) checks.push(`all ${c.evidence_ids.length} cited evidence IDs exist`);

  checkNumericClaims(c, ctx, fail, checks);

  if (c.action === "ESCALATE") {
    if (c.policy_id || c.target_item_id) fail("UNEXPECTED_FIELDS", "ESCALATE takes no policy_id or target_item_id");
    checks.push("ESCALATE needs no policy record");
    return { issues, checks };
  }

  // Every other action must be backed by an applicable, in-force policy record.
  if (!c.policy_id) {
    fail("POLICY_REQUIRED", `${c.action} must cite the policy record that permits it`);
    return { issues, checks };
  }
  const policy = ctx.policies.find((p) => p.policy_id === c.policy_id);
  if (!policy) {
    fail("POLICY_NOT_FOUND", `policy ${c.policy_id} does not exist in the hospital policy records`);
    return { issues, checks };
  }
  if (policy.action !== c.action) fail("POLICY_ACTION_MISMATCH", `policy ${policy.policy_id} permits ${policy.action}, not ${c.action}`);
  if (policy.applies_to_item_id !== ctx.item.item_id) fail("POLICY_NOT_FOR_ITEM", `policy ${policy.policy_id} applies to ${policy.applies_to_item_id}, not ${ctx.item.item_id}`);
  if (policy.status !== "active") fail("POLICY_RETIRED", `policy ${policy.policy_id} is ${policy.status}`);
  if (policy.effective_date > ctx.asOf) fail("POLICY_NOT_YET_EFFECTIVE", `policy ${policy.policy_id} takes effect ${policy.effective_date}`);
  if (policy.expires_date && policy.expires_date < ctx.asOf) fail("POLICY_EXPIRED", `policy ${policy.policy_id} expired ${policy.expires_date}`);

  const ex = ctx.exposure;
  if (!ex.complete || ex.days_on_hand === null) {
    fail("EXPOSURE_UNKNOWN", `days-on-hand for ${ex.item_id} is not reliably known (${ex.status}); the policy trigger cannot be evaluated`);
  } else if (ex.days_on_hand > policy.trigger_max_days_on_hand) {
    fail("TRIGGER_NOT_MET", `days-on-hand ${ex.days_on_hand} exceeds the policy trigger of ${policy.trigger_max_days_on_hand}`);
  } else {
    checks.push(`trigger met: ${ex.days_on_hand} days <= ${policy.trigger_max_days_on_hand}`);
  }

  for (const req of [evidenceId.policy(policy.policy_id), evidenceId.exposure(ctx.item.item_id)]) {
    if (!c.evidence_ids.includes(req)) fail("MISSING_REQUIRED_EVIDENCE", `${c.action} must cite ${req}`);
  }

  if ((TARGETED_ACTIONS as readonly string[]).includes(c.action)) {
    checkTarget(c, policy, ctx, fail, checks);
  } else if (c.target_item_id || policy.target_item_id) {
    fail("UNEXPECTED_TARGET", `${c.action} does not move use to another item`);
  }
  if (issues.length === 0) checks.push(`policy ${policy.policy_id} is active, applies to this item and permits ${c.action}`);
  return { issues, checks };
}

function checkTarget(
  c: CandidateAction,
  policy: PolicyRecord,
  ctx: ValidationContext,
  fail: (code: string, message: string) => void,
  checks: string[]
): void {
  if (!policy.target_item_id) {
    fail("POLICY_HAS_NO_TARGET", `policy ${policy.policy_id} names no target item`);
    return;
  }
  if (c.target_item_id !== policy.target_item_id) {
    fail("TARGET_MISMATCH", `policy ${policy.policy_id} permits only ${policy.target_item_id} as the target, got ${c.target_item_id ?? "none"}`);
    return;
  }
  const target = ctx.formulary.find((f) => f.item_id === c.target_item_id);
  if (!target || target.status !== "active") {
    fail("TARGET_NOT_ON_FORMULARY", `target ${c.target_item_id} is not an active formulary item`);
    return;
  }
  const tex = ctx.exposures.get(target.item_id);
  if (!tex || tex.total_on_hand === null) fail("TARGET_STOCK_UNKNOWN", `stock of target ${target.item_id} is unknown`);
  else if (tex.total_on_hand <= 0) fail("TARGET_NO_STOCK", `target ${target.item_id} has no stock on hand`);
  else checks.push(`target ${target.item_id} has ${tex.total_on_hand} units on hand`);
  const ts = ctx.shortagesByItem.get(target.item_id);
  if (ts && ts.availability === "UNAVAILABLE") fail("TARGET_IN_SHORTAGE", `target ${target.item_id} is itself reported unavailable by openFDA`);
  if (!c.evidence_ids.includes(evidenceId.exposure(target.item_id))) {
    fail("MISSING_REQUIRED_EVIDENCE", `${c.action} must cite ${evidenceId.exposure(target.item_id)}`);
  }
}

function checkNumericClaims(
  c: CandidateAction,
  ctx: ValidationContext,
  fail: (code: string, message: string) => void,
  checks: string[]
): void {
  const known: number[] = [];
  for (const ex of ctx.exposures.values()) {
    if (ex.days_on_hand !== null) known.push(ex.days_on_hand);
    for (const l of ex.locations) if (l.days_on_hand !== null) known.push(l.days_on_hand);
  }
  let claims = 0;
  let unsupported = 0;
  for (const m of c.rationale.matchAll(DAYS_CLAIM)) {
    claims++;
    const value = Number(m[1]);
    if (!known.some((k) => Math.abs(k - value) <= Math.max(0.15, k * 0.05))) {
      unsupported++;
      fail("UNSUPPORTED_NUMERIC_CLAIM", `rationale claims "${m[0]}", which matches no computed days-on-hand value`);
    }
  }
  if (claims > 0 && unsupported === 0) checks.push(`${claims} days-on-hand claim(s) match computed values`);
}
