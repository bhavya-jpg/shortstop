// Web UI API in sample mode: real workflow, real files, temporary state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { createServer } from "../../src/server.ts";

let base = "";
let close: () => void;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-server-"));
  const config = loadConfig({ SAMPLE_MODE: "true", SHORTSTOP_STATE_DIR: path.join(dir, "var"), SHORTSTOP_LOG_DIR: path.join(dir, "logs") });
  const server = createServer({ config });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// API responses are loosely typed JSON in these tests.
type Json = any;
const get = async (p: string): Promise<Json> => (await fetch(base + p)).json();
const json = (r: Response): Promise<Json> => r.json();
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitForRun(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await get(`/api/runs/${id}`);
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("run did not finish");
}

describe("web API (sample mode)", () => {
  it("reports sample mode and says no sponsor service is used", async () => {
    const meta = await get("/api/meta");
    expect(meta.mode).toBe("sample");
    expect(meta.notice).toMatch(/No Zetaris query and no Nightshift model call/);
    const health = await get("/api/health");
    expect(health.zetaris.status).toBe("not_used");
    expect(health.nightshift.status).toBe("not_used");
    expect(JSON.stringify(meta) + JSON.stringify(health)).not.toMatch(/token|api_key|password/i);
  });

  it("runs a scenario, streams its trace over SSE and stores the result", async () => {
    const res = await post("/api/runs", { scenario_id: "scenario-1-furosemide" });
    expect(res.status).toBe(202);
    const { run_id } = await json(res);
    const run = await waitForRun(run_id);
    expect(run.mode).toBe("sample");
    expect(run.decisions[0].status).toBe("PENDING_APPROVAL");

    const sse = await (await fetch(`${base}/api/runs/${run_id}/events`)).text();
    const traces = sse.split("\n\n").filter((b) => b.startsWith("event: trace"));
    expect(traces.length).toBeGreaterThan(8);
    expect(sse).toMatch(/event: complete/);
    expect(traces.every((t) => t.includes('"mode":"sample"') && t.includes('"external_call":false'))).toBe(true);

    const list = await get("/api/runs");
    expect(list.some((r: { run_id: string }) => r.run_id === run_id)).toBe(true);
  });

  it("records a review once and enforces the review rules", async () => {
    const { run_id } = await json(await post("/api/runs", { scenario_id: "scenario-3-dexmedetomidine" }));
    const run = await waitForRun(run_id);
    const dec = run.decisions[0].decision_id;
    const bad = await post(`/api/runs/${run_id}/decisions/${dec}/review`, { outcome: "approved", reviewer: "x" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatch(/only be acknowledged/);
    const ok = await post(`/api/runs/${run_id}/decisions/${dec}/review`, { outcome: "acknowledged", reviewer: "Test pharmacist", note: "seen" });
    expect(ok.status).toBe(200);
    const again = await post(`/api/runs/${run_id}/decisions/${dec}/review`, { outcome: "acknowledged", reviewer: "y" });
    expect(again.status).toBe(400);
    const after = await get(`/api/runs/${run_id}`);
    expect(after.reviews[dec].outcome).toBe("acknowledged");
  });

  it("validates input and never serves files outside web/", async () => {
    expect((await post("/api/runs", { package_ndc: "drop table" })).status).toBe(400);
    expect((await post("/api/runs", { scenario_id: "nope" })).status).toBe(404);
    expect((await fetch(`${base}/..%2f.env`)).status).toBe(403);
    expect((await fetch(`${base}/api/runs/..%2f..%2fetc`)).status).toBeGreaterThanOrEqual(400);
    const index = await fetch(`${base}/`);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("refuses the Zetaris cross-source query in sample mode", async () => {
    const r = await fetch(`${base}/api/zetaris/join`);
    expect(r.status).toBe(409);
    expect((await json(r)).error).toMatch(/live mode/);
  });

  it("serves precedents with their audit history", async () => {
    const list = await get("/api/precedents?item=FUR-INJ-40");
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].history[0].action).toBe("create");
  });
});
