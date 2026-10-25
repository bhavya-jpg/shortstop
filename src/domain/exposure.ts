// Deterministic stock-exposure calculation. Pure functions, no I/O.
//
// Per location:  avg_daily_usage = units used in window / days with a usage row
//                days_on_hand    = on_hand_units / avg_daily_usage
// Per item:      days_on_hand    = sum(on_hand) / sum(avg_daily_usage), over the
//                locations where both values are known.
//
// Unknown is never treated as zero: missing inventory or missing usage makes the
// result incomplete, and an incomplete result has status UNKNOWN so that no
// policy trigger can be satisfied on partial data.

import { addDays, daysBetween, parseDate } from "./dates.ts";
import type {
  ExposureStatus,
  InventoryRecord,
  ItemExposure,
  LocationExposure,
  LocationExposureStatus,
  UsageRecord,
} from "./types.ts";

export interface ExposureOptions {
  asOf: string; // ISO date the analysis is run for
  windowDays?: number; // usage look-back, ending the day before asOf
  minCoverageRatio?: number; // fraction of window days that must have a usage row
  staleInventoryDays?: number; // inventory older than this is stale
  criticalDays?: number;
  warningDays?: number;
}

export const EXPOSURE_DEFAULTS = {
  windowDays: 14,
  minCoverageRatio: 0.5,
  staleInventoryDays: 2,
  criticalDays: 7,
  warningDays: 14,
} as const;

const round2 = (x: number) => Math.round(x * 100) / 100;

