// Snapshot of the SEC facts Terms reads, for the offline mirror only
// (SAMPLE_MODE with no network). The live path never uses this: Zetaris
// fetches the same facts from data.sec.gov itself. Kept small on purpose
// (8 customers, 4 concepts, filings from 2023 on).
//
//   npx tsx scripts/fetch-sec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { CUSTOMERS, SEC_CONCEPTS } from "../src/sources.ts";

interface Fact { start?: string; end: string; val: number; fy: number; fp: string; form: string; filed: string; frame?: string }

mkdirSync("data/sources", { recursive: true });
for (const c of SEC_CONCEPTS) {
  const records: Record<string, unknown>[] = [];
  for (const cu of CUSTOMERS) {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cu.cik}/us-gaap/${c.tag}.json`, { headers: { "User-Agent": config.secUserAgent } });
    if (!res.ok) throw new Error(`${cu.ticker} ${c.tag}: HTTP ${res.status}`);
    const body = (await res.json()) as { cik: number; entityName: string; tag: string; units: { USD?: Fact[] } };
    for (const f of body.units.USD ?? []) {
      if (!f.frame || f.end < "2023-01-01") continue;
      records.push({
        ticker: cu.ticker, cik: String(body.cik), entity_name: body.entityName, concept: body.tag, frame: f.frame,
        period_start: c.instant ? null : f.start ?? null, period_end: f.end, value_usd: f.val, fiscal_year: f.fy,
        fiscal_period: f.fp, form: f.form, filed: f.filed,
      });
    }
    await new Promise((r) => setTimeout(r, 150)); // SEC asks for at most 10 requests a second
  }
  writeFileSync(`data/sources/${c.view}.json`, JSON.stringify({ system: "SEC EDGAR snapshot for the offline mirror", fetched: new Date().toISOString(), records }, null, 1));
  console.log(`${c.view}: ${records.length} facts`);
}
