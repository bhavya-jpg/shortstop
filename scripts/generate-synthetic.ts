// Generates the SYNTHETIC hospital dataset used by sample mode and the scenarios.
//   npm run data:synthetic
// Deterministic (no randomness): re-running produces byte-identical files.
// The hospital, its stock, usage, policies and precedents are invented.
// Product NDCs are real FDA package NDCs so they can be joined to real openFDA
// shortage records; that the hospital stocks them is fiction.

import fs from "node:fs";
import path from "node:path";
import { addDays } from "../src/domain/dates.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "data", "synthetic");
const AS_OF = "2026-10-24";
const WINDOW = 14;
const NOTICE =
  "SYNTHETIC DATA. Invented for the ShortStop demonstration. Not a real hospital, not real stock or usage, " +
  "not real policy, not clinical guidance. NDCs are real FDA package codes used only as join keys.";

const formulary = [
  { item_id: "FUR-INJ-40", ndc: "0409-6102-26", generic_name: "furosemide", description: "Furosemide injection 10 mg/mL, 4 mL single-dose vial (Hospira)", dosage_form: "Injection, solution", strength: "10 mg/mL", package_description: "25 x 4 mL single-dose vials" },
  { item_id: "FUR-INJ-100", ndc: "55150-324-25", generic_name: "furosemide", description: "Furosemide injection 10 mg/mL, 10 mL vial (Eugia)", dosage_form: "Injection, solution", strength: "100 mg/10 mL", package_description: "25 x 10 mL vials" },
  { item_id: "BICARB-50", ndc: "0409-6625-35", generic_name: "sodium bicarbonate", description: "Sodium bicarbonate 8.4% injection, 50 mL single-dose vial (Hospira)", dosage_form: "Injection, solution", strength: "84 mg/mL", package_description: "25 x 50 mL single-dose vials" },
  { item_id: "BICARB-50-FK", ndc: "63323-089-50", generic_name: "sodium bicarbonate", description: "Sodium bicarbonate 8.4% injection, 50 mL single-dose vial (Fresenius Kabi)", dosage_form: "Injection, solution", strength: "84 mg/mL", package_description: "25 x 50 mL single-dose vials" },
  { item_id: "DEXMED-4", ndc: "63323-671-00", generic_name: "dexmedetomidine", description: "Dexmedetomidine HCl injection 4 mcg/mL (Fresenius Kabi)", dosage_form: "Injection", strength: "4 mcg/mL", package_description: "as recorded by the hospital" },
  { item_id: "DEXMED-PX-50", ndc: "0409-1454-20", generic_name: "dexmedetomidine", description: "Precedex (dexmedetomidine) 200 mcg/50 mL bottle (Pfizer)", dosage_form: "Injection, solution", strength: "4 mcg/mL", package_description: "20 x 50 mL bottles" },
].map((f) => ({ ...f, status: "active", synthetic: true }));

const locations = [
  { location_id: "PHARM", name: "Central pharmacy" },
  { location_id: "ED", name: "Emergency department" },
  { location_id: "ICU", name: "Intensive care unit" },
  { location_id: "MEDSURG", name: "Medical-surgical ward" },
  { location_id: "OR", name: "Operating rooms" },
].map((l) => ({ ...l, synthetic: true }));

// [item, location, on hand, average daily use, usage rows present?]
const stockPlan: [string, string, number, number, boolean][] = [
  // Scenario 1: furosemide 4 mL vials critically low; 100 mg vials plentiful.
  ["FUR-INJ-40", "PHARM", 30, 4, true],
  ["FUR-INJ-40", "ED", 6, 6, true],
  ["FUR-INJ-40", "ICU", 12, 8, true],
  ["FUR-INJ-40", "MEDSURG", 8, 4, true],
  ["FUR-INJ-100", "PHARM", 120, 1, true],
  ["FUR-INJ-100", "ICU", 20, 1, true],
  // Scenario 2: sodium bicarbonate in national shortage, but this hospital holds ~6 weeks.
  ["BICARB-50", "PHARM", 400, 2, true],
  ["BICARB-50", "ED", 60, 6, true],
  ["BICARB-50", "ICU", 80, 4, true],
  ["BICARB-50-FK", "PHARM", 50, 0, true],
  // Scenario 3: dexmedetomidine with the ICU usage feed missing.
  ["DEXMED-4", "PHARM", 10, 1, true],
  ["DEXMED-4", "ICU", 6, 5, false],
  ["DEXMED-4", "OR", 4, 2, true],
  ["DEXMED-PX-50", "PHARM", 40, 1, true],
];

// Weekly shape around the average, so daily rows vary but the 14-day mean is exact.
const WEEK = [1.25, 1, 0.75, 1, 1.25, 1, 0.75];

const inventory = stockPlan.map(([item_id, location_id, on_hand_units]) => ({
  item_id, location_id, on_hand_units, unit: "vial", as_of: AS_OF, synthetic: true,
}));
const usage = stockPlan.flatMap(([item_id, location_id, , avg, present]) =>
  present
    ? Array.from({ length: WINDOW }, (_, i) => ({
        item_id,
        location_id,
        date: addDays(AS_OF, -(i + 1)),
        units_used: Math.round(avg * (WEEK[i % 7] ?? 1) * 4) / 4,
        synthetic: true,
      }))
    : []
);

