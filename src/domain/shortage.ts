// Normalizes raw openFDA drug-shortage records (from the API JSON, a snapshot
// file, or a Zetaris row mapped to the same field names) into ShortageRecord.
// Fields are optional in the real data: the `openfda` block is absent on some
// records, `shortage_reason` on most. Problems are recorded, never papered over.

import { parseDate } from "./dates.ts";
import { normalizeNdc } from "./ndc.ts";
import type { Availability, Provenance, ShortageRecord } from "./types.ts";

export function parseAvailability(raw: string): Availability {
  const s = raw.trim().toLowerCase();
  if (s === "") return "UNKNOWN";
  if (s.startsWith("unavailable") || s.startsWith("not available")) return "UNAVAILABLE";
  if (s.startsWith("limited")) return "LIMITED";
  if (s.startsWith("available")) return "AVAILABLE";
  return "UNKNOWN";
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function strList(x: unknown): string[] {
  if (Array.isArray(x)) return x.filter((v): v is string => typeof v === "string");
  if (typeof x === "string" && x.trim() !== "") return x.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

export function normalizeShortage(raw: unknown, provenance: Provenance): ShortageRecord {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const issues: string[] = [];

  const packageRaw = str(r.package_ndc);
  const ndc = normalizeNdc(packageRaw);
  if (!ndc.ok) issues.push(`package_ndc invalid: ${ndc.error}`);

  const updateRaw = str(r.update_date);
  const update = parseDate(updateRaw);
  if (!update) issues.push(`update_date unparseable: "${updateRaw}"`);

  const openfda = r.openfda && typeof r.openfda === "object" ? (r.openfda as Record<string, unknown>) : null;
  // Zetaris views flatten the nested block; accept a flattened rxcui column too.
  const rxcui = openfda ? strList(openfda.rxcui) : strList(r.rxcui);
  const hasOpenfda = openfda !== null || r.has_openfda_block === true || r.has_openfda_block === "true";
  if (!hasOpenfda) issues.push("openfda block missing: no RxCUI or NDC Directory cross-reference on this record");
  else if (rxcui.length === 0) issues.push("openfda block present but rxcui empty");

  const availabilityRaw = str(r.availability);
  const availability = parseAvailability(availabilityRaw);
  if (availability === "UNKNOWN") issues.push(`availability not recognized: "${availabilityRaw}"`);

  const generic = str(r.generic_name);
  return {
    record_key: `${ndc.ok ? ndc.ndc11 : packageRaw || "unknown-ndc"}@${update ?? (updateRaw || "unknown-date")}`,
    package_ndc_raw: packageRaw,
    package_ndc: ndc.ok ? ndc.ndc11 : null,
    product_ndc: ndc.ok ? ndc.product11 : null,
    generic_name: generic,
    presentation: str(r.presentation),
    company_name: str(r.company_name),
    dosage_form: str(r.dosage_form),
    status: str(r.status),
    availability_raw: availabilityRaw,
    availability,
    shortage_reason: str(r.shortage_reason) || null,
    update_date: update,
    update_date_raw: updateRaw,
    initial_posting_date: parseDate(r.initial_posting_date),
    rxcui,
    has_openfda_block: hasOpenfda,
    data_issues: issues,
    provenance,
  };
}
