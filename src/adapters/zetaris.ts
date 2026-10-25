// Zetaris adapter: one SQL statement per call over the REST API
// (POST /sql-editor/sqls/run, Bearer API key, X-Org-ID, fresh UUID
// X-Request-ID). Every live result is recorded into data/cache keyed by a
// hash of the normalised SQL, which is what SAMPLE_MODE answers from.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { mirrorQuery } from "./mirror.ts";

export interface QueryResult {
  queryId: string;      // stable id used as the evidence reference in briefs
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  source: "live" | "cache" | "mirror";
  ms: number;
}

export class ZetarisError extends Error {
  constructor(message: string, readonly sql: string, readonly kind: "sql" | "auth" | "network" | "cache-miss") {
    super(message);
  }
}

const CACHE_DIR = "data/cache";

export const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
export const sqlHash = (sql: string): string => createHash("sha256").update(normalizeSql(sql).toLowerCase()).digest("hex").slice(0, 16);

export class ZetarisClient {
  private live: boolean;

  constructor(private opts = config.zetaris, sampleMode = config.sampleMode) {
    this.live = !sampleMode && Boolean(opts.apiKey);
  }

  get mode(): "live" | "cache" {
    return this.live ? "live" : "cache";
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.run("SELECT 1 AS one");
      return { ok: String(r.rows[0]?.[0]) === "1", detail: r.source };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async run(sql: string, limit = this.opts.rowLimit): Promise<QueryResult> {
    const clean = normalizeSql(sql);
    const id = `q_${sqlHash(clean)}`;
    if (!this.live) return this.offline(clean, id, limit);

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.opts.restUrl.replace(/\/+$/, "")}/sql-editor/sqls/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "X-Org-ID": this.opts.orgId,
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queryId: randomUUID(), sql: clean, source: "SqlEditor", limit }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      // Live source unreachable: degrade to the recorded answer or the mirror.
      try {
        return await this.offline(clean, id, limit);
      } catch {
        throw new ZetarisError(`Zetaris unreachable: ${(e as Error).message}`, clean, "network");
      }
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new ZetarisError("Zetaris rejected the API key", clean, "auth");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || body.error || body.errorMessage || (body.msg && !body.data)) {
      const msg = String(body.errorMessage ?? body.msg ?? body.message ?? body.error ?? text).replace(/^org\.apache\.hive\.service\.cli\.HiveSQLException: Error running query: /, "").slice(0, 400);
      throw new ZetarisError(msg || `HTTP ${res.status}`, clean, "sql");
    }
    const result: QueryResult = {
      queryId: id,
      sql: clean,
      columns: extractColumns(body),
      rows: (body.data as unknown[][]) ?? [],
      rowCount: ((body.data as unknown[][]) ?? []).length,
      source: "live",
      ms: Date.now() - started,
    };
    if (this.opts.recordCache) this.record(result);
    return result;
  }

  private record(r: QueryResult): void {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${r.queryId}.json`), JSON.stringify({ sql: r.sql, columns: r.columns, rows: r.rows, recordedAt: new Date().toISOString() }, null, 1));
  }

  // Offline path: a recorded live answer first, else the local DuckDB mirror
  // of the same tables. SQL errors from the mirror surface as "sql" errors so
  // the Investigator's repair loop behaves the same as against Zetaris.
  private async offline(sql: string, id: string, limit: number): Promise<QueryResult> {
    try {
      return this.fromCache(sql, id);
    } catch {
      /* not recorded */
    }
    const started = Date.now();
    try {
      const r = await mirrorQuery(sql, limit);
      return { queryId: id, sql, columns: r.columns, rows: r.rows, rowCount: r.rows.length, source: "mirror", ms: Date.now() - started };
    } catch (e) {
      throw new ZetarisError((e as Error).message.split("\n")[0].slice(0, 400), sql, "sql");
    }
  }

  private fromCache(sql: string, id: string): QueryResult {
    const file = join(CACHE_DIR, `${id}.json`);
    if (!existsSync(file)) throw new ZetarisError("not in the sample cache (SAMPLE_MODE answers only recorded queries)", sql, "cache-miss");
    const c = JSON.parse(readFileSync(file, "utf8")) as { columns: string[]; rows: unknown[][] };
    return { queryId: id, sql, columns: c.columns, rows: c.rows, rowCount: c.rows.length, source: "cache", ms: 0 };
  }
}

function extractColumns(body: Record<string, unknown>): string[] {
  for (const k of ["columns", "columnNames", "header", "headers", "schema", "fields"]) {
    const v = body[k];
    if (Array.isArray(v)) return v.map((c) => (typeof c === "string" ? c : String((c as Record<string, unknown>).name ?? (c as Record<string, unknown>).columnName ?? (c as Record<string, unknown>).label ?? "")));
  }
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && Array.isArray(meta.columns)) return extractColumns(meta);
  const rows = body.data as unknown[][] | undefined;
  return rows?.[0] ? rows[0].map((_, i) => `col${i + 1}`) : [];
}

// Render rows compactly for prompts and briefs.
export function tableText(r: Pick<QueryResult, "columns" | "rows">, maxRows = 25): string {
  const head = r.columns.join(" | ");
  const body = r.rows.slice(0, maxRows).map((row) => row.map((v) => (v === null ? "∅" : typeof v === "number" ? +v.toFixed(4) : String(v))).join(" | "));
  const more = r.rows.length > maxRows ? `\n… ${r.rows.length - maxRows} more rows` : "";
  return [head, ...body].join("\n") + more;
}
