// Registers Terms' data estate in Zetaris: the SEC REST tables (straight to
// data.sec.gov, with SEC's required User-Agent), Halden's systems (served by
// Terms at /sources/<name>.json), a CACHE TABLE per raw table, and the
// flattened views in the `terms` container. Runs one statement at a time, as
// Zetaris requires, and treats "already exists" as done.
//
//   SOURCE_BASE_URL=http://host.docker.internal:8010 npx tsx --env-file=.env scripts/zetaris-setup.ts
//   --dry-run    print the statements only
//   --recache    only re-run the CACHE TABLE statements (after a Zetaris restart)

import { config } from "../src/config.ts";
import { ZetarisClient, ZetarisError } from "../src/adapters/zetaris.ts";
import { CONTAINER, SOURCES, zetarisDdl, zetarisRecache } from "../src/sources.ts";

const base = process.env.SOURCE_BASE_URL ?? "http://host.docker.internal:8010";
const statements = process.argv.includes("--recache") ? zetarisRecache() : zetarisDdl(base, config.secUserAgent);

if (process.argv.includes("--dry-run")) {
  for (const s of statements) console.log(s + ";\n");
  process.exit(0);
}

const z = new ZetarisClient(undefined, false);
if (z.mode !== "live") {
  console.error("ZETARIS_API_KEY is not set (or SAMPLE_MODE=true); nothing to register.");
  process.exit(1);
}

for (const sql of statements) {
  const label = sql.slice(0, 96);
  try {
    await z.run(sql);
    console.log(`PASS  ${label}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/already exist/i.test(msg)) console.log(`SKIP  ${label}  (already exists)`);
    else {
      console.log(`FAIL  ${label}\n      ${msg.slice(0, 300)}`);
      if ((e as ZetarisError).kind === "auth") process.exit(1);
    }
  }
  if (/data\.sec\.gov|^CACHE TABLE terms_sec/.test(sql)) await new Promise((r) => setTimeout(r, 200)); // SEC: at most 10 requests a second
}

// Verify: every view answers, with a row count.
for (const t of SOURCES) {
  const started = Date.now();
  try {
    const r = await z.run(`SELECT COUNT(*) AS n FROM ${CONTAINER}.${t.name}`);
    console.log(`ROWS  ${CONTAINER}.${t.name}: ${r.rows[0]?.[0]}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`FAIL  ${CONTAINER}.${t.name}: ${(e as Error).message.slice(0, 200)}`);
  }
}
