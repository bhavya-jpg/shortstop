import { describe, expect, it } from "vitest";
import { validateCandidates } from "../../src/domain/policy.ts";
import { matchShortages } from "../../src/domain/matching.ts";
import { daily, item, policy, shortage, stock, validationContext } from "../helpers/fixtures.ts";

const switchToB = {
  action: "SWITCH_PRESENTATION",
  item_id: "A",
  policy_id: "POL-SWITCH",
  target_item_id: "B",
  rationale: "A has 3 days on hand; policy POL-SWITCH permits the 100 mg/10 mL presentation.",
  evidence_ids: ["EV-POLICY-POL-SWITCH", "EV-EXPOSURE-A", "EV-EXPOSURE-B"],
};
const codes = (r: ReturnType<typeof validateCandidates>, i = 0) => r.results[i]!.issues.map((x) => x.code);

describe("validateCandidates", () => {
  it("accepts a candidate backed by an applicable policy and existing evidence", () => {
    const r = validateCandidates([switchToB], validationContext());
    expect(r.results[0]!.issues).toEqual([]);
    expect(r.valid).toHaveLength(1);
    expect(r.results[0]!.checks.join(" | ")).toMatch(/trigger met: 3 days <= 7/);
  });

  it("rejects an action outside the permitted set", () => {
    const r = validateCandidates([{ ...switchToB, action: "ORDER_FROM_COMPOUNDER" }], validationContext());
    expect(codes(r)).toContain("ACTION_NOT_PERMITTED");
    expect(r.valid).toHaveLength(0);
  });

  it("rejects a permitted action that no policy record backs", () => {
    const r = validateCandidates(
      [{ action: "APPROVED_INTERCHANGE", item_id: "A", policy_id: "POL-MADE-UP", target_item_id: "B", rationale: "x", evidence_ids: ["EV-EXPOSURE-A"] }],
      validationContext()
    );
    expect(codes(r)).toContain("POLICY_NOT_FOUND");
  });

  it("rejects a policy whose action differs from the proposed action", () => {
    const r = validateCandidates([{ ...switchToB, action: "APPROVED_INTERCHANGE" }], validationContext());
    expect(codes(r)).toContain("POLICY_ACTION_MISMATCH");
  });

  it("rejects a policy action without a policy citation", () => {
    const { policy_id: _drop, ...noPolicy } = switchToB;
    expect(codes(validateCandidates([noPolicy], validationContext()))).toContain("POLICY_REQUIRED");
  });

  it("rejects evidence IDs that do not exist", () => {
    const r = validateCandidates([{ ...switchToB, evidence_ids: [...switchToB.evidence_ids, "EV-INV-A-NOWHERE"] }], validationContext());
    expect(codes(r)).toEqual(["EVIDENCE_NOT_FOUND"]);
  });

  it("requires the policy and exposure evidence to be cited", () => {
    const r = validateCandidates([{ ...switchToB, evidence_ids: ["EV-EXPOSURE-B"] }], validationContext());
    expect(codes(r).filter((c) => c === "MISSING_REQUIRED_EVIDENCE")).toHaveLength(2);
  });

  it("rejects when the trigger threshold is not met", () => {
    const ctx = validationContext({ inventory: [stock("A", "PHARM", 300), stock("B", "PHARM", 200)] });
    const r = validateCandidates([{ ...switchToB, rationale: "Switch per policy." }], ctx);
    expect(codes(r)).toContain("TRIGGER_NOT_MET");
  });

  it("never satisfies a trigger on unknown exposure", () => {
    const ctx = validationContext({ usage: [...daily("A", "PHARM", 10), ...daily("B", "PHARM", 2)], inventory: [stock("A", "PHARM", 30), stock("A", "ICU", 5), stock("B", "PHARM", 200)] });
    expect(ctx.exposure.status).toBe("UNKNOWN");
    const r = validateCandidates([{ ...switchToB, rationale: "Switch per policy." }], ctx);
    expect(codes(r)).toContain("EXPOSURE_UNKNOWN");
  });

  it("rejects retired, expired and not-yet-effective policies", () => {
    for (const [over, code] of [
      [{ status: "retired" as const }, "POLICY_RETIRED"],
      [{ expires_date: "2026-06-30" }, "POLICY_EXPIRED"],
      [{ effective_date: "2026-11-01" }, "POLICY_NOT_YET_EFFECTIVE"],
    ] as const) {
      const ctx = validationContext({ policies: [policy({ policy_id: "POL-SWITCH", action: "SWITCH_PRESENTATION", target_item_id: "B", ...over })] });
      expect(codes(validateCandidates([switchToB], ctx))).toContain(code);
    }
  });

  it("rejects a target the policy does not name, and targets without stock or in shortage", () => {
    expect(codes(validateCandidates([{ ...switchToB, target_item_id: "A" }], validationContext()))).toContain("TARGET_MISMATCH");
    const noStock = validationContext({ inventory: [stock("A", "PHARM", 30), stock("B", "PHARM", 0)] });
    expect(codes(validateCandidates([switchToB], noStock))).toContain("TARGET_NO_STOCK");
    const inShortage = validationContext({ targetShortage: shortage("55150-324-25", "Unavailable") });
    expect(codes(validateCandidates([switchToB], inShortage))).toContain("TARGET_IN_SHORTAGE");
  });

  it("rejects numeric claims that do not match the computed exposure", () => {
    const r = validateCandidates([{ ...switchToB, rationale: "Only 1.2 days on hand remain." }], validationContext());
    expect(codes(r)).toEqual(["UNSUPPORTED_NUMERIC_CLAIM"]);
  });

  it("caps the number of candidates and rejects duplicates", () => {
    const restrict = { action: "RESTRICT_PER_POLICY", item_id: "A", policy_id: "POL-RESTRICT", rationale: "Restrict per policy.", evidence_ids: ["EV-POLICY-POL-RESTRICT", "EV-EXPOSURE-A"] };
    const esc = { action: "ESCALATE", item_id: "A", rationale: "Needs a pharmacist.", evidence_ids: ["EV-EXPOSURE-A"] };
    const ctx = { ...validationContext(), maxCandidates: 2 };
    const r = validateCandidates([switchToB, switchToB, restrict, esc], ctx);
    expect(codes(r, 1)).toContain("DUPLICATE_CANDIDATE");
    expect(codes(r, 2)).toContain("TOO_MANY_CANDIDATES");
    expect(r.valid).toHaveLength(1);
  });

  it("accepts ESCALATE without a policy but rejects malformed input", () => {
    const ctx = validationContext();
    expect(validateCandidates([{ action: "ESCALATE", item_id: "A", rationale: "Unclear.", evidence_ids: ["EV-EXPOSURE-A"] }], ctx).valid).toHaveLength(1);
    expect(codes(validateCandidates(["not an object"], ctx))).toEqual(["MALFORMED_CANDIDATE"]);
    expect(codes(validateCandidates([{ action: "ESCALATE", item_id: "A", rationale: "", evidence_ids: [] }], ctx))).toEqual([
      "MISSING_RATIONALE",
      "MISSING_EVIDENCE",
    ]);
    expect(validateCandidates([], ctx).issues[0]!.code).toBe("NO_CANDIDATES");
  });
});

