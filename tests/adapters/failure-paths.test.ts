// Failure paths over REAL sockets: a port with nothing listening. No fetch
// mocks are involved, so these show what live mode does when a sponsor service
// is down. They say nothing about whether the services work when they are up.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { autoDetect, NightshiftClient } from "../../src/adapters/nightshift.ts";
import { ZetarisClient } from "../../src/adapters/zetaris.ts";
import { DeterministicPolicyPlanner, PrecedentCritic } from "../../src/agents/sample.ts";
import type { ZetarisConfig } from "../../src/config.ts";
import { ZetarisDataSource } from "../../src/data/sources.ts";
import { PrecedentMemory } from "../../src/memory/precedents.ts";
import { Tracer } from "../../src/trace/tracer.ts";
import { runWorkflow } from "../../src/workflow/run.ts";

let closedPort = 0;
beforeAll(async () => {
  // Bind an ephemeral port, then release it: nothing is listening there afterwards.
  closedPort = await new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
});

const zcfg = (): ZetarisConfig => ({
  restUrl: `http://127.0.0.1:${closedPort}/api/v1.0`,
  orgId: "1",
  apiKey: "test-key-not-real",
  timeoutMs: 2000,
  maxRetries: 1,
  tables: { shortages: "shortstop.shortages_v", formulary: "hospital_pg.formulary", inventory: "hospital_pg.inventory", usage: "hospital_pg.usage", policies: "hospital_pg.policies" },
});

describe("live-mode failure over real sockets", () => {
  it("Zetaris unreachable: bounded retries, then an actionable error", async () => {
    const z = new ZetarisClient(zcfg(), { sleep: async () => {} });
    const err = await z.query("SELECT 1", ["one"] as const).catch((e) => e);
    expect(err.name).toBe("ZetarisError");
    expect(err.kind).toBe("unreachable");
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.message).toMatch(/gave up after 2 attempts/);
  });

  it("a live run with Zetaris down returns an error and never substitutes sample data", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-live-fail-"));
    const tracer = new Tracer({ runId: "run-live-fail", mode: "live" });
    const run = await runWorkflow(
      { as_of: "2026-10-24", trigger: { package_ndc: "0409-6102-26" } },
      {
        mode: "live", maxRevisions: 2, maxCandidates: 3,
        data: new ZetarisDataSource({ ...zcfg(), maxRetries: 0 }, tracer),
        memory: new PrecedentMemory({ persistDir: path.join(dir, "hmem") }),
        planner: new DeterministicPolicyPlanner(), critic: new PrecedentCritic(), tracer,
      }
    );
    fs.rmSync(dir, { recursive: true, force: true });
    expect(run.status).toBe("error");
    expect(run.mode).toBe("live");
    expect(run.decisions).toEqual([]);
    expect(run.data_source).toBe("zetaris");
    expect(run.error!.message).toMatch(/No sample data was substituted/);
    const ext = tracer.all().filter((e) => e.external_call === true);
    expect(ext.length).toBeGreaterThan(0);
    expect(ext.every((e) => e.status === "failure")).toBe(true);
    expect(tracer.all().some((e) => JSON.stringify(e).includes("sample-file"))).toBe(false);
  });

  it("Nightshift unreachable: discover reports offline and chat fails after bounded retries", async () => {
    const n = new NightshiftClient(
      { baseUrl: `127.0.0.1:${closedPort}`, token: "test-token-not-real", model: "meterless/auto", app: "shortstop", scope: "user", timeoutMs: 2000, maxRetries: 1 },
      { sleep: async () => {} }
    );
    expect((await n.discover()).status).toBe("offline");
    await expect(n.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ name: "NightshiftError", kind: "offline" });
  });

  it("the CLI in live mode exits non-zero and writes no run output when services are down", async () => {
    const env = {
      PATH: process.env.PATH ?? "",
      SAMPLE_MODE: "false",
      ZETARIS_REST_URL: `http://127.0.0.1:${closedPort}/api/v1.0`, ZETARIS_ORG_ID: "1", ZETARIS_API_KEY: "test-key-not-real",
      ZETARIS_TABLE_SHORTAGES: "shortstop.shortages_v", ZETARIS_TABLE_FORMULARY: "hospital_pg.formulary", ZETARIS_TABLE_INVENTORY: "hospital_pg.inventory",
      ZETARIS_TABLE_USAGE: "hospital_pg.usage", ZETARIS_TABLE_POLICIES: "hospital_pg.policies",
      METERLESS_BASE_URL: `http://127.0.0.1:${closedPort}/v1`, METERLESS_RUNTIME_TOKEN: "test-token-not-real", METERLESS_MODEL: "meterless/auto",
      SHORTSTOP_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-cli-")), SHORTSTOP_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "shortstop-cli-logs-")),
    };
    const res = await promisify(execFile)("npx", ["tsx", "src/cli.ts", "run", "--input", "input_examples/scenario-1-furosemide.json"], { env, cwd: process.cwd() }).catch((e) => e);
    expect(res.code).toBe(1);
    expect(String(res.stderr)).toMatch(/Nightshift is offline/);
    expect(fs.existsSync(path.join(env.SHORTSTOP_STATE_DIR, "live", "runs"))).toBe(false);
    expect(String(res.stdout) + String(res.stderr)).not.toMatch(/test-token-not-real|test-key-not-real/);
  }, 30_000);
});

describe("autoDetect (unit, fake fetch)", () => {
  it("tries the contract ports in order and returns the first runtime that answers", async () => {
    const seen: string[] = [];
    const f = (async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).startsWith("http://localhost:8090")) return new Response("", { status: 401 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r = await autoDetect(undefined, { fetch: f });
    expect(r.found).toEqual({ base_url: "http://localhost:8090/v1", status: "unauthorized", http_status: 401 });
    expect(seen).toEqual([
      "http://127.0.0.1:8088/v1/models", "http://localhost:8088/v1/models", "http://[::1]:8088/v1/models",
      "http://127.0.0.1:8090/v1/models", "http://localhost:8090/v1/models",
    ]);
  });

  it("reports no runtime when nothing answers", async () => {
    const r = await autoDetect(undefined, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(r.found).toBeUndefined();
    expect(r.attempts).toHaveLength(12);
  });
});

describe("ZetarisClient.execute (unit, fake fetch)", () => {
  it("returns rows of unknown shape verbatim, with the other response fields", async () => {
    const f = (async () => new Response(JSON.stringify({ data: [["POKEAPI_REST", "desc", 3]], columns: ["name", "description", "n"] }), { status: 200 })) as typeof fetch;
    const r = await new ZetarisClient({ restUrl: "http://x/api/v1.0", orgId: "1", apiKey: "k", timeoutMs: 1000, maxRetries: 0 }, { fetch: f }).execute("SHOW LIGHTNING DATABASES");
    expect(r.rows).toEqual([["POKEAPI_REST", "desc", 3]]);
    expect(r.extra).toEqual({ columns: ["name", "description", "n"] });
  });
});
