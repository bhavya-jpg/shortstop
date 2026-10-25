// Feature-level tests: H-MEM powering ShortStop precedent memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrecedentMemory, type PrecedentInput } from "../../src/memory/precedents.ts";

const NOW = Date.parse("2026-10-24T00:00:00Z");
const clock = () => NOW;
let dir: string;

const fur = (over: Partial<PrecedentInput> = {}): PrecedentInput => ({
  item_id: "FUR-INJ-40",
  generic_name: "Furosemide injection 10 mg/mL",
  ndc: "0409-6102-26",
  action: "SWITCH_PRESENTATION",
  policy_id: "POL-FUR-001",
  outcome: "approved",
  summary: "Switched to 100 mg/10 mL vials; smart-pump library entry required.",
  decided_at: "2025-03-12",
  decided_by: "Synthetic pharmacist A",
  synthetic: true,
  source_ref: "test#P-001",
  origin: "manual",
  ...over,
});
const furItem = { item_id: "FUR-INJ-40", generic_name: "Furosemide injection 10 mg/mL", ndc: "0409-6102-26" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-hmem-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("PrecedentMemory (H-MEM)", () => {
  it("stores a precedent with explicit provenance and rejects one without", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    const p = m.add(fur());
    expect(p.source_ref).toBe("test#P-001");
    expect(p.provenance_label).toBe("SYNTHETIC approved by Synthetic pharmacist A on 2025-03-12");
    expect(p.synthetic).toBe(true);
    const raw = m.hmem.store.get(p.memory_id)!;
    expect(raw.provenance.origin).toBe("manual");
    expect(raw.provenance.refs).toEqual(["test#P-001"]);
    expect(raw.layer).toBe("long_term");
    expect(() => m.add(fur({ source_ref: " " }))).toThrow(/source_ref/);
  });

  it("persists precedents across restarts and recalls them in a new instance", () => {
    const first = new PrecedentMemory({ persistDir: dir, clock });
    const p = first.add(fur());
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "ledger.jsonl"))).toBe(true);

    const second = new PrecedentMemory({ persistDir: dir, clock });
    const r = second.recall(furItem);
    expect(r.precedents.map((x) => x.memory_id)).toEqual([p.memory_id]);
    expect(r.precedents[0]!.relevance).toBeGreaterThanOrEqual(0.35); // the engine's default threshold
    expect(r.trace.scope).toBe("item:FUR-INJ-40");
    // The read is audited and survives another restart.
    const third = new PrecedentMemory({ persistDir: dir, clock });
    expect(third.history(p.memory_id).map((e) => e.action)).toEqual(["create", "read"]);
  });

  it("scopes recall to the item: another item's precedent is never returned", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    m.add(fur());
    m.add(fur({ item_id: "BICARB-50", generic_name: "Sodium bicarbonate 8.4% injection", ndc: "0409-6625-35", source_ref: "test#P-009" }));
    const r = m.recall(furItem);
    expect(r.precedents.every((p) => p.item_id === "FUR-INJ-40")).toBe(true);
    expect(r.precedents).toHaveLength(1);
  });

  it("supersedes a precedent without deleting it, with an auditable history", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    const old = m.add(fur());
    const { replacement, superseded } = m.supersede(
      old.memory_id,
      fur({ summary: "Switch approved only with an independent double check.", decided_at: "2025-11-03", source_ref: "test#P-004", origin: "user_correction" }),
      "medication-safety review added a double check",
      "Synthetic pharmacist B"
    );
    expect(superseded.superseded_by).toBe(replacement.memory_id);
    expect(replacement.supersedes).toBe(old.memory_id);

    const reopened = new PrecedentMemory({ persistDir: dir, clock });
    expect(reopened.get(old.memory_id)).toBeDefined(); // kept, not deleted
    const r = reopened.recall(furItem);
    expect(r.precedents.map((p) => p.memory_id)).toEqual([replacement.memory_id]);
    expect(r.lineage.map((p) => p.memory_id)).toEqual([old.memory_id]);

    const hist = reopened.history(old.memory_id);
    expect(hist.map((e) => e.action)).toEqual(["create", "update", "conflict_resolved"]);
    expect(hist[1]!.previousState?.supersededBy).toBeUndefined();
    expect(hist[1]!.newState?.supersededBy).toBe(replacement.memory_id);
    expect(hist[2]!.details).toMatchObject({ winner: replacement.memory_id, resolved_by: "human" });
    expect(() => reopened.supersede(old.memory_id, fur({ source_ref: "test#P-005" }), "again", "x")).toThrow(/already superseded/);
  });

  it("applies the engine's documented feedback deltas and persists them", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    const p = m.add(fur());
    expect(p.confidence).toBe(0.8);
    expect(m.feedback(p.memory_id, "helpful").confidence).toBe(0.85);
    expect(m.feedback(p.memory_id, "not_helpful").confidence).toBe(0.82);
    const wrong = m.feedback(p.memory_id, "wrong");
    expect(wrong.confidence).toBe(0.62);
    expect(wrong.tags).toContain("review");

    const reopened = new PrecedentMemory({ persistDir: dir, clock });
    expect(reopened.get(p.memory_id)!.confidence).toBe(0.62);
    const fb = reopened.history(p.memory_id).filter((e) => e.action === "feedback");
    expect(fb.map((e) => e.details?.kind)).toEqual(["helpful", "not_helpful", "wrong"]);
    expect(fb[2]!.previousState?.confidence).toBeCloseTo(0.82);
    expect(fb[2]!.newState?.confidence).toBeCloseTo(0.62);
  });

  it("lower confidence after 'wrong' feedback lowers the precedent's recall ranking", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    const p = m.add(fur());
    const before = m.recall(furItem).precedents[0]!.relevance!;
    m.feedback(p.memory_id, "wrong");
    const after = m.recall(furItem).precedents.find((x) => x.memory_id === p.memory_id)?.relevance ?? 0;
    expect(after).toBeLessThan(before);
  });

  it("detects conflicting precedents once and leaves them unresolved for a human", () => {
    const m = new PrecedentMemory({ persistDir: dir, clock });
    const a = m.add(fur({ action: "ALTERNATE_SOURCING", policy_id: "POL-X", outcome: "rejected", source_ref: "test#P-010" }));
    const b = m.add(fur({ action: "ALTERNATE_SOURCING", policy_id: "POL-X", outcome: "approved", source_ref: "test#P-011" }));
    const r1 = m.recall(furItem);
    expect(r1.conflicts).toHaveLength(1);
    expect(r1.conflicts[0]).toMatchObject({ memory_a: a.memory_id, memory_b: b.memory_id });
    m.recall(furItem);
    expect(m.history(a.memory_id).filter((e) => e.action === "conflict_detected")).toHaveLength(1);
    // Superseding one side resolves the conflict.
    m.supersede(a.memory_id, fur({ action: "ALTERNATE_SOURCING", policy_id: "POL-X", outcome: "approved", source_ref: "test#P-012" }), "resolved", "x");
    expect(m.recall(furItem).conflicts).toEqual([]);
  });
});
