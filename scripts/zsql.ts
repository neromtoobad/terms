// Run SQL statements against Zetaris one at a time and print results (dev helper).
//   npx tsx --env-file=.env scripts/zsql.ts "SELECT 1" "SELECT 2"
import { ZetarisClient } from "../src/adapters/zetaris.ts";
const z = new ZetarisClient(undefined, false);
for (const sql of process.argv.slice(2)) {
  const t = Date.now();
  try {
    const r = await z.run(sql);
    console.log(`OK ${((Date.now() - t) / 1000).toFixed(1)}s  ${sql.slice(0, 100)}\n  cols=${r.columns.join(",")} rows=${r.rowCount}`, JSON.stringify(r.rows.slice(0, 5)));
  } catch (e) {
    console.log(`ERR ${((Date.now() - t) / 1000).toFixed(1)}s  ${sql.slice(0, 100)}\n  ${(e as Error).message.slice(0, 300)}`);
  }
}
