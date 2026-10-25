// Workflow tests. Sample-mode tests use the bundled data and deterministic
// agents. Tests marked "fixture" use scripted planners/critics or a fake chat
// transport: they are UNIT tests of the control flow, not live model tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NightshiftCritic, NightshiftPlanner, type ChatTransport } from "../../src/agents/llm.ts";
import { CompositeCritic, DeterministicPolicyPlanner, PrecedentCritic } from "../../src/agents/sample.ts";
import type { Critic, Planner, PlannerRequest } from "../../src/agents/types.ts";
import type { ChatResult } from "../../src/adapters/nightshift.ts";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { SampleDataSource, type DataSource } from "../../src/data/sources.ts";
import { PrecedentMemory } from "../../src/memory/precedents.ts";
import { seedPrecedents } from "../../src/memory/seed.ts";
import { Tracer } from "../../src/trace/tracer.ts";
import { recordReview, ReviewStore } from "../../src/workflow/review.ts";
import { runWorkflow, type RunInput, type WorkflowDeps } from "../../src/workflow/run.ts";

const scenario = (name: string): RunInput => JSON.parse(fs.readFileSync(path.join("input_examples", `${name}.json`), "utf-8")).input;
const FUROSEMIDE = scenario("scenario-1-furosemide");
const BICARB = scenario("scenario-2-sodium-bicarbonate");
const DEXMED = scenario("scenario-3-dexmedetomidine");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-wf-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function deps(over: Partial<WorkflowDeps> = {}, runId = "run-test"): Promise<WorkflowDeps> {
  const data = new SampleDataSource();
  const memory = new PrecedentMemory({ persistDir: path.join(dir, "hmem") });
  seedPrecedents(memory, (await data.loadHospital()).formulary);
  return {
    mode: "sample",
    maxRevisions: 2,
    maxCandidates: 3,
    data,
    memory,
    planner: new DeterministicPolicyPlanner(),
    critic: new PrecedentCritic(),
    tracer: new Tracer({ runId, mode: "sample" }),
    ...over,
  };
}

describe("sample-mode scenarios", () => {
  it("three inputs produce different, evidence-grounded outcomes", async () => {
    const d = await deps();
    const runs = [await runWorkflow(FUROSEMIDE, d), await runWorkflow(BICARB, d), await runWorkflow(DEXMED, d)];
    expect(runs.map((r) => r.decisions.map((x) => x.status))).toEqual([["PENDING_APPROVAL"], ["MONITOR_PENDING_ACKNOWLEDGEMENT"], ["ESCALATED"]]);

    const fur = runs[0]!.decisions[0]!;
    expect(fur.exposure.days_on_hand).toBe(2.55);
    expect(fur.candidates.map((c) => c.action)).toEqual(["SWITCH_PRESENTATION", "RESTRICT_PER_POLICY", "ALTERNATE_SOURCING"]);
    expect(fur.superseded_precedents.map((p) => p.source_ref)).toEqual(["seed:data/synthetic/precedents.json#P-001"]);
    // The retired 2024 interchange policy is never proposed.
    expect(fur.candidates.some((c) => c.policy_id === "POL-FUR-OLD")).toBe(false);

    const bic = runs[1]!.decisions[0]!;
    expect(bic.exposure.days_on_hand).toBe(45);
    expect(bic.candidates).toEqual([]);

    const dex = runs[2]!.decisions[0]!;
    expect(dex.exposure.status).toBe("UNKNOWN");
    expect(dex.precedent_conflicts).toHaveLength(1);
    expect(dex.escalation_reasons.join(" ")).toMatch(/USAGE_MISSING/);
    expect(dex.limitations.join(" ")).toMatch(/no openfda cross-reference/);

    for (const pkg of runs.flatMap((r) => r.decisions)) {
      const ids = new Set(pkg.evidence.map((e) => e.evidence_id));
      for (const c of pkg.candidates) for (const id of c.evidence_ids) expect(ids.has(id)).toBe(true);
      expect(pkg.requires_human_review).toBe(true);
    }
  });

  it("labels sample mode and records no external calls or model traces", async () => {
    const d = await deps();
    const run = await runWorkflow(FUROSEMIDE, d);
    expect(run.mode).toBe("sample");
    expect(run.notice).toMatch(/No Zetaris query and no Nightshift model call/);
    expect(run.agents.find((a) => a.name === "DeterministicPolicyPlanner")!.kind).toBe("deterministic");
    expect(run.decisions[0]!.model_calls).toEqual([]);
    const events = d.tracer.all();
    expect(events.every((e) => e.mode === "sample" && e.external_call === false)).toBe(true);
    expect(events.some((e) => "model" in e)).toBe(false);
    expect(events.map((e) => e.stage)).toEqual(
      expect.arrayContaining(["RETRIEVE_DATA", "IDENTIFY_AFFECTED", "CALCULATE_EXPOSURE", "RECALL_PRECEDENTS", "BUILD_EVIDENCE", "PLAN", "VALIDATE", "CRITIQUE", "PACKAGE", "COMPLETE"])
    );
  });

  it("returns no decision for an NDC that is not on the formulary", async () => {
    const run = await runWorkflow({ as_of: "2026-10-24", trigger: { package_ndc: "0409-6102-04" } }, await deps());
    expect(run.status).toBe("success");
    expect(run.decisions).toEqual([]);
  });
});

