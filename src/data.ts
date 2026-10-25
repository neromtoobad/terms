// Every Zetaris query goes through here: the Scout Intent contract is verified
// first (signature, expiry, data.sql capability), the budget is charged, and
// the result is kept by query id so decisions can cite it as evidence.

import { ZetarisClient, ZetarisError, type QueryResult } from "./adapters/zetaris.ts";
import type { Budget } from "./agents/budget.ts";
import { verify, type ExecutionContract } from "./agents/intake.ts";
import type { Trace } from "./trace.ts";

export class DataDesk {
  readonly results = new Map<string, QueryResult>();

  constructor(private zetaris: ZetarisClient, private trace: Trace, private budget: Budget, private contract: () => ExecutionContract) {}

  get mode(): "live" | "cache" {
    return this.zetaris.mode;
  }

  async query(sql: string, purpose: string, agent: string, target?: string): Promise<QueryResult> {
    const check = verify(this.contract(), "data.sql");
    if (!check.ok) {
      this.trace.log({ agent_name: agent, action: "contract_refused", status: "error", input_summary: purpose, output_summary: check.reason });
      throw new Error(`contract check failed: ${check.reason}`);
    }
    if (!this.budget.approve("queries", agent)) throw new Error("query budget exhausted");
    try {
      const r = await this.zetaris.run(sql);
      this.results.set(r.queryId, r);
      this.trace.log({
        agent_name: agent, action: "zetaris_query", target_agent: target, status: "success",
        input_summary: purpose,
        output_summary: `${r.rowCount} rows from ${r.source === "live" ? "Zetaris (live)" : r.source === "cache" ? "recorded Zetaris result" : "local mirror"} in ${r.ms} ms`,
        data: { queryId: r.queryId, sql: r.sql, source: r.source, columns: r.columns, rows: r.rows.slice(0, 12), rowCount: r.rowCount },
      });
      return r;
    } catch (e) {
      const msg = e instanceof ZetarisError ? e.message : (e as Error).message;
      this.trace.log({ agent_name: agent, action: "zetaris_error", status: "error", input_summary: purpose, output_summary: msg.slice(0, 240), data: { sql } });
      throw e;
    }
  }
}

// Zetaris returns numbers as strings ("6.366E9"); the mirror returns numbers.
export const num = (v: unknown): number => (v === null || v === undefined || v === "" ? NaN : typeof v === "number" ? v : Number(v));
export const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function rowsOf(r: QueryResult): Record<string, unknown>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

export const inList = (tickers: string[]) => tickers.map((t) => `'${t.replace(/[^A-Z]/g, "")}'`).join(", ");
