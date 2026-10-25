// Human review of a decision package. This is the only way a decision gets a
// final outcome. Approval and rejection feed back into H-MEM:
//   approved: each validated action becomes an "approved" precedent;
//             precedents the candidates cited get "helpful" feedback.
//   rejected: each proposed action becomes a "rejected" precedent with the note;
//             cited precedents get "not_helpful", or "wrong" when the reviewer says so.
//   acknowledged: escalations and monitor-only packages; no precedent is written.
// Nothing is ordered, prescribed or sent anywhere.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evidenceId } from "../domain/evidence.ts";
import type { ReviewOutcome } from "../domain/types.ts";
import type { PrecedentMemory } from "../memory/precedents.ts";
import type { Tracer } from "../trace/tracer.ts";
import type { DecisionPackage, RunOutput } from "./run.ts";

export class ReviewError extends Error {
  override name = "ReviewError";
}

export interface ReviewRecord {
  review_id: string;
  run_id: string;
  decision_id: string;
  item_id: string;
  outcome: ReviewOutcome;
  reviewer: string;
  note: string;
  reviewed_at: string;
  decision_status: DecisionPackage["status"];
  actions: string[];
  precedents_written: string[];
  feedback: { memory_id: string; kind: "helpful" | "not_helpful" | "wrong"; confidence_after: number }[];
}

export class ReviewStore {
  readonly file: string;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "reviews.jsonl");
  }
  all(): ReviewRecord[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ReviewRecord);
  }
  forDecision(decisionId: string): ReviewRecord | undefined {
    return this.all().find((r) => r.decision_id === decisionId);
  }
  append(r: ReviewRecord): void {
    fs.appendFileSync(this.file, JSON.stringify(r) + "\n", "utf-8");
  }
}

export interface ReviewRequest {
  decision_id: string;
  outcome: ReviewOutcome;
  reviewer: string;
  note: string;
  wrong_precedents?: string[]; // memory ids the reviewer marks as wrong
}

export function recordReview(run: RunOutput, req: ReviewRequest, deps: { memory: PrecedentMemory; store: ReviewStore; tracer?: Tracer; now?: () => Date }): ReviewRecord {
  const pkg = run.decisions.find((d) => d.decision_id === req.decision_id);
  if (!pkg) throw new ReviewError(`decision ${req.decision_id} is not in run ${run.run_id}`);
  if (!req.reviewer.trim()) throw new ReviewError("a reviewer name is required");
  const prior = deps.store.forDecision(pkg.decision_id);
  if (prior) throw new ReviewError(`decision ${pkg.decision_id} was already ${prior.outcome} by ${prior.reviewer} at ${prior.reviewed_at}`);
  if (pkg.status === "PENDING_APPROVAL" && req.outcome === "acknowledged") {
    throw new ReviewError("a PENDING_APPROVAL decision must be approved or rejected");
  }
  if (pkg.status !== "PENDING_APPROVAL" && req.outcome !== "acknowledged") {
    throw new ReviewError(`a ${pkg.status} decision can only be acknowledged; it has no approvable action`);
  }
  if (req.outcome === "rejected" && !req.note.trim()) throw new ReviewError("a rejection needs a note explaining why");

  const now = (deps.now ?? (() => new Date()))();
  const reviewId = `REV-${now.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const decidedAt = now.toISOString().slice(0, 10);
  const written: string[] = [];
  const feedback: ReviewRecord["feedback"] = [];
  const actions = pkg.candidates.filter((c) => c.action !== "ESCALATE");

  if (req.outcome !== "acknowledged") {
    for (const c of actions) {
      const p = deps.memory.add({
        item_id: pkg.item.item_id,
        generic_name: pkg.item.description,
        ndc: pkg.item.ndc,
        action: c.action,
        ...(c.policy_id ? { policy_id: c.policy_id } : {}),
        outcome: req.outcome,
        summary: req.note.trim() || `${c.action} ${req.outcome} during review of ${pkg.decision_id}.`,
        decided_at: decidedAt,
        decided_by: req.reviewer,
        synthetic: pkg.item.synthetic,
        source_ref: `review:${reviewId}`,
        origin: "manual",
      });
      written.push(p.memory_id);
    }
    const cited = new Set(actions.flatMap((c) => c.evidence_ids));
    const wrong = new Set(req.wrong_precedents ?? []);
    for (const p of pkg.precedents) {
      if (!cited.has(evidenceId.precedent(p.memory_id)) && !wrong.has(p.memory_id)) continue;
      const kind = wrong.has(p.memory_id) ? "wrong" : req.outcome === "approved" ? "helpful" : "not_helpful";
      const after = deps.memory.feedback(p.memory_id, kind);
      feedback.push({ memory_id: p.memory_id, kind, confidence_after: after.confidence });
    }
  }

  const record: ReviewRecord = {
    review_id: reviewId,
    run_id: run.run_id,
    decision_id: pkg.decision_id,
    item_id: pkg.item.item_id,
    outcome: req.outcome,
    reviewer: req.reviewer,
    note: req.note,
    reviewed_at: now.toISOString(),
    decision_status: pkg.status,
    actions: actions.map((c) => `${c.action}${c.policy_id ? ` ${c.policy_id}` : ""}`),
    precedents_written: written,
    feedback,
  };
  deps.store.append(record);
  deps.tracer?.emit({
    stage: "HUMAN_REVIEW",
    agent: "Pharmacist",
    action: `review_${req.outcome}`,
    status: "success",
    decision_id: pkg.decision_id,
    summary: `${req.reviewer} ${req.outcome} ${pkg.decision_id}; ${written.length} precedent(s) written to H-MEM, ${feedback.length} feedback update(s)`,
    details: { review: record },
  });
  return record;
}
