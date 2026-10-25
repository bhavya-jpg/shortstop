// Small hand-built fixtures for unit tests. Synthetic; not the demo dataset.
import { addDays } from "../../src/domain/dates.ts";
import { calculateExposure } from "../../src/domain/exposure.ts";
import { buildEvidence } from "../../src/domain/evidence.ts";
import { normalizeShortage } from "../../src/domain/shortage.ts";
import type { ValidationContext } from "../../src/domain/policy.ts";
import type {
  FormularyItem,
  HospitalData,
  InventoryRecord,
  PolicyRecord,
  ShortageRecord,
  UsageRecord,
} from "../../src/domain/types.ts";

export const AS_OF = "2026-10-24";

export const item = (item_id: string, ndc: string, extra: Partial<FormularyItem> = {}): FormularyItem => ({
  item_id,
  ndc,
  generic_name: "testamine",
  description: `${item_id} test product`,
  dosage_form: "Injection",
  strength: "10 mg/mL",
  package_description: "vial",
  status: "active",
  synthetic: true,
  ...extra,
});

export const shortage = (package_ndc: string, availability = "Unavailable", extra: Record<string, unknown> = {}): ShortageRecord =>
  normalizeShortage(
    { package_ndc, availability, update_date: "10/21/2026", generic_name: "Testamine", openfda: { rxcui: ["1"] }, ...extra },
    { dataset: "test openFDA", synthetic: false, retrieved_via: "sample-file" }
  );

export const daily = (item_id: string, location_id: string, perDay: number, days = 14): UsageRecord[] =>
  Array.from({ length: days }, (_, i) => ({
    item_id, location_id, date: addDays(AS_OF, -(i + 1)), units_used: perDay, synthetic: true,
  }));

export const stock = (item_id: string, location_id: string, on_hand_units: number): InventoryRecord => ({
  item_id, location_id, on_hand_units, unit: "vial", as_of: AS_OF, synthetic: true,
});

export const policy = (p: Partial<PolicyRecord> & Pick<PolicyRecord, "policy_id" | "action">): PolicyRecord => ({
  applies_to_item_id: "A",
  trigger_max_days_on_hand: 7,
  requirements: "test requirement",
  approved_by: "Test P&T (synthetic)",
  effective_date: "2026-01-01",
  status: "active",
  synthetic: true,
  ...p,
});

// Item A is in shortage with 3 days on hand; B is an alternative presentation with stock.
export function validationContext(over: { policies?: PolicyRecord[]; inventory?: InventoryRecord[]; usage?: UsageRecord[]; targetShortage?: ShortageRecord } = {}): ValidationContext {
  const formulary = [item("A", "0409-6102-26"), item("B", "55150-324-25")];
  const inventory = over.inventory ?? [stock("A", "PHARM", 30), stock("B", "PHARM", 200)];
  const usage = over.usage ?? [...daily("A", "PHARM", 10), ...daily("B", "PHARM", 2)];
  const policies = over.policies ?? [
    policy({ policy_id: "POL-SWITCH", action: "SWITCH_PRESENTATION", target_item_id: "B" }),
    policy({ policy_id: "POL-RESTRICT", action: "RESTRICT_PER_POLICY" }),
  ];
  const hospital: HospitalData = {
    formulary, locations: [], inventory, usage, policies,
    provenance: { dataset: "test hospital", synthetic: true, retrieved_via: "sample-file" },
  };
  const exA = calculateExposure("A", inventory, usage, { asOf: AS_OF });
  const exB = calculateExposure("B", inventory, usage, { asOf: AS_OF });
  const shortages = new Map<string, ShortageRecord>([["A", shortage("0409-6102-26")]]);
  if (over.targetShortage) shortages.set("B", over.targetShortage);
  const evidence = buildEvidence({
    item: formulary[0]!,
    shortage: shortages.get("A")!,
    exposure: exA,
    hospital,
    policies,
    targets: [{ item: formulary[1]!, exposure: exB }],
    precedents: [],
  });
  return {
    item: formulary[0]!,
    exposure: exA,
    policies,
    formulary,
    exposures: new Map([["A", exA], ["B", exB]]),
    shortagesByItem: shortages,
    evidence,
    asOf: AS_OF,
    maxCandidates: 3,
  };
}
