// Configuration from environment variables. Live mode requires real sponsor
// settings and fails loudly without them; it never falls back to sample mode.

import fs from "node:fs";
import path from "node:path";
import type { Mode } from "./domain/types.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ZetarisConfig {
  restUrl: string;
  orgId: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  tables: { shortages: string; formulary: string; inventory: string; usage: string; policies: string };
}

export interface NightshiftConfig {
  baseUrl: string;
  token: string;
  model: string;
  app: string;
  scope: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface AppConfig {
  mode: Mode;
  maxRevisions: number;
  maxCandidates: number;
  stateDir: string; // mode-specific subfolder is appended by the caller
  logDir: string;
  zetaris?: ZetarisConfig;
  nightshift?: NightshiftConfig;
}

type Env = Record<string, string | undefined>;

const PLACEHOLDERS = new Set(["your-zetaris-api-key", "your-nightshift-runtime-token", "rt-local", "changeme"]);

// Loads ./.env into process.env without overwriting variables already set.
// Never writes the file.
export function loadDotEnv(file = path.resolve(".env")): boolean {
  if (!fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
  return n;
}

function secret(env: Env, key: string, hint: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is not set. ${hint}`);
  if (PLACEHOLDERS.has(v)) throw new ConfigError(`${key} still holds the placeholder value. ${hint}`);
  return v;
}

function required(env: Env, key: string, hint: string): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`${key} is not set. ${hint}`);
  return v;
}

export function parseMode(raw: string | undefined): Mode {
  if (raw === undefined || raw === "" || raw === "false") return "live";
  if (raw === "true") return "sample";
  throw new ConfigError(`SAMPLE_MODE must be "true" or "false", got "${raw}"`);
}

export function readZetarisConfig(env: Env): ZetarisConfig {
  const restUrl = required(env, "ZETARIS_REST_URL", "Set it to the Zetaris REST API, e.g. http://localhost:8888/api/v1.0.");
  if (!/^https?:\/\/[^/]+/.test(restUrl)) throw new ConfigError(`ZETARIS_REST_URL must be an http(s) URL, got "${restUrl}"`);
  const orgId = required(env, "ZETARIS_ORG_ID", "Use 1 on a local install.");
  if (!/^\d+$/.test(orgId)) throw new ConfigError(`ZETARIS_ORG_ID must be numeric, got "${orgId}"`);
  const table = (k: string) => {
    const v = required(env, k, "Set it to the fully qualified Zetaris table registered for this dataset.");
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,2}$/.test(v)) throw new ConfigError(`${k} is not a valid table name: "${v}"`);
    return v;
  };
  return {
    restUrl: restUrl.replace(/\/+$/, ""),
    orgId,
    apiKey: secret(env, "ZETARIS_API_KEY", "Create an API key in the Zetaris web UI and put it in .env."),
    timeoutMs: int(env, "ZETARIS_TIMEOUT_MS", 60_000, 1_000, 600_000),
    maxRetries: int(env, "ZETARIS_MAX_RETRIES", 2, 0, 5),
    tables: {
      shortages: table("ZETARIS_TABLE_SHORTAGES"),
      formulary: table("ZETARIS_TABLE_FORMULARY"),
      inventory: table("ZETARIS_TABLE_INVENTORY"),
      usage: table("ZETARIS_TABLE_USAGE"),
      policies: table("ZETARIS_TABLE_POLICIES"),
    },
  };
}

export function readNightshiftConfig(env: Env, opts: { requireModel?: boolean } = {}): NightshiftConfig {
  const baseUrl = required(env, "METERLESS_BASE_URL", "Copy the Runtime URL from Nightshift's Console.");
  const token = secret(env, "METERLESS_RUNTIME_TOKEN", "Copy the Runtime API key from Nightshift's Console.");
  const model =
    opts.requireModel === false
      ? env.METERLESS_MODEL?.trim() ?? ""
      : required(env, "METERLESS_MODEL", "Pick a meterless/* routing mode listed by GET /v1/models.");
  return {
    baseUrl,
    token,
    model,
    app: (env.METERLESS_APP?.trim() || "shortstop").toLowerCase(),
    scope: env.METERLESS_SCOPE?.trim() || "user",
    timeoutMs: int(env, "METERLESS_TIMEOUT_MS", 180_000, 1_000, 600_000),
    maxRetries: int(env, "METERLESS_MAX_RETRIES", 3, 0, 5),
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const mode = parseMode(env.SAMPLE_MODE);
  const base: AppConfig = {
    mode,
    maxRevisions: int(env, "SHORTSTOP_MAX_REVISIONS", 2, 0, 5),
    maxCandidates: int(env, "SHORTSTOP_MAX_CANDIDATES", 3, 1, 5),
    stateDir: path.resolve(env.SHORTSTOP_STATE_DIR || "var"),
    logDir: path.resolve(env.SHORTSTOP_LOG_DIR || "logs"),
  };
  if (mode === "sample") return base;
  return { ...base, zetaris: readZetarisConfig(env), nightshift: readNightshiftConfig(env) };
}
