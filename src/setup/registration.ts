// Zetaris rule observed live: DESCRIBE BY text may only contain letters,
// digits, spaces and _ . - , (no parentheses).
//
// Registration statements for the Zetaris sources ShortStop reads, and the
// local PostgreSQL seed. Statements follow the zetaris/getting-started recipes
// (REST table + LATERAL VIEW explode; CREATE DATASOURCE / REGISTER DATASOURCE
// TABLES). They are sent one at a time. All of them ran successfully against a
// live Zetaris instance on 2026-10-25.
//
// Credentials are read from the environment at run time, never written to a
// file, and redacted whenever a statement is printed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ZetarisClient } from "../adapters/zetaris.ts";

export interface Statement {
  id: string;
  sql: string;
  secrets?: string[]; // values to redact when printing
}

const OPENFDA = "https://api.fda.gov/drug/shortages.json?search=status:%22Current%22&limit=1000";

const shortageView = (table: string) => `SELECT r.package_ndc, r.generic_name, r.presentation, r.company_name, r.dosage_form, r.status,
       r.availability, r.shortage_reason, r.update_date, r.initial_posting_date,
       concat_ws(',', r.openfda.rxcui) AS rxcui,
       (r.openfda IS NOT NULL) AS has_openfda_block
FROM openfda_rest.${table} LATERAL VIEW explode(results) AS r`;

// openFDA caps limit at 1000; 1,142 "Current" records on 2026-10-23, so two pages.
export function openfdaStatements(): Statement[] {
  const rest = (name: string, url: string) =>
    `CREATE LIGHTNING REST TABLE ${name} FROM OPENFDA_REST REQUEST(
    endpoint "${url}",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ()`;
  return [
    { id: "openfda-database", sql: `CREATE LIGHTNING DATABASE OPENFDA_REST DESCRIBE BY "openFDA drug shortages, public REST source"` },
    { id: "shortstop-container", sql: "CREATE SCHEMASTORE CONTAINER shortstop" },
    { id: "openfda-page-1", sql: rest("shortages_current_p1", OPENFDA) },
    { id: "openfda-page-2", sql: rest("shortages_current_p2", `${OPENFDA}&skip=1000`) },
    { id: "shortages-view", sql: `CREATE SCHEMASTORE VIEW shortages_v WITH CONTAINER shortstop AS\n${shortageView("shortages_current_p1")}\nUNION ALL\n${shortageView("shortages_current_p2")}` },
  ];
}

export interface PostgresTarget {
  host: string; // as seen from the Zetaris containers
  port: string;
  database: string;
  user: string;
  password: string;
}

export function hospitalStatements(pg: PostgresTarget): Statement[] {
  return [
    {
      id: "hospital-datasource",
      sql: `CREATE DATASOURCE hospital_pg DESCRIBE BY "ShortStop SYNTHETIC hospital data, PostgreSQL" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://${pg.host}:${pg.port}/${pg.database}",
  username "${pg.user}",
  password "${pg.password}",
  fetchsize "1000"
)`,
      secrets: [pg.password],
    },
    { id: "hospital-tables", sql: `REGISTER DATASOURCE TABLES ('formulary', 'inventory', 'usage', 'policies') FROM hospital_pg` },
  ];
}

export function postgresTargetFromEnv(env: Record<string, string | undefined>): PostgresTarget {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set (export it in your shell or put it in .env; it is never written anywhere by ShortStop)`);
    return v;
  };
  return {
    // Zetaris runs in Docker, so the host's PostgreSQL is host.docker.internal.
    host: env.SHORTSTOP_PG_HOST_FOR_ZETARIS?.trim() || "host.docker.internal",
    port: env.PGPORT?.trim() || "5432",
    database: env.SHORTSTOP_PG_DATABASE?.trim() || "shortstop_synthetic",
    user: need("PGUSER"),
    // Optional: a local server with trust authentication needs no password.
    password: env.PGPASSWORD?.trim() ?? "",
  };
}

export function printable(s: Statement): string {
  let out = s.sql;
  for (const secret of s.secrets ?? []) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

export interface StatementResult {
  id: string;
  status: "ok" | "skipped_exists" | "failed";
  detail: string;
}

export async function runStatements(z: ZetarisClient, statements: Statement[], opts: { skipExists: boolean }): Promise<StatementResult[]> {
  const out: StatementResult[] = [];
  for (const s of statements) {
    try {
      const r = await z.execute(s.sql);
      out.push({ id: s.id, status: "ok", detail: `HTTP ${r.httpStatus}; ${r.rowCount} rows; ${JSON.stringify(r.rows).slice(0, 200)}` });
    } catch (err) {
      const msg = (err as Error).message;
      const redacted = (s.secrets ?? []).reduce((m, sec) => (sec ? m.split(sec).join("[redacted]") : m), msg);
      if (opts.skipExists && /already exist/i.test(msg)) {
        out.push({ id: s.id, status: "skipped_exists", detail: redacted.slice(0, 300) });
        continue;
      }
      out.push({ id: s.id, status: "failed", detail: redacted.slice(0, 600) });
      break; // stop at the first real failure, like run_sql.py
    }
  }
  return out;
}

// Loads data/synthetic/postgres-seed.sql into the local database with psql.
// PGUSER/PGPASSWORD come from the environment and are passed to psql's
// environment only.
export function seedPostgres(env: Record<string, string | undefined>, database = env.SHORTSTOP_PG_DATABASE?.trim() || "shortstop_synthetic"): string[] {
  const bin = (name: string) => [`/Library/PostgreSQL/17/bin/${name}`].find((p) => fs.existsSync(p)) ?? name;
  const childEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  const host = env.PGHOST?.trim() || "127.0.0.1";
  const log: string[] = [];
  const exists = execFileSync(bin("psql"), ["-h", host, "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${database.replace(/'/g, "")}'`], { env: childEnv, encoding: "utf-8" }).trim();
  if (exists !== "1") {
    execFileSync(bin("createdb"), ["-h", host, database], { env: childEnv });
    log.push(`created database ${database}`);
  } else log.push(`database ${database} already exists`);
  const seed = path.resolve(import.meta.dirname, "..", "..", "data", "synthetic", "postgres-seed.sql");
  execFileSync(bin("psql"), ["-h", host, "-d", database, "-v", "ON_ERROR_STOP=1", "-q", "-f", seed], { env: childEnv, encoding: "utf-8" });
  const counts = execFileSync(
    bin("psql"),
    ["-h", host, "-d", database, "-tAc", "SELECT 'formulary='||(SELECT count(*) FROM formulary)||' inventory='||(SELECT count(*) FROM inventory)||' usage='||(SELECT count(*) FROM usage)||' policies='||(SELECT count(*) FROM policies)"],
    { env: childEnv, encoding: "utf-8" }
  ).trim();
  log.push(`loaded ${path.relative(process.cwd(), seed)}: ${counts}`);
  return log;
}
