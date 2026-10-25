// Agent interfaces. The workflow depends only on these, so a deterministic
// sample agent and a Nightshift-backed LLM agent are interchangeable.

import type {
  ActionType,
  CandidateAction,
  CandidateValidation,
  CriticVerdict,
  EvidenceRef,
  FormularyItem,
  ItemExposure,
  PolicyRecord,
  ShortageRecord,
} from "../domain/types.ts";
import type { Precedent, PrecedentConflict } from "../memory/precedents.ts";

// "llm" agents call Nightshift. "deterministic" agents are rule-based and make
// no model call; they exist for sample mode and are labelled as such.
export type AgentKind = "llm" | "deterministic";

export interface ModelCall {
  requested: string;
  reported: string | null;
  meterless: unknown;
  routing_headers: Record<string, string>;
  response_id: string | null;
  attempts: number;
  duration_ms: number;
  http_status: number;
}

export interface PlannerRequest {
  run_id: string;
  decision_id: string;
  revision: number;
  item: FormularyItem;
  shortage: ShortageRecord;
  exposure: ItemExposure;
  permitted_actions: readonly ActionType[];
  policies: readonly PolicyRecord[];
  evidence: readonly EvidenceRef[];
  precedents: readonly Precedent[];
  lineage: readonly Precedent[];
  precedent_conflicts: readonly PrecedentConflict[];
  max_candidates: number;
  feedback: readonly string[];
  previous_candidates: readonly unknown[];
}

export interface PlannerResult {
  candidates: unknown[]; // untrusted until the validator has checked them
  model?: ModelCall;
  notes?: string;
}

export interface Planner {
  readonly name: string;
  readonly kind: AgentKind;
  propose(req: PlannerRequest): Promise<PlannerResult>;
}

export interface CriticRequest extends PlannerRequest {
  candidates: readonly CandidateAction[]; // only candidates that passed validation
  validation: readonly CandidateValidation[];
}

export interface CriticResult {
  verdict: CriticVerdict;
  model?: ModelCall;
}

export interface Critic {
  readonly name: string;
  readonly kind: AgentKind;
  review(req: CriticRequest): Promise<CriticResult>;
}
