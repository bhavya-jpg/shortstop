// UNIT test of ZetarisDataSource row mapping, using the exact value shapes the
// live service returned on 2026-10-25 (NUMERIC as long decimal strings, booleans
// as "true"/"false", NULL as null). Fake transport; not a live test.
import { describe, expect, it } from "vitest";
import { ZetarisClient } from "../../src/adapters/zetaris.ts";
import { ZetarisDataSource } from "../../src/data/sources.ts";
import { Tracer } from "../../src/trace/tracer.ts";

const cfg = {
  restUrl: "http://x/api/v1.0", orgId: "1", apiKey: "k", timeoutMs: 1000, maxRetries: 0,
  tables: { shortages: "shortstop.shortages_v", formulary: "hospital_pg.formulary", inventory: "hospital_pg.inventory", usage: "hospital_pg.usage", policies: "hospital_pg.policies" },
};
const reply = (headers: string[], data: unknown[][]) => new Response(JSON.stringify({ headers, data, total: data.length, timeUsed: 1 }), { status: 200 });

describe("ZetarisDataSource mapping (live value shapes)", () => {
  it("maps hospital rows and openFDA view rows into typed records", async () => {
    const replies = [
      reply(["item_id", "ndc", "generic_name", "description", "dosage_form", "strength", "package_description", "status", "synthetic"], [["FUR-INJ-40", "0409-6102-26", "furosemide", "d", "inj", "10 mg/mL", "p", "active", "true"]]),
      reply(["item_id", "location_id", "on_hand_units", "unit", "as_of", "synthetic"], [["FUR-INJ-40", "ED", "6.000000000000000000", "vial", "2026-10-24", "true"]]),
      reply(["item_id", "location_id", "usage_date", "units_used", "synthetic"], [["FUR-INJ-40", "ED", "2026-10-23", "7.500000000000000000", "true"]]),
      reply(
        ["policy_id", "action", "applies_to_item_id", "target_item_id", "trigger_max_days_on_hand", "requirements", "approved_by", "effective_date", "expires_date", "status", "synthetic"],
        [
          ["POL-FUR-002", "RESTRICT_PER_POLICY", "FUR-INJ-40", null, "5.000000000000000000", "r", "a", "2025-01-15", null, "active", "true"],
          ["POL-X", "ORDER_SOMETHING", "FUR-INJ-40", null, "5", "r", "a", "2025-01-15", null, "active", "true"],
        ]
      ),
      reply(
        ["package_ndc", "generic_name", "presentation", "company_name", "dosage_form", "status", "availability", "shortage_reason", "update_date", "initial_posting_date", "rxcui", "has_openfda_block"],
        [["63323-671-00", "Dexmedetomidine", "p", "Fresenius", "Injection", "Current", "Unavailable", null, "10/15/2026", "01/01/2026", "", "false"]]
      ),
    ];
    const client = new ZetarisClient(cfg, { fetch: (async () => replies.shift()!) as typeof fetch });
    const ds = new ZetarisDataSource(cfg, new Tracer({ runId: "t", mode: "live" }), client);
    const h = await ds.loadHospital({ asOf: "2026-10-24", usageWindowDays: 14 });
    expect(h.inventory[0]).toMatchObject({ on_hand_units: 6, as_of: "2026-10-24", synthetic: true });
    expect(h.usage[0]).toMatchObject({ date: "2026-10-23", units_used: 7.5 });
    expect(h.policies).toHaveLength(1); // an unknown action type is dropped, never usable
    expect(h.policies[0]).toMatchObject({ trigger_max_days_on_hand: 5, status: "active" });
    expect(h.policies[0]!.target_item_id).toBeUndefined();
    expect(h.provenance).toMatchObject({ retrieved_via: "zetaris", synthetic: true });
    const s = await ds.loadShortages(["63323-671-00"]);
    expect(s.records[0]).toMatchObject({ package_ndc: "63323-0671-00", has_openfda_block: false, rxcui: [], update_date: "2026-10-15" });
    expect(s.records[0]!.provenance.retrieved_via).toBe("zetaris");
  });
});
