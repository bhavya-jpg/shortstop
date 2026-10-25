// Fetches the real openFDA records used by sample mode and the scenarios.
//   npm run data:openfda
// Writes data/openfda/shortages-snapshot.json (raw shortage records, unmodified)
// and data/openfda/ndc-directory-check.json (whether each formulary NDC exists
// in the FDA NDC Directory). No API key is needed; the request rate is tiny.
// openFDA data: https://open.fda.gov/license/ (public domain / CC0).

import fs from "node:fs";
import path from "node:path";
import { normalizeNdc } from "../src/domain/ndc.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "data", "openfda");
const formulary = JSON.parse(fs.readFileSync(path.join(root, "data", "synthetic", "formulary.json"), "utf-8")) as {
  records: { item_id: string; ndc: string }[];
};

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const shortageResults: unknown[] = [];
const queries: { url: string; status: number; results: number }[] = [];
let meta: unknown = null;
const ndcChecks: unknown[] = [];

for (const f of formulary.records) {
  const n = normalizeNdc(f.ndc);
  // openFDA stores package_ndc as published (10-digit, hyphenated), so query the raw value.
  const sUrl = `https://api.fda.gov/drug/shortages.json?search=${encodeURIComponent(`package_ndc:"${f.ndc}"`)}&limit=10`;
  const s = await getJson(sUrl);
  const results = Array.isArray(s.body?.results) ? s.body.results : [];
  queries.push({ url: sUrl, status: s.status, results: results.length });
  if (results.length) meta ??= s.body.meta;
  shortageResults.push(...results);

  const dUrl = `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(`packaging.package_ndc:"${f.ndc}"`)}&limit=1`;
  const d = await getJson(dUrl);
  const r = d.body?.results?.[0];
  const pkg = r?.packaging?.find((p: any) => p.package_ndc === f.ndc);
  ndcChecks.push({
    item_id: f.item_id,
    ndc: f.ndc,
    ndc11: n.ok ? n.ndc11 : null,
    found_in_ndc_directory: Boolean(pkg),
    generic_name: r?.generic_name ?? null,
    dosage_form: r?.dosage_form ?? null,
    active_ingredients: r?.active_ingredients ?? null,
    package_description: pkg?.description ?? null,
    query_url: dUrl,
  });
  await new Promise((res) => setTimeout(res, 300));
}

fs.mkdirSync(outDir, { recursive: true });
const fetchedAt = new Date().toISOString();
fs.writeFileSync(
  path.join(outDir, "shortages-snapshot.json"),
  JSON.stringify(
    {
      notice: "Real public records from the openFDA drug shortages endpoint, stored unmodified. Not synthetic.",
      source: "https://api.fda.gov/drug/shortages.json",
      license: "https://open.fda.gov/license/",
      fetched_at: fetchedAt,
      openfda_meta: meta,
      queries,
      results: shortageResults,
    },
    null,
    2
  ) + "\n"
);
fs.writeFileSync(
  path.join(outDir, "ndc-directory-check.json"),
  JSON.stringify({ notice: "FDA NDC Directory lookups for each synthetic formulary NDC.", fetched_at: fetchedAt, checks: ndcChecks }, null, 2) + "\n"
);
console.log(`shortage records: ${shortageResults.length} from ${queries.length} queries`);
for (const c of ndcChecks as any[]) console.log(`${c.item_id} ${c.ndc} in NDC Directory: ${c.found_in_ndc_directory}`);
