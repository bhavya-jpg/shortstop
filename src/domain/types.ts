// Typed domain models for ShortStop. Every hospital record carries an explicit
// `synthetic` flag; public openFDA records carry their retrieval provenance.

export const PERMITTED_ACTIONS = [
  "RESTRICT_PER_POLICY",
  "SWITCH_PRESENTATION",
  "APPROVED_INTERCHANGE",
  "ALTERNATE_SOURCING",
  "ESCALATE",
] as const;
export type ActionType = (typeof PERMITTED_ACTIONS)[number];
// Every action except ESCALATE must be backed by an explicit policy record.
export type PolicyActionType = Exclude<ActionType, "ESCALATE">;
export const POLICY_ACTIONS: readonly PolicyActionType[] = [
  "RESTRICT_PER_POLICY",
  "SWITCH_PRESENTATION",
  "APPROVED_INTERCHANGE",
  "ALTERNATE_SOURCING",
];
// Actions that move use onto a different formulary item.
export const TARGETED_ACTIONS: readonly PolicyActionType[] = ["SWITCH_PRESENTATION", "APPROVED_INTERCHANGE"];

export function isActionType(x: unknown): x is ActionType {
  return typeof x === "string" && (PERMITTED_ACTIONS as readonly string[]).includes(x);
}

export type Mode = "sample" | "live";

export interface Provenance {
  dataset: string;
  synthetic: boolean;
  // How the record reached ShortStop. "zetaris" is only set for rows that a
  // real Zetaris SQL query returned.
  retrieved_via: "zetaris" | "sample-file" | "h-mem" | "computed";
  detail?: string;
}

// --- Hospital data (synthetic in this repository) ---------------------------

export interface FormularyItem {
  item_id: string;
  ndc: string; // as recorded by the hospital
  generic_name: string;
  description: string;
  dosage_form: string;
  strength: string;
  package_description: string;
  status: "active" | "inactive";
  synthetic: boolean;
}

export interface Location {
  location_id: string;
  name: string;
  synthetic: boolean;
}

export interface InventoryRecord {
  item_id: string;
  location_id: string;
  on_hand_units: number;
  unit: string;
  as_of: string; // ISO date
  synthetic: boolean;
}

// One row per item, location and day. A row with units_used = 0 means a
// recorded day with zero use; a day with no row means usage is unknown.
export interface UsageRecord {
  item_id: string;
  location_id: string;
  date: string; // ISO date
  units_used: number;
  synthetic: boolean;
}

export interface PolicyRecord {
  policy_id: string;
  action: PolicyActionType;
  applies_to_item_id: string;
  target_item_id?: string;
  // The policy may be invoked only when the item's days-on-hand is at or below this.
  trigger_max_days_on_hand: number;
  requirements: string;
  approved_by: string;
  effective_date: string;
  expires_date?: string;
  status: "active" | "retired";
  synthetic: boolean;
}

export interface HospitalData {
  formulary: FormularyItem[];
  locations: Location[];
  inventory: InventoryRecord[];
  usage: UsageRecord[];
  policies: PolicyRecord[];
  provenance: Provenance;
}

// --- Public shortage data (openFDA drug shortages) ---------------------------

export type Availability = "UNAVAILABLE" | "LIMITED" | "AVAILABLE" | "UNKNOWN";

export interface ShortageRecord {
  record_key: string;
  package_ndc_raw: string;
  package_ndc: string | null; // normalized 5-4-2, null when the raw value is invalid
  product_ndc: string | null; // normalized 5-4
  generic_name: string;
  presentation: string;
  company_name: string;
  dosage_form: string;
  status: string;
  availability_raw: string;
  availability: Availability;
  shortage_reason: string | null;
  update_date: string | null; // ISO date, null when unparseable
  update_date_raw: string;
  initial_posting_date: string | null;
  rxcui: string[];
  has_openfda_block: boolean;
  data_issues: string[];
  provenance: Provenance;
}

// --- Exposure ------------------------------------------------------------------

export type LocationExposureStatus =
  | "OK"
  | "ZERO_USAGE"
  | "USAGE_MISSING"
  | "USAGE_INCOMPLETE"
  | "INVENTORY_MISSING"
  | "INVENTORY_STALE";

export interface LocationExposure {
  location_id: string;
  on_hand_units: number | null;
  inventory_as_of: string | null;
  usage_days_covered: number;
  usage_units_in_window: number;
  avg_daily_usage: number | null;
  days_on_hand: number | null;
  status: LocationExposureStatus;
  notes: string[];
}

export type ExposureStatus = "CRITICAL" | "WARNING" | "ADEQUATE" | "NO_RECENT_USAGE" | "UNKNOWN";

export interface ItemExposure {
  item_id: string;
  as_of: string;
  window: { start: string; end: string; days: number };
  total_on_hand: number | null;
  total_avg_daily_usage: number | null;
  days_on_hand: number | null;
  min_location_days_on_hand: number | null;
  complete: boolean;
  status: ExposureStatus;
  locations: LocationExposure[];
  issues: string[];
  calculation: string;
}

// --- Evidence, decisions and review ------------------------------------------

export type EvidenceKind = "shortage" | "formulary" | "inventory" | "usage" | "exposure" | "policy" | "precedent";

export interface EvidenceRef {
  evidence_id: string;
  kind: EvidenceKind;
  summary: string;
  synthetic: boolean;
  provenance: Provenance;
  data: Record<string, unknown>;
}

export interface CandidateAction {
  action: ActionType;
  item_id: string;
  policy_id?: string;
  target_item_id?: string;
  rationale: string;
  evidence_ids: string[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  candidate_index?: number;
}

export interface CandidateValidation {
  candidate: CandidateAction;
  valid: boolean;
  issues: ValidationIssue[];
  checks: string[];
}

export interface CriticIssue {
  code: string;
  message: string;
  candidate_index?: number;
}

export interface CriticVerdict {
  verdict: "accept" | "revise" | "escalate";
  issues: CriticIssue[];
  agent: string;
}

export type DecisionStatus = "PENDING_APPROVAL" | "ESCALATED" | "MONITOR_PENDING_ACKNOWLEDGEMENT";

export type ReviewOutcome = "approved" | "rejected" | "acknowledged";
