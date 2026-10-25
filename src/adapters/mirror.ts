// Local mirror of the data estate for SAMPLE_MODE and offline judging: the
// same eight views Zetaris serves (a small SEC snapshot + Halden's simulated
// systems), loaded from data/sources into an in-process DuckDB under the same
// `terms.<view>` names, so the agents' SQL runs unchanged. Results are
// labelled source "mirror", never "live".

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { resolve } from "node:path";
import { CONTAINER, SOURCES } from "../sources.ts";

let conn: Promise<DuckDBConnection> | null = null;

async function open(): Promise<DuckDBConnection> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run(`CREATE SCHEMA ${CONTAINER}`);
  for (const t of SOURCES) {
    const file = resolve("data/sources", `${t.name}.json`).replace(/'/g, "''");
    const cols = t.columns.map((col) => `CAST(r.${col.name} AS ${col.type === "STRING" ? "VARCHAR" : col.type}) AS ${col.name}`).join(", ");
    await c.run(
      `CREATE VIEW ${CONTAINER}.${t.name} AS SELECT ${cols} FROM (SELECT unnest(records) AS r FROM read_json('${file}', maximum_object_size=67108864))`
    );
  }
  return c;
}

export async function mirrorQuery(sql: string, limit = 200): Promise<{ columns: string[]; rows: unknown[][] }> {
  conn ??= open();
  const c = await conn;
  // Spark-isms the agents may emit that DuckDB spells differently.
  const portable = sql.replace(/`/g, '"');
  const reader = await c.runAndReadAll(portable);
  const columns = reader.columnNames();
  const rows = reader.getRowsJS().slice(0, limit).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));
  return { columns, rows };
}
