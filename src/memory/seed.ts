// Loads the SYNTHETIC historical precedents into H-MEM. Idempotent: a seed
// whose source_ref is already stored is skipped. Replacements are written with
// PrecedentMemory.supersede, so the history is the same as a live supersession.

import fs from "node:fs";
import path from "node:path";
import type { ActionType, FormularyItem } from "../domain/types.ts";
import type { PrecedentMemory, PrecedentOutcome } from "./precedents.ts";

interface SeedRecord {
  key: string;
  item_id: string;
  action: ActionType;
  policy_id?: string;
  outcome: PrecedentOutcome;
  decided_at: string;
  decided_by: string;
  summary: string;
  supersedes_key?: string;
  supersede_reason?: string;
  synthetic: boolean;
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const SEED_FILE = path.join(repoRoot, "data", "synthetic", "precedents.json");
const refOf = (key: string) => `seed:data/synthetic/precedents.json#${key}`;

// Seeds using the synthetic formulary file for item descriptions. Used in live
// mode too: the precedent history is part of the declared synthetic dataset.
export function seedSyntheticPrecedents(memory: PrecedentMemory): { added: number; skipped: number } {
  const formulary = (JSON.parse(fs.readFileSync(path.join(repoRoot, "data", "synthetic", "formulary.json"), "utf-8")) as { records: FormularyItem[] }).records;
  return seedPrecedents(memory, formulary);
}

export function seedPrecedents(memory: PrecedentMemory, formulary: readonly FormularyItem[], file = SEED_FILE): { added: number; skipped: number } {
  const body = JSON.parse(fs.readFileSync(file, "utf-8")) as { synthetic: boolean; records: SeedRecord[] };
  if (body.synthetic !== true) throw new Error(`${file} is not labelled synthetic`);
  let added = 0;
  let skipped = 0;
  for (const s of body.records) {
    const ref = refOf(s.key);
    if (memory.hasSource(ref)) {
      skipped++;
      continue;
    }
    const item = formulary.find((f) => f.item_id === s.item_id);
    if (!item) throw new Error(`seed ${s.key}: item ${s.item_id} is not on the formulary`);
    const input = {
      item_id: s.item_id,
      generic_name: item.description,
      ndc: item.ndc,
      action: s.action,
      ...(s.policy_id ? { policy_id: s.policy_id } : {}),
      outcome: s.outcome,
      summary: s.summary,
      decided_at: s.decided_at,
      decided_by: s.decided_by,
      synthetic: s.synthetic,
      source_ref: ref,
      origin: "manual" as const,
    };
    if (s.supersedes_key) {
      const old = memory.all().find((p) => p.source_ref === refOf(s.supersedes_key!));
      if (!old) throw new Error(`seed ${s.key}: superseded seed ${s.supersedes_key} not found`);
      memory.supersede(old.memory_id, input, s.supersede_reason ?? "superseded", s.decided_by);
    } else {
      memory.add(input);
    }
    added++;
  }
  return { added, skipped };
}
