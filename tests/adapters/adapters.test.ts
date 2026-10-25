// UNIT TESTS with a fake fetch. They check request construction, error mapping
// and response parsing against the documented contracts. They do NOT show that
// Zetaris or Nightshift work; only a live run against the real services can.
import { describe, expect, it } from "vitest";
import { ZetarisClient, ZetarisError } from "../../src/adapters/zetaris.ts";
import { NightshiftClient, NightshiftError, normalizeBaseUrl } from "../../src/adapters/nightshift.ts";

interface Call { url: string; init: RequestInit }
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("fake fetch: no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};
const hdr = (c: Call) => c.init.headers as Record<string, string>;

const zcfg = { restUrl: "http://localhost:8888/api/v1.0", orgId: "1", apiKey: "zk-test", timeoutMs: 1000, maxRetries: 2 };

describe("ZetarisClient (unit, fake fetch)", () => {
  it("sends the documented request and maps positional rows", async () => {
    const f = fakeFetch([json({ data: [["0409-6102-26", "Unavailable"]] })]);
    const z = new ZetarisClient(zcfg, { fetch: f.fn, sleep: noSleep });
    const r = await z.query("SELECT package_ndc, availability FROM t;", ["package_ndc", "availability"] as const);
    expect(r.rows).toEqual([{ package_ndc: "0409-6102-26", availability: "Unavailable" }]);
    const c = f.calls[0]!;
    expect(c.url).toBe("http://localhost:8888/api/v1.0/sql-editor/sqls/run");
    expect(c.init.method).toBe("POST");
    expect(hdr(c).Authorization).toBe("Bearer zk-test");
    expect(hdr(c)["X-Org-ID"]).toBe("1");
    expect(hdr(c)["X-Request-ID"]).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(c.init.body));
    expect(body).toMatchObject({ sql: "SELECT package_ndc, availability FROM t", source: "SqlEditor" });
    expect(body.queryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses a fresh X-Request-ID on each retry and gives up after the bound", async () => {
    const f = fakeFetch([new Response("busy", { status: 503 }), new TypeError("fetch failed"), json({ data: [] })]);
    const z = new ZetarisClient(zcfg, { fetch: f.fn, sleep: noSleep });
    const r = await z.query("SELECT 1", ["one"] as const);
    expect(r.attempts).toBe(3);
    expect(new Set(f.calls.map((c) => hdr(c)["X-Request-ID"])).size).toBe(3);

    const g = fakeFetch([new Response("x", { status: 500 }), new Response("x", { status: 500 }), new Response("x", { status: 500 })]);
    await expect(new ZetarisClient(zcfg, { fetch: g.fn, sleep: noSleep }).query("SELECT 1", ["one"] as const)).rejects.toThrow(/gave up after 3 attempts/);
  });

  it("does not retry auth or request errors and gives actionable messages", async () => {
    const f = fakeFetch([new Response("no", { status: 401 })]);
    const err = await new ZetarisClient(zcfg, { fetch: f.fn, sleep: noSleep }).query("SELECT 1", ["one"] as const).catch((e) => e);
    expect(err).toBeInstanceOf(ZetarisError);
    expect(err.kind).toBe("unauthorized");
    expect(err.message).toMatch(/ZETARIS_API_KEY/);
    expect(f.calls).toHaveLength(1);
    const g = fakeFetch([new Response("bad org", { status: 400 })]);
    await expect(new ZetarisClient(zcfg, { fetch: g.fn, sleep: noSleep }).query("SELECT 1", ["one"] as const)).rejects.toThrow(/ZETARIS_ORG_ID/);
    // Real message from the live service for an invalid DESCRIBE BY text: a SQL problem, not an org problem.
    const h = fakeFetch([new Response(JSON.stringify({ msg: "Description is invalid, it must be alphanumeric including the _ (underscore), . (dot), - (hyphen) and , (comma) character" }), { status: 400 })]);
    const sqlErr = await new ZetarisClient(zcfg, { fetch: h.fn, sleep: noSleep }).execute("CREATE LIGHTNING DATABASE X DESCRIBE BY \"a (b)\"").catch((e) => e);
    expect(sqlErr.message).toMatch(/Check the SQL statement/);
    expect(sqlErr.message).not.toMatch(/ZETARIS_ORG_ID/);
  });

  it("treats the live service's 400 Not Allowed as an invalid API key", async () => {
    // Observed on the real instance for both a revoked and a made-up key.
    const f = fakeFetch([new Response(JSON.stringify({ msg: "Not Allowed" }), { status: 400 })]);
    const err = await new ZetarisClient(zcfg, { fetch: f.fn, sleep: noSleep }).query("SELECT 1", ["one"] as const).catch((e) => e);
    expect(err.kind).toBe("unauthorized");
    expect(err.message).toMatch(/API Tokens/);
    expect(f.calls).toHaveLength(1);
  });

  it("rejects unexpected response shapes instead of guessing", async () => {
    const z = (r: Response) => new ZetarisClient(zcfg, { fetch: fakeFetch([r]).fn, sleep: noSleep });
    await expect(z(json({ rows: [] })).query("SELECT 1", ["one"] as const)).rejects.toThrow(/no "data" field/);
    await expect(z(json({ data: [[1, 2]] })).query("SELECT 1", ["one"] as const)).rejects.toThrow(/expected 1/);
    await expect(z(new Response("<html>login</html>", { status: 200 })).query("SELECT 1", ["one"] as const)).rejects.toThrow(/non-JSON/);
    const objRows = await z(json({ data: [{ ONE: 1 }] })).query("SELECT 1 AS one", ["one"] as const);
    expect(objRows.rows).toEqual([{ one: 1 }]);
  });

  it("maps rows by the headers field that live Zetaris returns", async () => {
    // Shape observed from the real service: {headers, data, total, timeUsed}, numbers as strings.
    const live = json({ headers: ["name", "description", "id"], data: [["NY_TAXI", "NY Taxi sample data", "6"]], total: 1, timeUsed: 12 });
    const z = new ZetarisClient(zcfg, { fetch: fakeFetch([live]).fn, sleep: noSleep });
    const r = await z.query("SHOW LIGHTNING DATABASES", ["id", "name"] as const);
    expect(r.rows).toEqual([{ id: "6", name: "NY_TAXI" }]);
    const missing = new ZetarisClient(zcfg, { fetch: fakeFetch([json({ headers: ["name"], data: [["x"]] })]).fn, sleep: noSleep });
    await expect(missing.query("SELECT name FROM t", ["name", "id"] as const)).rejects.toThrow(/no column "id"/);
  });

  it("refuses multiple statements in one call", async () => {
    const z = new ZetarisClient(zcfg, { fetch: fakeFetch([]).fn });
    await expect(z.query("SELECT 1; DROP TABLE x", ["one"] as const)).rejects.toThrow(/one SQL statement/);
  });
});

const ncfg = { baseUrl: "http://127.0.0.1:8088/v1", token: "ns-test-token", model: "meterless/auto", app: "shortstop", scope: "user", timeoutMs: 1000, maxRetries: 1 };

describe("NightshiftClient (unit, fake fetch)", () => {
  it("normalizes pasted base URLs without producing /v1/v1", () => {
    for (const s of ["127.0.0.1:8088", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/", "http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/healthz", "http://127.0.0.1:8088/v1/v1"]) {
      expect(normalizeBaseUrl(s)).toBe("http://127.0.0.1:8088/v1");
    }
  });

  it("rejects the rt-local placeholder and non-lowercase app ids", () => {
    expect(() => new NightshiftClient({ ...ncfg, token: "rt-local" })).toThrow(/rt-local/);
    expect(() => new NightshiftClient({ ...ncfg, app: "ShortStop App" })).toThrow(/lowercase/);
  });

  it("reports online, unauthorized and offline from GET /v1/models", async () => {
    const mk = (r: Response | Error) => new NightshiftClient(ncfg, { fetch: fakeFetch([r]).fn });
    const on = await mk(json({ data: [{ id: "meterless/auto" }, { id: "meterless/text.fast" }] })).discover();
    expect(on).toMatchObject({ status: "online", models: ["meterless/auto", "meterless/text.fast"] });
    expect((await mk(new Response("", { status: 401 })).discover()).status).toBe("unauthorized");
    expect((await mk(new Response("", { status: 403 })).discover()).status).toBe("unauthorized");
    expect((await mk(new TypeError("fetch failed")).discover()).status).toBe("offline");
    expect((await mk(json({ data: [{ id: "gpt-x" }] })).discover()).status).toBe("offline");
  });

  it("sends the contract headers on chat and records routing metadata verbatim", async () => {
    const f = fakeFetch([
      json(
        { id: "cmpl-1", model: "meterless/text.auto", meterless: { lane: "lane-1" }, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
        200,
        { "meterless-route": "lane-1", "x-other": "ignored" }
      ),
    ]);
    const n = new NightshiftClient(ncfg, { fetch: f.fn, sleep: noSleep });
    const r = await n.chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("ok");
    expect(r.modelRequested).toBe("meterless/auto");
    expect(r.modelReported).toBe("meterless/text.auto");
    expect(r.meterless).toEqual({ lane: "lane-1" });
    expect(r.routingHeaders).toEqual({ "meterless-route": "lane-1" });
    const h = hdr(f.calls[0]!);
    expect(h.Authorization).toBe("Bearer ns-test-token");
    expect(h["meterless-app"]).toBe("shortstop");
    expect(h["meterless-scope"]).toBe("user");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ model: "meterless/auto", stream: false });
  });

  it("reads text from content parts and rejects responses with no text", async () => {
    const parts = new NightshiftClient(ncfg, { fetch: fakeFetch([json({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] })]).fn });
    expect((await parts.chat([{ role: "user", content: "x" }])).content).toBe("ab");
    const empty = new NightshiftClient(ncfg, { fetch: fakeFetch([json({ choices: [] })]).fn });
    await expect(empty.chat([{ role: "user", content: "x" }])).rejects.toThrow(/no choices/);
  });

  it("surfaces 401 as unauthorized without retrying", async () => {
    const f = fakeFetch([new Response("bad token", { status: 401 })]);
    const err = await new NightshiftClient(ncfg, { fetch: f.fn, sleep: noSleep }).chat([{ role: "user", content: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(NightshiftError);
    expect(err.kind).toBe("unauthorized");
    expect(f.calls).toHaveLength(1);
  });

  it("retries 429 at 2 s, 4 s, 8 s and then surfaces it", async () => {
    const waits: number[] = [];
    const f = fakeFetch([0, 1, 2, 3].map(() => new Response("slow down", { status: 429 })));
    const n = new NightshiftClient(ncfg, { fetch: f.fn, sleep: async (ms) => void waits.push(ms) });
    await expect(n.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ kind: "rate_limited" });
    expect(waits).toEqual([2000, 4000, 8000]);
    expect(f.calls).toHaveLength(4);
  });

  it("retries transport and 5xx failures within the bound", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), json({ choices: [{ message: { content: "ok" } }] })]);
    const r = await new NightshiftClient(ncfg, { fetch: f.fn, sleep: noSleep }).chat([{ role: "user", content: "x" }]);
    expect(r.attempts).toBe(2);
    const g = fakeFetch([new Response("x", { status: 502 }), new Response("x", { status: 502 })]);
    await expect(new NightshiftClient(ncfg, { fetch: g.fn, sleep: noSleep }).chat([{ role: "user", content: "x" }])).rejects.toThrow(/gave up after 2 attempts/);
  });
});
