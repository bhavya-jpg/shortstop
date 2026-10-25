// ShortStop precedent memory, built on the vendored Meterless H-MEM reference
// engine (vendor/hmem, Apache-2.0). This adapter only uses the engine's public
// API; ranking, feedback deltas, persistence and the trust ledger are the
// engine's own behavior.
//
// Mapping onto H-MEM:
//   precedent           -> one memory record (type "factual", layer "long_term")
//   formulary item      -> the record's chatId scope ("item:<id>"), so recall for
//                          one item never returns another item's precedents
//   structured fields   -> tags ("action:...", "outcome:...", "policy:...")
//   origin of the fact  -> provenance {origin, label, refs}
//   pharmacist decision -> feedback(helpful | not_helpful | wrong)
//   explicit replacement-> new record with `supersedes`, old record marked
//                          `supersededBy` (kept and penalized, never deleted)

import { HMEM } from "../../vendor/hmem/reference/src/index.ts";
import type { FeedbackKind, LedgerEntry, MemoryRecord } from "../../vendor/hmem/reference/src/index.ts";
import type { ActionType } from "../domain/types.ts";
import { isActionType } from "../domain/types.ts";

export type PrecedentOutcome = "approved" | "rejected";

export interface PrecedentInput {
  item_id: string;
  generic_name: string;
  ndc: string;
  action: ActionType;
  policy_id?: string;
  outcome: PrecedentOutcome;
  summary: string;
  decided_at: string; // ISO date of the original decision
  decided_by: string;
  synthetic: boolean;
  source_ref: string; // e.g. "seed:data/synthetic/precedents.json#P-001" or "review:<review_id>"
  origin: "manual" | "user_correction" | "plan_completion";
}

export interface Precedent {
  memory_id: string;
  content: string;
  item_id: string;
  action: ActionType | "UNKNOWN";
  policy_id?: string;
  outcome: PrecedentOutcome | "unknown";
  synthetic: boolean;
  confidence: number;
  supersedes?: string;
  superseded_by?: string;
  source_ref: string;
  provenance_label: string;
  decided_at?: string;
  tags: string[];
  relevance?: number;
}

export interface PrecedentConflict {
  memory_a: string;
  memory_b: string;
  reason: string;
}

export interface RecallResult {
  precedents: Precedent[];
  lineage: Precedent[]; // superseded records that recalled precedents replaced
  conflicts: PrecedentConflict[];
  trace: { query: string; scope: string; strategy: string; scores: Record<string, number>; retrieval_reason: string };
}

export interface PrecedentMemoryOptions {
  persistDir?: string;
  clock?: () => number;
  actor?: string;
}

const scopeOf = (itemId: string) => `item:${itemId}`;
const tagValue = (tags: string[], key: string) => tags.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);

export function precedentContent(p: Pick<PrecedentInput, "outcome" | "generic_name" | "item_id" | "ndc" | "action" | "policy_id" | "summary">): string {
  return (
    `Shortage precedent for ${p.generic_name} ${p.item_id} (NDC ${p.ndc}): ${p.action} was ${p.outcome}` +
    `${p.policy_id ? ` under policy ${p.policy_id}` : ""}. ${p.summary}`
  );
}

export function recallQuery(genericName: string, itemId: string, ndc: string): string {
  return `Shortage precedent for ${genericName} ${itemId} (NDC ${ndc})`;
}

export class PrecedentMemory {
  readonly hmem: HMEM;

  constructor(opts: PrecedentMemoryOptions = {}) {
    const hmemOpts: ConstructorParameters<typeof HMEM>[0] = { actor: opts.actor ?? "shortstop" };
    if (opts.persistDir) hmemOpts.persistDir = opts.persistDir;
    if (opts.clock) hmemOpts.clock = opts.clock;
    this.hmem = new HMEM(hmemOpts);
  }

  add(input: PrecedentInput, supersedes?: string): Precedent {
    if (!input.source_ref.trim()) throw new Error("precedent requires a source_ref (provenance)");
    const tags = [
      "precedent",
      `item:${input.item_id}`,
      `action:${input.action}`,
      `outcome:${input.outcome}`,
      `decided:${input.decided_at}`,
      input.synthetic ? "synthetic" : "recorded",
      ...(input.policy_id ? [`policy:${input.policy_id}`] : []),
    ];
    const record = this.hmem.add({
      content: precedentContent(input),
      type: "factual",
      layer: "long_term",
      tags,
      confidence: 0.8,
      source: input.source_ref,
      provenance: {
        origin: input.origin,
        learnedAt: Date.parse(`${input.decided_at}T00:00:00Z`) || this.hmem.clock(),
        label: `${input.synthetic ? "SYNTHETIC " : ""}${input.outcome} by ${input.decided_by} on ${input.decided_at}`,
        refs: [input.source_ref],
      },
      chatId: scopeOf(input.item_id),
      ...(supersedes ? { supersedes } : {}),
    });
    return toPrecedent(record);
  }

