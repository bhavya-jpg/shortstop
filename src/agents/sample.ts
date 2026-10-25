// Deterministic agents. No model is called. The planner turns in-force policy
// records into candidates; the critic applies rule-based precedent checks.
// The precedent critic also runs alongside the LLM critic in live mode, so a
// model's "accept" can never clear a precedent conflict.

import { evidenceId } from "../domain/evidence.ts";
import type { CandidateAction, CriticIssue, PolicyActionType } from "../domain/types.ts";
import { TARGETED_ACTIONS } from "../domain/types.ts";
import type { Critic, CriticRequest, CriticResult, Planner, PlannerRequest, PlannerResult } from "./types.ts";

const ACTION_ORDER: PolicyActionType[] = ["SWITCH_PRESENTATION", "APPROVED_INTERCHANGE", "RESTRICT_PER_POLICY", "ALTERNATE_SOURCING"];

export class DeterministicPolicyPlanner implements Planner {
  readonly name = "DeterministicPolicyPlanner";
  readonly kind = "deterministic" as const;

  async propose(req: PlannerRequest): Promise<PlannerResult> {
    const { item, exposure: ex, shortage } = req;
    const shortageEv = evidenceId.shortage(shortage);
    const exposureEv = evidenceId.exposure(item.item_id);

    if (!ex.complete || ex.days_on_hand === null) {
      return {
        candidates: [
          {
            action: "ESCALATE",
            item_id: item.item_id,
            rationale: `Exposure for ${item.item_id} cannot be calculated reliably (${ex.status}): ${ex.issues.join("; ") || "no usable data"}. No policy trigger can be evaluated on incomplete data.`,
            evidence_ids: [exposureEv, shortageEv],
          },
        ],
        notes: "exposure incomplete: escalating without proposing policy actions",
      };
    }

    const applicable = req.policies
      .filter(
        (p) =>
          p.applies_to_item_id === item.item_id &&
          p.status === "active" &&
          p.effective_date <= ex.as_of &&
          (!p.expires_date || p.expires_date >= ex.as_of) &&
          ex.days_on_hand !== null &&
          ex.days_on_hand <= p.trigger_max_days_on_hand
      )
      .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action));

    const candidates: CandidateAction[] = applicable.slice(0, req.max_candidates).map((p) => {
      const related = req.precedents.filter((pr) => pr.action === p.action && !pr.superseded_by);
      const evidence = [evidenceId.policy(p.policy_id), exposureEv, shortageEv, ...related.map((pr) => evidenceId.precedent(pr.memory_id))];
      const c: CandidateAction = {
        action: p.action,
        item_id: item.item_id,
        policy_id: p.policy_id,
        rationale:
          `${item.item_id} has ${ex.days_on_hand} days on hand (${ex.status}). Policy ${p.policy_id} permits ${p.action} at or below ${p.trigger_max_days_on_hand} days. ` +
          (related.length ? `Precedent: ${related.map((r) => `${r.memory_id} (${r.outcome} ${r.decided_at ?? ""})`.trim()).join(", ")}.` : "No recorded precedent for this action."),
        evidence_ids: evidence,
      };
      if ((TARGETED_ACTIONS as readonly string[]).includes(p.action) && p.target_item_id) {
        c.target_item_id = p.target_item_id;
        c.evidence_ids.push(evidenceId.exposure(p.target_item_id));
      }
      return c;
    });

    if (candidates.length === 0) {
      candidates.push({
        action: "ESCALATE",
        item_id: item.item_id,
        rationale: `${item.item_id} has ${ex.days_on_hand} days on hand (${ex.status}) and no in-force policy permits an action at this level. A pharmacist must decide.`,
        evidence_ids: [exposureEv, shortageEv],
      });
    }
    return { candidates, notes: `${applicable.length} in-force policies with triggers met` };
  }
}

// Rule-based critic: precedent conflicts and rejected precedents need a human;
// a candidate that ignores a matching approved precedent is sent back.
export class PrecedentCritic implements Critic {
  readonly name = "PrecedentCritic";
  readonly kind = "deterministic" as const;

  async review(req: CriticRequest): Promise<CriticResult> {
    const issues: CriticIssue[] = [];
    let verdict: "accept" | "revise" | "escalate" = "accept";

    for (const c of req.precedent_conflicts) {
      issues.push({ code: "PRECEDENT_CONFLICT", message: `unresolved precedent conflict: ${c.reason}` });
      verdict = "escalate";
    }
    req.candidates.forEach((c, i) => {
      const rejected = req.precedents.filter((p) => p.action === c.action && p.outcome === "rejected" && !p.superseded_by);
      for (const p of rejected) {
        issues.push({ code: "PRECEDENT_REJECTED", message: `${c.action} was rejected before (${p.memory_id}): ${p.content}`, candidate_index: i });
        verdict = "escalate";
      }
      const approved = req.precedents.filter((p) => p.action === c.action && p.outcome === "approved" && !p.superseded_by);
      const uncited = approved.filter((p) => !c.evidence_ids.includes(evidenceId.precedent(p.memory_id)));
      if (uncited.length > 0 && verdict !== "escalate") {
        issues.push({
          code: "PRECEDENT_NOT_CITED",
          message: `candidate ${i} (${c.action}) does not cite the relevant approved precedent(s) ${uncited.map((p) => evidenceId.precedent(p.memory_id)).join(", ")}`,
          candidate_index: i,
        });
        verdict = "revise";
      }
    });
    return { verdict: { verdict, issues, agent: this.name } };
  }
}

// Runs several critics; the strictest verdict wins (escalate > revise > accept).
export class CompositeCritic implements Critic {
  readonly name: string;
  readonly kind;
  constructor(private readonly critics: Critic[]) {
    this.name = critics.map((c) => c.name).join("+");
    this.kind = critics.some((c) => c.kind === "llm") ? ("llm" as const) : ("deterministic" as const);
  }

  async review(req: CriticRequest): Promise<CriticResult> {
    const rank = { accept: 0, revise: 1, escalate: 2 } as const;
    let verdict: "accept" | "revise" | "escalate" = "accept";
    const issues: CriticIssue[] = [];
    let model: CriticResult["model"];
    for (const c of this.critics) {
      const r = await c.review(req);
      if (rank[r.verdict.verdict] > rank[verdict]) verdict = r.verdict.verdict;
      issues.push(...r.verdict.issues.map((i) => ({ ...i, message: `[${c.name}] ${i.message}` })));
      model ??= r.model;
    }
    return { verdict: { verdict, issues, agent: this.name }, ...(model ? { model } : {}) };
  }
}