describe("matchShortages", () => {
  it("matches on exact normalized package NDC across formats", () => {
    const r = matchShortages([shortage("63323-089-50")], [item("BICARB", "63323-0089-50")]);
    expect(r.affected).toHaveLength(1);
    expect(r.affected[0]!.impact).toBe("affected");
  });

  it("flags another package of the same product for confirmation but does not join it", () => {
    const r = matchShortages([shortage("0409-6102-26")], [item("FUR-4ML", "0409-6102-04")]);
    expect(r.affected).toHaveLength(0);
    expect(r.related).toHaveLength(1);
    expect(r.related[0]!.match_type).toBe("same_product_different_package");
  });

  it("never matches on name alone", () => {
    const r = matchShortages(
      [shortage("0409-6102-26", "Unavailable", { generic_name: "Furosemide" })],
      [item("OTHER", "63323-280-04", { generic_name: "Furosemide" })]
    );
    expect(r.affected).toHaveLength(0);
    expect(r.related).toHaveLength(0);
  });

  it("marks listed-but-available packages and reports unmatchable records", () => {
    const r = matchShortages(
      [shortage("0409-6102-04", "Available"), shortage("0409610226")],
      [item("FUR-4ML", "0409-6102-04"), item("BAD", "12345")]
    );
    expect(r.affected[0]!.impact).toBe("listed_available");
    expect(r.issues.join(" ")).toMatch(/BAD/);
    expect(r.issues.join(" ")).toMatch(/no valid package NDC/);
  });
});