export function calculateExposure(
  itemId: string,
  inventory: readonly InventoryRecord[],
  usage: readonly UsageRecord[],
  opts: ExposureOptions,
  declaredLocations: readonly string[] = []
): ItemExposure {
  const asOf = parseDate(opts.asOf);
  if (!asOf) throw new Error(`calculateExposure: invalid asOf date "${opts.asOf}"`);
  const windowDays = opts.windowDays ?? EXPOSURE_DEFAULTS.windowDays;
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error(`calculateExposure: windowDays must be a positive integer`);
  const minCoverage = opts.minCoverageRatio ?? EXPOSURE_DEFAULTS.minCoverageRatio;
  const staleDays = opts.staleInventoryDays ?? EXPOSURE_DEFAULTS.staleInventoryDays;
  const criticalDays = opts.criticalDays ?? EXPOSURE_DEFAULTS.criticalDays;
  const warningDays = opts.warningDays ?? EXPOSURE_DEFAULTS.warningDays;

  const windowEnd = addDays(asOf, -1);
  const windowStart = addDays(asOf, -windowDays);
  const issues: string[] = [];

  // --- Validate and select inventory: latest valid snapshot per location. ---
  const invByLoc = new Map<string, InventoryRecord>();
  for (const rec of inventory) {
    if (rec.item_id !== itemId) continue;
    const date = parseDate(rec.as_of);
    if (!Number.isFinite(rec.on_hand_units) || rec.on_hand_units < 0) {
      issues.push(`inventory ${rec.location_id}: invalid on_hand_units ${String(rec.on_hand_units)}; record excluded`);
      continue;
    }
    if (!date) {
      issues.push(`inventory ${rec.location_id}: invalid as_of "${rec.as_of}"; record excluded`);
      continue;
    }
    if (date > asOf) {
      issues.push(`inventory ${rec.location_id}: as_of ${date} is after the analysis date; record excluded`);
      continue;
    }
    const prev = invByLoc.get(rec.location_id);
    if (!prev || date > prev.as_of) invByLoc.set(rec.location_id, { ...rec, as_of: date });
    else if (date === prev.as_of && prev.on_hand_units !== rec.on_hand_units) {
      issues.push(`inventory ${rec.location_id}: two different counts for ${date}; using the lower count`);
      if (rec.on_hand_units < prev.on_hand_units) invByLoc.set(rec.location_id, { ...rec, as_of: date });
    }
  }

  // --- Validate and aggregate usage inside the window. ---
  const usageByLoc = new Map<string, { units: number; days: Set<string> }>();
  for (const rec of usage) {
    if (rec.item_id !== itemId) continue;
    const date = parseDate(rec.date);
    if (!date) {
      issues.push(`usage ${rec.location_id}: invalid date "${rec.date}"; row excluded`);
      continue;
    }
    if (!Number.isFinite(rec.units_used) || rec.units_used < 0) {
      issues.push(`usage ${rec.location_id} ${date}: invalid units_used ${String(rec.units_used)}; row excluded`);
      continue;
    }
    if (date < windowStart || date > windowEnd) continue;
    const agg = usageByLoc.get(rec.location_id) ?? { units: 0, days: new Set<string>() };
    agg.units += rec.units_used;
    agg.days.add(date);
    usageByLoc.set(rec.location_id, agg);
  }

  const locationIds = [...new Set([...declaredLocations, ...invByLoc.keys(), ...usageByLoc.keys()])].sort();
  const locations: LocationExposure[] = locationIds.map((loc) => {
    const inv = invByLoc.get(loc);
    const use = usageByLoc.get(loc);
    const notes: string[] = [];
    const daysCovered = use?.days.size ?? 0;
    const units = use?.units ?? 0;
    const avg = daysCovered > 0 ? units / daysCovered : null;
    let status: LocationExposureStatus = "OK";

    if (!inv) {
      status = "INVENTORY_MISSING";
      notes.push("no valid inventory record; stock is unknown, not zero");
    } else if (daysBetween(inv.as_of, asOf) > staleDays) {
      status = "INVENTORY_STALE";
      notes.push(`inventory count from ${inv.as_of} is older than ${staleDays} days`);
    }
    if (daysCovered === 0) {
      if (status === "OK") status = "USAGE_MISSING";
      notes.push(`no usage rows between ${windowStart} and ${windowEnd}; usage is unknown, not zero`);
    } else if (daysCovered < Math.ceil(windowDays * minCoverage)) {
      if (status === "OK") status = "USAGE_INCOMPLETE";
      notes.push(`usage rows cover ${daysCovered} of ${windowDays} days (minimum ${Math.ceil(windowDays * minCoverage)})`);
    } else if (avg === 0 && status === "OK") {
      status = "ZERO_USAGE";
      notes.push("recorded usage is zero across the window; days-on-hand is not defined");
    }

    const daysOnHand = inv && avg !== null && avg > 0 ? round2(inv.on_hand_units / avg) : null;
    return {
      location_id: loc,
      on_hand_units: inv ? inv.on_hand_units : null,
      inventory_as_of: inv ? inv.as_of : null,
      usage_days_covered: daysCovered,
      usage_units_in_window: units,
      avg_daily_usage: avg === null ? null : round2(avg),
      days_on_hand: daysOnHand,
      status,
      notes,
    };
  });

  if (locations.length === 0) issues.push("no inventory or usage records for this item");

  // Locations missing either input, or with stale or sparse data, make the item result incomplete.
  const incompleteLocs = locations.filter((l) => l.status !== "OK" && l.status !== "ZERO_USAGE");
  for (const l of incompleteLocs) issues.push(`${l.location_id}: ${l.status}`);
  const complete = locations.length > 0 && incompleteLocs.length === 0;

  const known = locations.filter((l) => l.on_hand_units !== null && l.avg_daily_usage !== null);
  const totalOnHand = locations.some((l) => l.on_hand_units !== null)
    ? locations.reduce((s, l) => s + (l.on_hand_units ?? 0), 0)
    : null;
  const totalAvg = known.length > 0 ? known.reduce((s, l) => s + (l.avg_daily_usage ?? 0), 0) : null;
  const knownOnHand = known.reduce((s, l) => s + (l.on_hand_units ?? 0), 0);
  const daysOnHand = totalAvg !== null && totalAvg > 0 ? round2(knownOnHand / totalAvg) : null;
  const locDoh = locations.map((l) => l.days_on_hand).filter((d): d is number => d !== null);
  const minLocDoh = locDoh.length > 0 ? Math.min(...locDoh) : null;

  let status: ExposureStatus;
  if (!complete) status = "UNKNOWN";
  else if (totalAvg === 0 || totalAvg === null) status = "NO_RECENT_USAGE";
  else if (daysOnHand !== null && daysOnHand <= criticalDays) status = "CRITICAL";
  else if (daysOnHand !== null && daysOnHand <= warningDays) status = "WARNING";
  else status = "ADEQUATE";

  const calculation =
    daysOnHand === null
      ? `days-on-hand not computable (${complete ? "no recorded usage" : "incomplete data"})`
      : `${knownOnHand} units on hand / ${round2(totalAvg ?? 0)} units per day = ${daysOnHand} days ` +
        `(usage window ${windowStart}..${windowEnd}, ${known.length} of ${locations.length} locations with complete data)`;

  return {
    item_id: itemId,
    as_of: asOf,
    window: { start: windowStart, end: windowEnd, days: windowDays },
    total_on_hand: totalOnHand,
    total_avg_daily_usage: totalAvg === null ? null : round2(totalAvg),
    days_on_hand: daysOnHand,
    min_location_days_on_hand: minLocDoh,
    complete,
    status,
    locations,
    issues,
    calculation,
  };
}