// --- fixture agents (unit tests of the control loop) -------------------------

const validSwitch = (req: PlannerRequest) => ({
  action: "SWITCH_PRESENTATION", item_id: req.item.item_id, policy_id: "POL-FUR-001", target_item_id: "FUR-INJ-100",
  rationale: "Switch per policy.", evidence_ids: ["EV-POLICY-POL-FUR-001", `EV-EXPOSURE-${req.item.item_id}`, "EV-EXPOSURE-FUR-INJ-100", ...req.precedents.filter((p) => p.action === "SWITCH_PRESENTATION").map((p) => `EV-PRECEDENT-${p.memory_id}`)],
});
const scripted = (fn: (req: PlannerRequest, call: number) => unknown[]): Planner & { requests: PlannerRequest[] } => {
  const requests: PlannerRequest[] = [];
  return { name: "FixturePlanner", kind: "deterministic", requests, propose: async (req) => (requests.push(req), { candidates: fn(req, requests.length) }) };
};
const fixedCritic = (verdict: "accept" | "revise" | "escalate"): Critic => ({
  name: "FixtureCritic", kind: "deterministic",
  review: async () => ({ verdict: { verdict, issues: verdict === "accept" ? [] : [{ code: "FIXTURE", message: `fixture says ${verdict}` }], agent: "FixtureCritic" } }),
});

