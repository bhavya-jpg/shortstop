// UNIT tests of registration statement handling (fake fetch). They do not show
// that Zetaris accepts these statements; only `register --yes` against a live
// instance can.
import { describe, expect, it } from "vitest";
import { ZetarisClient } from "../../src/adapters/zetaris.ts";
import { hospitalStatements, openfdaStatements, postgresTargetFromEnv, printable, runStatements } from "../../src/setup/registration.ts";

const pg = { host: "host.docker.internal", port: "5432", database: "shortstop_synthetic", user: "u", password: "pw-SECRET-123" };

describe("registration statements", () => {
  it("never prints the PostgreSQL password", () => {
    const text = hospitalStatements(pg).map(printable).join("\n");
    expect(text).not.toContain("pw-SECRET-123");
    expect(text).toContain('password "[redacted]"');
    expect(text).toContain("jdbc:postgresql://host.docker.internal:5432/shortstop_synthetic");
  });

  it("requires PostgreSQL credentials from the environment", () => {
    expect(() => postgresTargetFromEnv({})).toThrow(/PGUSER/);
    expect(postgresTargetFromEnv({ PGUSER: "a" }).password).toBe(""); // trust authentication
    expect(postgresTargetFromEnv({ PGUSER: "a", PGPASSWORD: "b" })).toMatchObject({ host: "host.docker.internal", database: "shortstop_synthetic" });
  });

  it("pages openFDA within its 1000-record limit and sends one statement per call", () => {
    const st = openfdaStatements();
    expect(st.map((s) => s.id)).toEqual(["openfda-database", "shortstop-container", "openfda-page-1", "openfda-page-2", "shortages-view"]);
    expect(st.every((s) => !s.sql.trim().endsWith(";"))).toBe(true);
    expect(st[3]!.sql).toContain("limit=1000&skip=1000");
    // Live rule: descriptions allow only letters, digits, spaces and _ . - ,
    for (const x of [...st, ...hospitalStatements(pg)]) {
      const m = /DESCRIBE BY "([^"]*)"/.exec(x.sql);
      if (m) expect(m[1]).toMatch(/^[A-Za-z0-9 _.,-]+$/);
    }
  });

  it("redacts secrets the server echoes back, skips 'already exists' only when asked, and stops at a failure", async () => {
    const replies = [
      new Response("Datasource hospital_pg already exists", { status: 500 }),
      new Response('error near password "pw-SECRET-123"', { status: 400 }),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ];
    const z = new ZetarisClient({ restUrl: "http://x/api/v1.0", orgId: "1", apiKey: "k", timeoutMs: 1000, maxRetries: 0 }, { fetch: (async () => replies.shift()!) as typeof fetch });
    const statements = [...hospitalStatements(pg), { id: "never-sent", sql: "SELECT 1" }];
    statements[1]!.secrets = [pg.password];
    const r = await runStatements(z, statements, { skipExists: true });
    expect(r.map((x) => x.status)).toEqual(["skipped_exists", "failed"]);
    expect(JSON.stringify(r)).not.toContain("pw-SECRET-123");
  });
});
