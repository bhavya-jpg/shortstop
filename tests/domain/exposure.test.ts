import { describe, expect, it } from "vitest";
import { calculateExposure } from "../../src/domain/exposure.ts";
import { addDays } from "../../src/domain/dates.ts";
import type { InventoryRecord, UsageRecord } from "../../src/domain/types.ts";

const AS_OF = "2026-10-24";
const inv = (location_id: string, on_hand_units: number, as_of = AS_OF): InventoryRecord => ({
  item_id: "ITEM-1", location_id, on_hand_units, unit: "vial", as_of, synthetic: true,
});
// `days` daily rows ending the day before AS_OF.
const dailyUsage = (location_id: string, perDay: number, days = 14): UsageRecord[] =>
  Array.from({ length: days }, (_, i) => ({
    item_id: "ITEM-1", location_id, date: addDays(AS_OF, -(i + 1)), units_used: perDay, synthetic: true,
  }));

describe("calculateExposure", () => {
  it("computes days-on-hand for a single location", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 40)], dailyUsage("PHARM", 8), { asOf: AS_OF });
    expect(e.days_on_hand).toBe(5);
    expect(e.status).toBe("CRITICAL");
    expect(e.complete).toBe(true);
    expect(e.window).toEqual({ start: "2026-10-10", end: "2026-10-23", days: 14 });
    expect(e.calculation).toContain("40 units on hand / 8 units per day = 5 days");
  });

  it("pools multiple locations and reports the weakest location", () => {
    const e = calculateExposure(
      "ITEM-1",
      [inv("PHARM", 100), inv("ED", 4), inv("ICU", 50)],
      [...dailyUsage("PHARM", 2), ...dailyUsage("ED", 4), ...dailyUsage("ICU", 4)],
      { asOf: AS_OF }
    );
    expect(e.total_on_hand).toBe(154);
    expect(e.total_avg_daily_usage).toBe(10);
    expect(e.days_on_hand).toBe(15.4);
    expect(e.status).toBe("ADEQUATE");
    expect(e.min_location_days_on_hand).toBe(1);
    expect(e.locations.map((l) => l.location_id)).toEqual(["ED", "ICU", "PHARM"]);
  });

  it("classifies WARNING between the critical and warning thresholds", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 100)], dailyUsage("PHARM", 10), { asOf: AS_OF });
    expect(e.days_on_hand).toBe(10);
    expect(e.status).toBe("WARNING");
  });

  it("treats recorded zero usage as undefined days-on-hand, not infinite", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30)], dailyUsage("PHARM", 0), { asOf: AS_OF });
    expect(e.days_on_hand).toBeNull();
    expect(e.status).toBe("NO_RECENT_USAGE");
    expect(e.complete).toBe(true);
    expect(e.locations[0]!.status).toBe("ZERO_USAGE");
  });

  it("treats missing usage as unknown and marks the item UNKNOWN", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30), inv("ICU", 10)], dailyUsage("PHARM", 3), { asOf: AS_OF });
    const icu = e.locations.find((l) => l.location_id === "ICU")!;
    expect(icu.status).toBe("USAGE_MISSING");
    expect(icu.days_on_hand).toBeNull();
    expect(e.complete).toBe(false);
    expect(e.status).toBe("UNKNOWN");
    // The partial figure is still shown, computed only over complete locations.
    expect(e.days_on_hand).toBe(10);
    expect(e.issues).toContain("ICU: USAGE_MISSING");
  });

  it("treats missing inventory as unknown, never as zero stock", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30)], [...dailyUsage("PHARM", 3), ...dailyUsage("ED", 2)], {
      asOf: AS_OF,
    });
    const ed = e.locations.find((l) => l.location_id === "ED")!;
    expect(ed.status).toBe("INVENTORY_MISSING");
    expect(ed.on_hand_units).toBeNull();
    expect(e.status).toBe("UNKNOWN");
    expect(e.total_on_hand).toBe(30);
  });

  it("reports a declared location with no records at all", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30)], dailyUsage("PHARM", 3), { asOf: AS_OF }, ["PHARM", "OR"]);
    expect(e.locations.find((l) => l.location_id === "OR")!.status).toBe("INVENTORY_MISSING");
    expect(e.status).toBe("UNKNOWN");
  });

  it("flags sparse usage coverage as incomplete", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30)], dailyUsage("PHARM", 3, 4), { asOf: AS_OF });
    expect(e.locations[0]!.status).toBe("USAGE_INCOMPLETE");
    expect(e.status).toBe("UNKNOWN");
  });

  it("flags stale inventory counts", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 30, "2026-10-15")], dailyUsage("PHARM", 3), { asOf: AS_OF });
    expect(e.locations[0]!.status).toBe("INVENTORY_STALE");
    expect(e.status).toBe("UNKNOWN");
  });

  it("excludes invalid records and explains why", () => {
    const usage: UsageRecord[] = [
      ...dailyUsage("PHARM", 2),
      { item_id: "ITEM-1", location_id: "PHARM", date: "not-a-date", units_used: 5, synthetic: true },
      { item_id: "ITEM-1", location_id: "PHARM", date: "2026-10-20", units_used: -3, synthetic: true },
      { item_id: "ITEM-1", location_id: "PHARM", date: "2026-10-20", units_used: Number.NaN, synthetic: true },
    ];
    const e = calculateExposure(
      "ITEM-1",
      [inv("PHARM", 20), inv("PHARM", -5, "2026-10-23"), inv("PHARM", 10, "2026-13-01"), inv("PHARM", 99, "2026-10-30")],
      usage,
      { asOf: AS_OF }
    );
    expect(e.days_on_hand).toBe(10);
    expect(e.issues.filter((i) => i.includes("excluded"))).toHaveLength(6);
  });

  it("uses the latest inventory snapshot per location and the lower count on same-day conflicts", () => {
    const e = calculateExposure(
      "ITEM-1",
      [inv("PHARM", 50, "2026-10-23"), inv("PHARM", 20), inv("PHARM", 18)],
      dailyUsage("PHARM", 2),
      { asOf: AS_OF }
    );
    expect(e.locations[0]!.on_hand_units).toBe(18);
    expect(e.issues.some((i) => i.includes("two different counts"))).toBe(true);
  });

  it("returns zero days-on-hand when stock is exhausted", () => {
    const e = calculateExposure("ITEM-1", [inv("PHARM", 0)], dailyUsage("PHARM", 3), { asOf: AS_OF });
    expect(e.days_on_hand).toBe(0);
    expect(e.status).toBe("CRITICAL");
  });

  it("ignores usage outside the window, including the analysis day itself", () => {
    const usage: UsageRecord[] = [
      ...dailyUsage("PHARM", 2),
      { item_id: "ITEM-1", location_id: "PHARM", date: AS_OF, units_used: 500, synthetic: true },
      { item_id: "ITEM-1", location_id: "PHARM", date: "2026-09-01", units_used: 500, synthetic: true },
    ];
    const e = calculateExposure("ITEM-1", [inv("PHARM", 20)], usage, { asOf: AS_OF });
    expect(e.total_avg_daily_usage).toBe(2);
  });

  it("returns UNKNOWN when the item has no records and rejects invalid options", () => {
    expect(calculateExposure("ITEM-1", [], [], { asOf: AS_OF }).status).toBe("UNKNOWN");
    expect(() => calculateExposure("ITEM-1", [], [], { asOf: "24/10/2026" })).toThrow(/asOf/);
    expect(() => calculateExposure("ITEM-1", [], [], { asOf: AS_OF, windowDays: 0 })).toThrow(/windowDays/);
  });
});