describe("bounded revision loop (fixture agents)", () => {
  it("repeated critic rejection escalates within the revision limit", async () => {
    const planner = scripted((req) => [validSwitch(req)]);
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner, critic: fixedCritic("revise"), maxRevisions: 2 }));
    const pkg = run.decisions[0]!;
    expect(planner.requests).toHaveLength(3);
    expect(pkg.revisions).toBe(2);
    expect(pkg.status).toBe("ESCALATED");
    expect(pkg.escalation_reasons.join(" ")).toMatch(/Revision limit \(2\) reached/);
    expect(planner.requests[1]!.feedback.join(" ")).toMatch(/fixture says revise/);
  });

  it("invalid proposals are rejected every time and escalate after the limit", async () => {
    const planner = scripted((req) => [{ action: "ORDER_COMPOUNDED_PRODUCT", item_id: req.item.item_id, rationale: "x", evidence_ids: ["EV-MADE-UP"] }]);
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner, critic: fixedCritic("accept"), maxRevisions: 1 }));
    const pkg = run.decisions[0]!;
    expect(planner.requests).toHaveLength(2);
    expect(pkg.status).toBe("ESCALATED");
    expect(pkg.candidates).toEqual([]);
    expect(pkg.rejected_candidates).toHaveLength(2);
    expect(pkg.rejected_candidates[0]!.issues.map((i) => i.code)).toContain("ACTION_NOT_PERMITTED");
  });

  it("validator feedback lets the planner recover on the next revision", async () => {
    const planner = scripted((req, call) =>
      call === 1 ? [{ ...validSwitch(req), policy_id: "POL-INVENTED", evidence_ids: ["EV-POLICY-POL-INVENTED"] }] : [validSwitch(req)]
    );
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner, critic: new PrecedentCritic() }));
    const pkg = run.decisions[0]!;
    expect(pkg.status).toBe("PENDING_APPROVAL");
    expect(pkg.revisions).toBe(1);
    expect(planner.requests[1]!.feedback.join(" ")).toMatch(/POLICY_NOT_FOUND/);
    expect(pkg.rejected_candidates.map((r) => r.revision)).toEqual([0]);
  });

  it("a critic's accept cannot admit a candidate the validator rejected", async () => {
    const planner = scripted((req) => [validSwitch(req), { ...validSwitch(req), action: "APPROVED_INTERCHANGE", policy_id: "POL-FUR-OLD" }]);
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner, critic: fixedCritic("accept") }));
    const pkg = run.decisions[0]!;
    expect(pkg.candidates.map((c) => c.policy_id)).toEqual(["POL-FUR-001"]);
    expect(pkg.rejected_candidates[0]!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["POLICY_RETIRED", "POLICY_EXPIRED"]));
  });

  it("the deterministic precedent critic overrides an LLM critic's accept", async () => {
    const critic = new CompositeCritic([new PrecedentCritic(), fixedCritic("accept")]);
    const run = await runWorkflow(DEXMED, await deps({ critic }));
    expect(run.decisions[0]!.status).toBe("ESCALATED");
    expect(run.decisions[0]!.escalation_reasons.join(" ")).toMatch(/precedent conflict/);
  });
});

describe("failure handling", () => {
  it("a data-source failure is an explicit error, not substituted data", async () => {
    const failing: DataSource = {
      name: "zetaris", mode: "live",
      loadHospital: async () => { throw Object.assign(new Error("Cannot reach Zetaris at http://localhost:8888/api/v1.0 (ECONNREFUSED)"), { name: "ZetarisError" }); },
      loadShortages: async () => ({ records: [], source_detail: "", fetched_at: null }),
    };
    const d = await deps({ data: failing, mode: "live" });
    const run = await runWorkflow(FUROSEMIDE, d);
    expect(run.status).toBe("error");
    expect(run.decisions).toEqual([]);
    expect(run.error).toMatchObject({ type: "ZetarisError" });
    expect(run.error!.message).toMatch(/No sample data was substituted/);
  });

  it("a planner outage escalates with no invented candidates", async () => {
    const down: Planner = { name: "NightshiftPlanner", kind: "llm", propose: async () => { throw Object.assign(new Error("cannot reach Nightshift"), { name: "NightshiftError" }); } };
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner: down }));
    const pkg = run.decisions[0]!;
    expect(pkg.status).toBe("ESCALATED");
    expect(pkg.candidates).toEqual([]);
    expect(pkg.escalation_reasons[0]).toMatch(/Planner unavailable .*none were invented/);
  });
});

