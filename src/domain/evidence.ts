// Builds the evidence bundle for one affected item. Evidence IDs are derived
// from the underlying record keys, so the same data always yields the same IDs
// and a cited ID can be checked against the bundle mechanically.

import type {
  EvidenceRef,
  FormularyItem,
  HospitalData,
  ItemExposure,
  PolicyRecord,
  ShortageRecord,
} from "./types.ts";

export const evidenceId = {
  shortage: (s: ShortageRecord) => `EV-SHORTAGE-${s.package_ndc ?? s.package_ndc_raw}-${s.update_date ?? "nodate"}`,
  formulary: (itemId: string) => `EV-FORMULARY-${itemId}`,
  inventory: (itemId: string, loc: string) => `EV-INV-${itemId}-${loc}`,
  usage: (itemId: string, loc: string) => `EV-USAGE-${itemId}-${loc}`,
  exposure: (itemId: string) => `EV-EXPOSURE-${itemId}`,
  policy: (policyId: string) => `EV-POLICY-${policyId}`,
  precedent: (memoryId: string) => `EV-PRECEDENT-${memoryId}`,
};

export interface PrecedentEvidenceInput {
  memory_id: string;
  content: string;
  synthetic: boolean;
  outcome: string;
  action: string;
  confidence: number;
  superseded_by?: string;
  source_ref: string;
}

export interface EvidenceBundleInput {
  item: FormularyItem;
  shortage: ShortageRecord;
  exposure: ItemExposure;
  hospital: HospitalData;
  policies: PolicyRecord[]; // policies that apply to this item
  targets: { item: FormularyItem; exposure: ItemExposure; shortage?: ShortageRecord }[];
  precedents: PrecedentEvidenceInput[];
}

export class EvidenceBundle {
  private byId = new Map<string, EvidenceRef>();

  add(ref: EvidenceRef): void {
    if (this.byId.has(ref.evidence_id)) return; // stable IDs: duplicates are the same evidence
    this.byId.set(ref.evidence_id, ref);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  get(id: string): EvidenceRef | undefined {
    return this.byId.get(id);
  }
  ids(): string[] {
    return [...this.byId.keys()];
  }
  all(): EvidenceRef[] {
    return [...this.byId.values()];
  }
}

export function buildEvidence(input: EvidenceBundleInput): EvidenceBundle {
  const b = new EvidenceBundle();
  const { item, shortage, exposure, hospital } = input;
  const hp = hospital.provenance;

  b.add({
    evidence_id: evidenceId.shortage(shortage),
    kind: "shortage",
    summary:
      `openFDA shortage record: ${shortage.presentation || shortage.generic_name} (${shortage.company_name}), ` +
      `availability "${shortage.availability_raw}", updated ${shortage.update_date ?? shortage.update_date_raw}` +
      (shortage.shortage_reason ? `, reason: ${shortage.shortage_reason}` : ""),
    synthetic: shortage.provenance.synthetic,
    provenance: shortage.provenance,
    data: { ...shortage, provenance: undefined },
  });
  addItemEvidence(b, item, exposure, hospital);
  for (const t of input.targets) {
    addItemEvidence(b, t.item, t.exposure, hospital);
    if (t.shortage) {
      b.add({
        evidence_id: evidenceId.shortage(t.shortage),
        kind: "shortage",
        summary: `openFDA shortage record for alternative ${t.item.item_id}: availability "${t.shortage.availability_raw}"`,
        synthetic: t.shortage.provenance.synthetic,
        provenance: t.shortage.provenance,
        data: { ...t.shortage, provenance: undefined },
      });
    }
  }
  for (const p of input.policies) {
    b.add({
      evidence_id: evidenceId.policy(p.policy_id),
      kind: "policy",
      summary:
        `${p.synthetic ? "SYNTHETIC " : ""}policy ${p.policy_id}: ${p.action} for ${p.applies_to_item_id}` +
        (p.target_item_id ? ` -> ${p.target_item_id}` : "") +
        ` when days-on-hand <= ${p.trigger_max_days_on_hand}; ${p.status}; ${p.requirements}`,
      synthetic: p.synthetic,
      provenance: hp,
      data: { ...p },
    });
  }
  for (const pr of input.precedents) {
    b.add({
      evidence_id: evidenceId.precedent(pr.memory_id),
      kind: "precedent",
      summary: `${pr.synthetic ? "SYNTHETIC " : ""}precedent ${pr.memory_id} (${pr.outcome} ${pr.action}, confidence ${pr.confidence.toFixed(2)}${pr.superseded_by ? `, superseded by ${pr.superseded_by}` : ""}): ${pr.content}`,
      synthetic: pr.synthetic,
      provenance: { dataset: "h-mem precedents", synthetic: pr.synthetic, retrieved_via: "h-mem", detail: pr.source_ref },
      data: { ...pr },
    });
  }
  return b;
}

function addItemEvidence(b: EvidenceBundle, item: FormularyItem, exposure: ItemExposure, hospital: HospitalData): void {
  const hp = hospital.provenance;
  b.add({
    evidence_id: evidenceId.formulary(item.item_id),
    kind: "formulary",
    summary: `${item.synthetic ? "SYNTHETIC " : ""}formulary item ${item.item_id}: ${item.description} (NDC ${item.ndc})`,
    synthetic: item.synthetic,
    provenance: hp,
    data: { ...item },
  });
  for (const loc of exposure.locations) {
    if (loc.on_hand_units !== null) {
      b.add({
        evidence_id: evidenceId.inventory(item.item_id, loc.location_id),
        kind: "inventory",
        summary: `${hp.synthetic ? "SYNTHETIC " : ""}inventory ${item.item_id} @ ${loc.location_id}: ${loc.on_hand_units} units as of ${loc.inventory_as_of}`,
        synthetic: hp.synthetic,
        provenance: hp,
        data: { location_id: loc.location_id, on_hand_units: loc.on_hand_units, as_of: loc.inventory_as_of },
      });
    }
    if (loc.usage_days_covered > 0) {
      b.add({
        evidence_id: evidenceId.usage(item.item_id, loc.location_id),
        kind: "usage",
        summary: `${hp.synthetic ? "SYNTHETIC " : ""}usage ${item.item_id} @ ${loc.location_id}: ${loc.usage_units_in_window} units over ${loc.usage_days_covered} recorded days (${exposure.window.start}..${exposure.window.end})`,
        synthetic: hp.synthetic,
        provenance: hp,
        data: {
          location_id: loc.location_id,
          units: loc.usage_units_in_window,
          days_covered: loc.usage_days_covered,
          avg_daily_usage: loc.avg_daily_usage,
        },
      });
    }
  }
  b.add({
    evidence_id: evidenceId.exposure(item.item_id),
    kind: "exposure",
    summary: `exposure ${item.item_id}: ${exposure.status}; ${exposure.calculation}`,
    synthetic: hp.synthetic,
    provenance: { dataset: "computed from inventory and usage", synthetic: hp.synthetic, retrieved_via: "computed" },
    data: { ...exposure },
  });
}