  // Replace an existing precedent with a new one. The old record stays in the
  // store, is marked supersededBy (the engine's -0.20 retrieval penalty) and the
  // resolution is written to the trust ledger with previous and new state.
  supersede(oldId: string, input: PrecedentInput, reason: string, resolvedBy: string): { replacement: Precedent; superseded: Precedent } {
    const old = this.hmem.store.get(oldId);
    if (!old) throw new Error(`unknown precedent ${oldId}`);
    if (old.supersededBy) throw new Error(`precedent ${oldId} is already superseded by ${old.supersededBy}`);
    if (old.chatId !== scopeOf(input.item_id)) throw new Error(`precedent ${oldId} belongs to ${old.chatId}, not ${scopeOf(input.item_id)}`);
    const replacement = this.add(input, oldId);
    const updated = this.hmem.store.update(oldId, { supersededBy: replacement.memory_id });
    this.hmem.ledger.log(oldId, "conflict_resolved", resolvedBy, {
      details: { winner: replacement.memory_id, resolution: "keep_b", resolved_by: "human", reason },
    });
    return { replacement, superseded: toPrecedent(updated) };
  }

  recall(item: { item_id: string; generic_name: string; ndc: string }, opts: { topN?: number } = {}): RecallResult {
    const query = recallQuery(item.generic_name, item.item_id, item.ndc);
    const scope = scopeOf(item.item_id);
    const result = this.hmem.query(query, { chatId: scope, topN: opts.topN ?? 5 });
    // The engine admits unscoped records into any scope; keep only this item's precedents.
    const precedents = result.memories
      .filter(({ memory }) => memory.chatId === scope && memory.tags.includes("precedent"))
      .map(({ memory, relevance }) => ({ ...toPrecedent(memory), relevance: Number(relevance.toFixed(4)) }));
    // Superseded ancestors rank below the threshold by design; surface them as
    // lineage so the reviewer can see what a recalled precedent replaced.
    const lineage: Precedent[] = [];
    for (const p of precedents) {
      let prev = p.supersedes;
      while (prev && !lineage.some((l) => l.memory_id === prev)) {
        const ancestor = this.get(prev);
        if (!ancestor) break;
        lineage.push(ancestor);
        prev = ancestor.supersedes;
      }
    }
    return {
      precedents,
      lineage,
      conflicts: this.findConflicts(item.item_id),
      trace: {
        query,
        scope,
        strategy: result.trace.strategy,
        scores: result.trace.scores,
        retrieval_reason: result.trace.retrievalReason,
      },
    };
  }

  // Precedents for the same item and action with opposite outcomes, neither
  // superseded, are an unresolved conflict. The engine's own heuristic scan
  // looks for opposing phrases; this check is the domain-specific equivalent.
  // Each pair is written to the ledger once as conflict_detected.
  findConflicts(itemId: string): PrecedentConflict[] {
    const live = this.forItem(itemId).filter((p) => !p.superseded_by);
    const out: PrecedentConflict[] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        if (a.action === b.action && a.outcome !== b.outcome && a.policy_id === b.policy_id) {
          const reason = `same item and action (${a.action}) with opposite outcomes: ${a.memory_id} ${a.outcome}, ${b.memory_id} ${b.outcome}`;
          out.push({ memory_a: a.memory_id, memory_b: b.memory_id, reason });
          const logged = this.hmem.ledger
            .history(a.memory_id)
            .some((e) => e.action === "conflict_detected" && e.details?.with === b.memory_id);
          if (!logged) {
            this.hmem.ledger.log(a.memory_id, "conflict_detected", "shortstop", { details: { with: b.memory_id, reason } });
          }
        }
      }
    }
    return out;
  }

  feedback(memoryId: string, kind: FeedbackKind): Precedent {
    this.hmem.feedback(memoryId, kind);
    return this.get(memoryId)!;
  }

  get(memoryId: string): Precedent | undefined {
    const r = this.hmem.store.get(memoryId);
    return r ? toPrecedent(r) : undefined;
  }

  forItem(itemId: string): Precedent[] {
    return this.hmem.store
      .all()
      .filter((m) => m.chatId === scopeOf(itemId) && m.tags.includes("precedent"))
      .map(toPrecedent)
      .sort((a, b) => a.memory_id.localeCompare(b.memory_id, undefined, { numeric: true }));
  }

  all(): Precedent[] {
    return this.hmem.store.all().filter((m) => m.tags.includes("precedent")).map(toPrecedent);
  }

  history(memoryId: string): LedgerEntry[] {
    return this.hmem.ledger.history(memoryId);
  }

  hasSource(sourceRef: string): boolean {
    return this.hmem.store.all().some((m) => m.source === sourceRef);
  }
}

function toPrecedent(m: MemoryRecord): Precedent {
  const action = tagValue(m.tags, "action");
  const outcome = tagValue(m.tags, "outcome");
  const p: Precedent = {
    memory_id: m.id,
    content: m.content,
    item_id: tagValue(m.tags, "item") ?? m.chatId?.replace(/^item:/, "") ?? "",
    action: isActionType(action) ? action : "UNKNOWN",
    outcome: outcome === "approved" || outcome === "rejected" ? outcome : "unknown",
    synthetic: m.tags.includes("synthetic"),
    confidence: Number(m.confidence.toFixed(4)),
    source_ref: m.source,
    provenance_label: m.provenance.label,
    tags: [...m.tags],
  };
  const policy = tagValue(m.tags, "policy");
  if (policy) p.policy_id = policy;
  const decided = tagValue(m.tags, "decided");
  if (decided) p.decided_at = decided;
  if (m.supersedes) p.supersedes = m.supersedes;
  if (m.supersededBy) p.superseded_by = m.supersededBy;
  return p;
}