describe("Nightshift agents with a fake transport (fixture)", () => {
  const reply = (content: string, model = "meterless/text.auto"): ChatResult => ({
    content, modelRequested: "meterless/auto", modelReported: model, meterless: null, routingHeaders: {}, responseId: "fixture",
    usage: null, finishReason: "stop", attempts: 1, durationMs: 1, httpStatus: 200,
  });

  it("records the model metadata the transport returned and still validates the output", async () => {
    let call = 0;
    const transport: ChatTransport = {
      chat: async (messages) => {
        call++;
        const req = JSON.parse(messages[1]!.content);
        if (messages[0]!.content.includes("You are the planner")) {
          const ids = req.evidence.map((e: { evidence_id: string }) => e.evidence_id);
          return reply("```json\n" + JSON.stringify({ candidates: [{ action: "RESTRICT_PER_POLICY", item_id: "FUR-INJ-40", policy_id: "POL-FUR-002", rationale: "Restrict per policy.", evidence_ids: ["EV-POLICY-POL-FUR-002", "EV-EXPOSURE-FUR-INJ-40", ids.find((i: string) => i.startsWith("EV-PRECEDENT-"))] }, { action: "INVENTED", item_id: "FUR-INJ-40", rationale: "x", evidence_ids: ["EV-EXPOSURE-FUR-INJ-40"] }] }) + "\n```");
        }
        return reply(JSON.stringify({ verdict: "accept", issues: [] }));
      },
    };
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner: new NightshiftPlanner(transport), critic: new CompositeCritic([new PrecedentCritic(), new NightshiftCritic(transport)]) }));
    const pkg = run.decisions[0]!;
    expect(call).toBe(2);
    expect(pkg.candidates.map((c) => c.action)).toEqual(["RESTRICT_PER_POLICY"]);
    expect(pkg.rejected_candidates[0]!.issues[0]!.code).toBe("ACTION_NOT_PERMITTED");
    expect(pkg.model_calls.map((m) => [m.agent, m.reported])).toEqual([["NightshiftPlanner", "meterless/text.auto"], ["PrecedentCritic+NightshiftCritic", "meterless/text.auto"]]);
  });

  it("gives the planner the validator's citation contract and a separate feedback turn on revision", async () => {
    const seen: { role: string; content: string }[][] = [];
    const transport: ChatTransport = {
      chat: async (messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        // First answer repeats the live failure mode (target on a non-targeted action).
        if (seen.length === 1) {
          return reply(JSON.stringify({ candidates: [{ action: "RESTRICT_PER_POLICY", item_id: "FUR-INJ-40", policy_id: "POL-FUR-002", target_item_id: "FUR-INJ-40", rationale: "Restrict.", evidence_ids: ["EV-POLICY-POL-FUR-002", "EV-EXPOSURE-FUR-INJ-40"] }] }));
        }
        return reply(JSON.stringify({ candidates: [{ action: "RESTRICT_PER_POLICY", item_id: "FUR-INJ-40", policy_id: "POL-FUR-002", rationale: "Restrict.", evidence_ids: ["EV-POLICY-POL-FUR-002", "EV-EXPOSURE-FUR-INJ-40"] }] }));
      },
    };
    const run = await runWorkflow(FUROSEMIDE, await deps({ planner: new NightshiftPlanner(transport), critic: fixedCritic("accept") }));
    const first = JSON.parse(seen[0]![1]!.content);
    const sw = first.policy_contracts.find((c: { policy_id: string }) => c.policy_id === "POL-FUR-001");
    expect(sw.required_evidence_ids).toEqual(["EV-POLICY-POL-FUR-001", "EV-EXPOSURE-FUR-INJ-40", "EV-EXPOSURE-FUR-INJ-100"]);
    expect(first.policy_contracts.find((c: { policy_id: string }) => c.policy_id === "POL-FUR-002").target_item_id).toBeNull();
    // The current approved SWITCH precedent is listed; its superseded ancestor is not.
    const current = run.decisions[0]!.precedents.find((p) => p.action === "SWITCH_PRESENTATION")!;
    expect(sw.precedent_evidence_ids).toEqual([`EV-PRECEDENT-${current.memory_id}`]);
    expect(seen[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(seen[1]![3]!.content).toMatch(/UNEXPECTED_TARGET/);
    expect(run.decisions[0]!.status).toBe("PENDING_APPROVAL");
    expect(run.decisions[0]!.revisions).toBe(1);
  });

  it("an unreadable critic reply escalates instead of approving", async () => {
    const transport: ChatTransport = { chat: async () => reply("I think it is fine!") };
    const run = await runWorkflow(FUROSEMIDE, await deps({ critic: new NightshiftCritic(transport) }));
    const pkg = run.decisions[0]!;
    expect(pkg.status).toBe("ESCALATED");
    expect(pkg.critic_verdicts[0]!.issues[0]!.code).toBe("CRITIC_OUTPUT_INVALID");
  });
});