const policies = [
  { policy_id: "POL-FUR-001", action: "SWITCH_PRESENTATION", applies_to_item_id: "FUR-INJ-40", target_item_id: "FUR-INJ-100", trigger_max_days_on_hand: 7,
    requirements: "Pharmacy prepares doses from the 100 mg/10 mL vial. Smart-pump library entry for the 10 mL vial must be active. Independent double check before release.",
    approved_by: "Synthetic P&T Committee", effective_date: "2025-01-15" },
  { policy_id: "POL-FUR-002", action: "RESTRICT_PER_POLICY", applies_to_item_id: "FUR-INJ-40", trigger_max_days_on_hand: 5,
    requirements: "Reserve remaining 4 mL vials for inpatient units and the ED. Outpatient infusion orders need pharmacist approval while the restriction is active.",
    approved_by: "Synthetic P&T Committee", effective_date: "2025-01-15" },
  { policy_id: "POL-FUR-003", action: "ALTERNATE_SOURCING", applies_to_item_id: "FUR-INJ-40", trigger_max_days_on_hand: 10,
    requirements: "Request allocation from the contracted secondary wholesaler (synthetic 'Wholesaler B'). Purchasing places the order; ShortStop does not.",
    approved_by: "Synthetic Supply Chain Committee", effective_date: "2025-06-01" },
  { policy_id: "POL-FUR-OLD", action: "APPROVED_INTERCHANGE", applies_to_item_id: "FUR-INJ-40", target_item_id: "FUR-INJ-100", trigger_max_days_on_hand: 7,
    requirements: "Superseded 2024 interchange policy.", approved_by: "Synthetic P&T Committee", effective_date: "2024-01-01", expires_date: "2024-12-31", status: "retired" },
  { policy_id: "POL-BIC-001", action: "ALTERNATE_SOURCING", applies_to_item_id: "BICARB-50", trigger_max_days_on_hand: 10,
    requirements: "Request allocation from the contracted secondary wholesaler.", approved_by: "Synthetic Supply Chain Committee", effective_date: "2025-06-01" },
  { policy_id: "POL-DEX-001", action: "ALTERNATE_SOURCING", applies_to_item_id: "DEXMED-4", trigger_max_days_on_hand: 7,
    requirements: "Request allocation from the contracted secondary wholesaler.", approved_by: "Synthetic Supply Chain Committee", effective_date: "2025-06-01" },
  { policy_id: "POL-DEX-002", action: "SWITCH_PRESENTATION", applies_to_item_id: "DEXMED-4", target_item_id: "DEXMED-PX-50", trigger_max_days_on_hand: 7,
    requirements: "Use premixed 200 mcg/50 mL bottles; smart-pump library entry required.", approved_by: "Synthetic P&T Committee", effective_date: "2025-01-15" },
].map((p) => ({ status: "active", ...p, synthetic: true }));

// Historical precedents (all synthetic). `supersedes_key` links a replacement to the record it replaced.
const precedents = [
  { key: "P-001", item_id: "FUR-INJ-40", action: "SWITCH_PRESENTATION", policy_id: "POL-FUR-001", outcome: "approved", decided_at: "2025-03-12", decided_by: "Synthetic pharmacist (clinical manager)",
    summary: "Switched to 100 mg/10 mL vials for 3 weeks during a 2025 shortage." },
  { key: "P-002", item_id: "FUR-INJ-40", action: "SWITCH_PRESENTATION", policy_id: "POL-FUR-001", outcome: "approved", decided_at: "2025-11-03", decided_by: "Synthetic pharmacist (medication safety)",
    summary: "Switch approved again with an added independent double check after a near-miss labelling event.", supersedes_key: "P-001",
    supersede_reason: "medication-safety review added a double-check requirement" },
  { key: "P-003", item_id: "FUR-INJ-40", action: "RESTRICT_PER_POLICY", policy_id: "POL-FUR-002", outcome: "approved", decided_at: "2025-03-14", decided_by: "Synthetic pharmacist (clinical manager)",
    summary: "Restricted 4 mL vials to inpatient units and the ED for 3 weeks." },
  { key: "P-004", item_id: "BICARB-50", action: "ALTERNATE_SOURCING", policy_id: "POL-BIC-001", outcome: "approved", decided_at: "2024-08-20", decided_by: "Synthetic buyer with pharmacist sign-off",
    summary: "Allocation from the secondary wholesaler arrived in 4 days." },
  { key: "P-005", item_id: "DEXMED-4", action: "ALTERNATE_SOURCING", policy_id: "POL-DEX-001", outcome: "rejected", decided_at: "2026-02-10", decided_by: "Synthetic pharmacist (ICU)",
    summary: "Secondary wholesaler lead time was 12 days, too slow to help." },
  { key: "P-006", item_id: "DEXMED-4", action: "ALTERNATE_SOURCING", policy_id: "POL-DEX-001", outcome: "approved", decided_at: "2026-06-18", decided_by: "Synthetic pharmacist (OR)",
    summary: "Secondary wholesaler delivered in 2 days." },
].map((p) => ({ ...p, synthetic: true }));

function write(name: string, records: unknown[]) {
  const body = { synthetic: true, notice: NOTICE, generated_by: "scripts/generate-synthetic.ts", as_of: AS_OF, records };
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(body, null, 2) + "\n");
  console.log(`wrote data/synthetic/${name} (${records.length} records)`);
}

fs.mkdirSync(outDir, { recursive: true });
write("formulary.json", formulary);
write("locations.json", locations);
write("inventory.json", inventory);
write("usage.json", usage);
write("policies.json", policies);
write("precedents.json", precedents);
