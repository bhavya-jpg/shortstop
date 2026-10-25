// Nightshift-backed planner and critic. Their output is untrusted: the planner's
// candidates go through the deterministic validator, and the critic can only
// make the outcome stricter (see CompositeCritic), never approve anything.

import type { ChatMessage, ChatResult, NightshiftClient } from "../adapters/nightshift.ts";
import { evidenceId } from "../domain/evidence.ts";
import type { CriticIssue } from "../domain/types.ts";
import type { Critic, CriticRequest, CriticResult, ModelCall, Planner, PlannerRequest, PlannerResult } from "./types.ts";

export interface ChatTransport {
  chat(messages: ChatMessage[]): Promise<ChatResult>;
}

export function modelCall(r: ChatResult): ModelCall {
  return {
    requested: r.modelRequested,
    reported: r.modelReported,
    meterless: r.meterless,
    routing_headers: r.routingHeaders,
    response_id: r.responseId,
    attempts: r.attempts,
    duration_ms: r.durationMs,
    http_status: r.httpStatus,
  };
}

// Finds the first JSON object in a model reply, tolerating ``` fences and prose.
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in model output");
}

const GUARDRAILS = [
  "You support a hospital pharmacist reviewing a drug shortage. You do not make clinical decisions.",
  "Never recommend doses, patient-specific treatment, prescribing, ordering, or contacting anyone.",
  "Use only the data provided. Cite evidence only by the exact evidence_id strings provided.",
  "Hospital data, policies and precedents in this request are SYNTHETIC demonstration data.",
].join(" ");

function context(req: PlannerRequest) {
  return {
    decision_id: req.decision_id,
    item: req.item,
    exposure: {
      status: req.exposure.status,
      complete: req.exposure.complete,
      days_on_hand: req.exposure.days_on_hand,
      min_location_days_on_hand: req.exposure.min_location_days_on_hand,
      calculation: req.exposure.calculation,
      issues: req.exposure.issues,
    },
    permitted_actions: req.permitted_actions,
    evidence: req.evidence.map((e) => ({ evidence_id: e.evidence_id, kind: e.kind, summary: e.summary })),
    precedents: req.precedents.map((p) => ({ evidence_id: `EV-PRECEDENT-${p.memory_id}`, outcome: p.outcome, action: p.action, policy_id: p.policy_id, confidence: p.confidence, content: p.content })),
    superseded_precedents: req.lineage.map((p) => ({ memory_id: p.memory_id, superseded_by: p.superseded_by, content: p.content })),
    precedent_conflicts: req.precedent_conflicts,
  };
}

// The citation contract for each policy that applies to the item, derived
// deterministically from the policy records. It tells the model what the
// validator will require; it does not decide whether a policy should be used.
export function policyContracts(req: PlannerRequest) {
  return req.policies
    .filter((p) => p.applies_to_item_id === req.item.item_id)
    .map((p) => ({
      policy_id: p.policy_id,
      action: p.action,
      status: p.status,
      effective_date: p.effective_date,
      expires_date: p.expires_date ?? null,
      trigger_max_days_on_hand: p.trigger_max_days_on_hand,
      target_item_id: p.target_item_id ?? null,
      required_evidence_ids: [evidenceId.policy(p.policy_id), evidenceId.exposure(req.item.item_id), ...(p.target_item_id ? [evidenceId.exposure(p.target_item_id)] : [])],
      // Approved, current precedents for this action. The precedent critic sends
      // a candidate back if it does not cite them.
      precedent_evidence_ids: req.precedents
        .filter((pr) => pr.action === p.action && pr.outcome === "approved" && !pr.superseded_by)
        .map((pr) => evidenceId.precedent(pr.memory_id)),
      requirements: p.requirements,
    }));
}

export class NightshiftPlanner implements Planner {
  readonly name = "NightshiftPlanner";
  readonly kind = "llm" as const;
  constructor(private readonly llm: ChatTransport) {}