describe("human review and memory feedback", () => {
  it("approval writes precedents that a later run, in a new process, recalls", async () => {
    const d = await deps();
    const run = await runWorkflow(FUROSEMIDE, d);
    const store = new ReviewStore(path.join(dir, "reviews"));
    const pkg = run.decisions[0]!;
    const rec = recordReview(run, { decision_id: pkg.decision_id, outcome: "approved", reviewer: "Synthetic pharmacist", note: "ok" }, { memory: d.memory, store });
    expect(rec.precedents_written).toHaveLength(3);
    expect(rec.feedback.every((f) => f.kind === "helpful")).toBe(true);

    const later = await deps({ memory: new PrecedentMemory({ persistDir: path.join(dir, "hmem") }) }, "run-later");
    const run2 = await runWorkflow(FUROSEMIDE, later);
    const sources = run2.decisions[0]!.precedents.map((p) => p.source_ref);
    expect(sources.some((s) => s === `review:${rec.review_id}`)).toBe(true);
  });

  it("rejection needs a note, writes rejected precedents and lowers cited precedents", async () => {
    const d = await deps();
    const run = await runWorkflow(FUROSEMIDE, d);
    const store = new ReviewStore(path.join(dir, "reviews"));
    const pkg = run.decisions[0]!;
    expect(() => recordReview(run, { decision_id: pkg.decision_id, outcome: "rejected", reviewer: "x", note: "" }, { memory: d.memory, store })).toThrow(/note/);
    const switchPrecedent = pkg.precedents.find((p) => p.action === "SWITCH_PRESENTATION")!;
    const rec = recordReview(
      run,
      { decision_id: pkg.decision_id, outcome: "rejected", reviewer: "Synthetic pharmacist", note: "Pump library entry not yet live.", wrong_precedents: [switchPrecedent.memory_id] },
      { memory: d.memory, store }
    );
    expect(rec.feedback.find((f) => f.memory_id === switchPrecedent.memory_id)).toMatchObject({ kind: "wrong", confidence_after: 0.6 });
    expect(rec.feedback.filter((f) => f.kind === "not_helpful")).toHaveLength(1);
    expect(d.memory.get(rec.precedents_written[0]!)!.outcome).toBe("rejected");
    expect(() => recordReview(run, { decision_id: pkg.decision_id, outcome: "approved", reviewer: "y", note: "" }, { memory: d.memory, store })).toThrow(/already rejected/);
  });

  it("escalated and monitor packages can only be acknowledged", async () => {
    const d = await deps();
    const run = await runWorkflow(DEXMED, d);
    const store = new ReviewStore(path.join(dir, "reviews"));
    const id = run.decisions[0]!.decision_id;
    expect(() => recordReview(run, { decision_id: id, outcome: "approved", reviewer: "x", note: "" }, { memory: d.memory, store })).toThrow(/only be acknowledged/);
    const rec = recordReview(run, { decision_id: id, outcome: "acknowledged", reviewer: "x", note: "Escalated to ICU pharmacist." }, { memory: d.memory, store });
    expect(rec.precedents_written).toEqual([]);
  });
});

describe("configuration", () => {
  it("never activates sample mode implicitly", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ SAMPLE_MODE: "yes" })).toThrow(/SAMPLE_MODE/);
    expect(loadConfig({ SAMPLE_MODE: "true" }).mode).toBe("sample");
  });

  it("rejects placeholder credentials in live mode", () => {
    const env = Object.fromEntries(
      fs.readFileSync(".env.example", "utf-8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0]!, l.slice(l.indexOf("=") + 1)])
    );
    expect(() => loadConfig({ ...env, SAMPLE_MODE: "false" })).toThrow(/placeholder/);
  });
});
