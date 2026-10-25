// Identifies formulary items affected by shortage records.
//
// Only an exact normalized package NDC match counts as "affected". A shortage
// record for another package of the same product (same labeler and product
// code) is reported as "needs confirmation" and never joined automatically.
// Names are never used for matching: similar names do not make two products
// the same or interchangeable.

import { normalizeNdc } from "./ndc.ts";
import type { FormularyItem, ShortageRecord } from "./types.ts";

export interface AffectedItem {
  item: FormularyItem;
  item_ndc11: string;
  shortage: ShortageRecord;
  match_type: "exact_package_ndc";
  // AVAILABLE means the package is listed on the shortage report but its own
  // availability is reported as available: monitor, but no urgent action.
  impact: "affected" | "listed_available";
}

export interface RelatedMatch {
  item: FormularyItem;
  shortage: ShortageRecord;
  match_type: "same_product_different_package";
  note: string;
}

export interface MatchResult {
  affected: AffectedItem[];
  related: RelatedMatch[];
  issues: string[];
}

export function matchShortages(shortages: readonly ShortageRecord[], formulary: readonly FormularyItem[]): MatchResult {
  const issues: string[] = [];
  const items: { item: FormularyItem; ndc11: string; product11: string }[] = [];
  for (const item of formulary) {
    if (item.status !== "active") continue;
    const n = normalizeNdc(item.ndc);
    if (!n.ok) {
      issues.push(`formulary ${item.item_id}: ${n.error}; item cannot be matched`);
      continue;
    }
    items.push({ item, ndc11: n.ndc11, product11: n.product11 });
  }

  const affected: AffectedItem[] = [];
  const related: RelatedMatch[] = [];
  for (const s of shortages) {
    if (!s.package_ndc || !s.product_ndc) {
      issues.push(`shortage record ${s.record_key}: no valid package NDC; it cannot be matched to the formulary`);
      continue;
    }
    for (const f of items) {
      if (f.ndc11 === s.package_ndc) {
        affected.push({
          item: f.item,
          item_ndc11: f.ndc11,
          shortage: s,
          match_type: "exact_package_ndc",
          impact: s.availability === "AVAILABLE" ? "listed_available" : "affected",
        });
      } else if (f.product11 === s.product_ndc) {
        related.push({
          item: f.item,
          shortage: s,
          match_type: "same_product_different_package",
          note: `shortage lists package ${s.package_ndc}; formulary stocks ${f.ndc11} of the same product. Pharmacist confirmation needed.`,
        });
      }
    }
  }
  return { affected, related, issues };
}