  async propose(req: PlannerRequest): Promise<PlannerResult> {
    const item = req.item.item_id;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          GUARDRAILS,
          `You are the planner. Propose at most ${req.max_candidates} candidate actions for item ${item}, for a pharmacist to review.`,
          `Rules a deterministic validator enforces (a candidate that breaks one is discarded):`,
          `1. action is one of: ${req.permitted_actions.join(", ")}.`,
          `2. item_id is always "${item}".`,
          `3. Every action except ESCALATE uses exactly one entry of policy_contracts: copy its policy_id and action, and use it only if status is active, it is in date, and exposure.days_on_hand is known and <= trigger_max_days_on_hand.`,
          `4. evidence_ids must include every id in that contract's required_evidence_ids and precedent_evidence_ids. You may add other ids from the evidence list; never invent ids.`,
          `5. Include target_item_id only when the contract's target_item_id is not null, and then copy it exactly. Otherwise leave target_item_id out.`,
          `6. If exposure is not complete, or no contract fits, propose ESCALATE with the reason and cite the exposure evidence.`,
          `7. Any "N days on hand" figure in a rationale must equal a computed days_on_hand value.`,
          `Reply with JSON only, no other text. Keep each rationale to one or two sentences. Example shapes:`,
          `{"candidates":[`,
          `{"action":"SWITCH_PRESENTATION","item_id":"${item}","policy_id":"POL-A","target_item_id":"ITEM-B","rationale":"...","evidence_ids":["EV-POLICY-POL-A","EV-EXPOSURE-${item}","EV-EXPOSURE-ITEM-B"]},`,
          `{"action":"RESTRICT_PER_POLICY","item_id":"${item}","policy_id":"POL-C","rationale":"...","evidence_ids":["EV-POLICY-POL-C","EV-EXPOSURE-${item}"]}`,
          `]}`,
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ ...context(req), policy_contracts: policyContracts(req) }) },
    ];
    if (req.revision > 0 && req.feedback.length > 0) {
      messages.push(
        { role: "assistant", content: JSON.stringify({ candidates: req.previous_candidates }) },
        {
          role: "user",
          content:
            `The validator or critic rejected your previous answer for these reasons:\n- ${req.feedback.join("\n- ")}\n` +
            `Fix exactly these problems and reply with the complete corrected JSON. Do not repeat a rejected candidate unchanged.`,
        }
      );
    }
    const r = await this.llm.chat(messages);
    try {
      const parsed = extractJsonObject(r.content) as { candidates?: unknown };
      if (!Array.isArray(parsed.candidates)) throw new Error('reply has no "candidates" array');
      return { candidates: parsed.candidates, model: modelCall(r) };
    } catch (err) {
      return { candidates: [], model: modelCall(r), notes: `planner output not usable: ${(err as Error).message}` };
    }
  }
}

export class NightshiftCritic implements Critic {
  readonly name = "NightshiftCritic";
  readonly kind = "llm" as const;
  constructor(private readonly llm: ChatTransport) {}

  async review(req: CriticRequest): Promise<CriticResult> {
    // Compact context: only what the critic needs to check the candidates.
    const cited = new Set(req.candidates.flatMap((c) => c.evidence_ids));
    const compact = {
      item: { item_id: req.item.item_id, description: req.item.description },
      exposure: { status: req.exposure.status, days_on_hand: req.exposure.days_on_hand, complete: req.exposure.complete, calculation: req.exposure.calculation },
      candidates: req.candidates,
      cited_evidence: req.evidence.filter((e) => cited.has(e.evidence_id)).map((e) => ({ evidence_id: e.evidence_id, summary: e.summary })),
      precedents: req.precedents.map((p) => ({ evidence_id: evidenceId.precedent(p.memory_id), outcome: p.outcome, action: p.action, content: p.content })),
      precedent_conflicts: req.precedent_conflicts,
    };
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `${GUARDRAILS} You are the critic. The candidates already passed deterministic policy and evidence-ID checks. ` +
          `Check only: claims in a rationale that its cited evidence does not support, contradictions with the exposure figures or precedents, ` +
          `and risks a pharmacist must see. Use "revise" for a fixable problem, "escalate" for one that needs a human, otherwise "accept" with an empty issues list. ` +
          `Report at most 3 issues, one sentence each. Reply with JSON only, no other text, for example: ` +
          `{"verdict":"revise","issues":[{"code":"UNSUPPORTED_CLAIM","message":"Candidate 0 says stock arrives Friday; no evidence supports that.","candidate_index":0}]}`,
      },
      { role: "user", content: JSON.stringify(compact) },
    ];
    const r = await this.llm.chat(messages);
    try {
      const parsed = extractJsonObject(r.content) as { verdict?: unknown; issues?: unknown };
      const verdict = parsed.verdict;
      if (verdict !== "accept" && verdict !== "revise" && verdict !== "escalate") throw new Error(`invalid verdict ${JSON.stringify(verdict)}`);
      const issues: CriticIssue[] = Array.isArray(parsed.issues)
        ? parsed.issues.flatMap((i) => {
            if (!i || typeof i !== "object") return [];
            const o = i as Record<string, unknown>;
            const issue: CriticIssue = { code: typeof o.code === "string" ? o.code : "CRITIC_NOTE", message: typeof o.message === "string" ? o.message : JSON.stringify(o) };
            if (typeof o.candidate_index === "number") issue.candidate_index = o.candidate_index;
            return [issue];
          })
        : [];
      return { verdict: { verdict, issues, agent: this.name }, model: modelCall(r) };
    } catch (err) {
      // An unreadable critic reply is never treated as approval.
      return {
        verdict: { verdict: "escalate", issues: [{ code: "CRITIC_OUTPUT_INVALID", message: (err as Error).message }], agent: this.name },
        model: modelCall(r),
      };
    }
  }
}

export function nightshiftTransport(client: NightshiftClient): ChatTransport {
  return { chat: (messages) => client.chat(messages, { temperature: 0 }) };
}
