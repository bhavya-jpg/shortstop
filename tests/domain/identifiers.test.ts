import { describe, expect, it } from "vitest";
import { normalizeNdc } from "../../src/domain/ndc.ts";
import { parseDate } from "../../src/domain/dates.ts";
import { normalizeShortage, parseAvailability } from "../../src/domain/shortage.ts";

const prov = { dataset: "test", synthetic: false, retrieved_via: "sample-file" as const };

describe("normalizeNdc", () => {
  it.each([
    ["0409-6102-26", "00409-6102-26", "4-4-2"], // Hospira furosemide (real openFDA format)
    ["63323-089-50", "63323-0089-50", "5-3-2"], // Fresenius sodium bicarbonate
    ["51754-5011-4", "51754-5011-04", "5-4-1"], // Exela sodium bicarbonate
    ["55150-324-25", "55150-0324-25", "5-3-2"],
    ["00409610226", "00409-6102-26", "5-4-2"],
  ])("normalizes %s to %s (%s)", (raw, ndc11, layout) => {
    const r = normalizeNdc(raw);
    expect(r).toMatchObject({ ok: true, ndc11, layout });
  });

  it("keeps package identity distinct from product identity", () => {
    const a = normalizeNdc("0409-6102-26");
    const b = normalizeNdc("0409-6102-04");
    expect(a.ok && b.ok && a.product11 === b.product11 && a.ndc11 !== b.ndc11).toBe(true);
  });

  it.each(["", "0409610226", "409-6102-26", "ABCDE-1234-12", "12345-12-1", null, 12345])("rejects %s", (raw) => {
    expect(normalizeNdc(raw).ok).toBe(false);
  });
});

describe("parseDate", () => {
  it("parses the formats seen in openFDA and hospital data", () => {
    expect(parseDate("10/21/2026")).toBe("2026-10-21");
    expect(parseDate("20261021")).toBe("2026-10-21");
    expect(parseDate("2026-10-21")).toBe("2026-10-21");
  });
  it("rejects impossible and ambiguous dates", () => {
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("21-10-2026")).toBeNull();
    expect(parseDate("Oct 21 2026")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe("normalizeShortage", () => {
  it("parses availability including free-text values", () => {
    expect(parseAvailability("Unavailable")).toBe("UNAVAILABLE");
    expect(parseAvailability("Limited Availability")).toBe("LIMITED");
    expect(parseAvailability("Limited Supply Available. Next Delivery and Estimated Recovery: June 2027")).toBe("LIMITED");
    expect(parseAvailability("Available")).toBe("AVAILABLE");
    expect(parseAvailability("To be determined")).toBe("UNKNOWN");
  });

  it("records missing openfda block and bad dates as data issues", () => {
    const r = normalizeShortage(
      { package_ndc: "63323-671-00", update_date: "2026/10/15", availability: "Unavailable", generic_name: "Dexmedetomidine" },
      prov
    );
    expect(r.package_ndc).toBe("63323-0671-00");
    expect(r.has_openfda_block).toBe(false);
    expect(r.rxcui).toEqual([]);
    expect(r.update_date).toBeNull();
    expect(r.data_issues.join(" ")).toMatch(/openfda block missing/);
    expect(r.data_issues.join(" ")).toMatch(/update_date unparseable/);
  });

  it("keeps the record but nulls an invalid NDC instead of guessing", () => {
    const r = normalizeShortage({ package_ndc: "0409610226", update_date: "10/21/2026", openfda: { rxcui: ["1"] } }, prov);
    expect(r.package_ndc).toBeNull();
    expect(r.data_issues[0]).toMatch(/ambiguous/);
  });

  it("accepts rxcui flattened to a comma list (Zetaris view shape)", () => {
    const r = normalizeShortage(
      { package_ndc: "0409-6102-26", update_date: "10/08/2026", availability: "Unavailable", rxcui: "1719286, 1719290", has_openfda_block: "true" },
      prov
    );
    expect(r.rxcui).toEqual(["1719286", "1719290"]);
    expect(r.has_openfda_block).toBe(true);
  });
});
