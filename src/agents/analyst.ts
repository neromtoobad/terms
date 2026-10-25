// Analyst: the customer's real financials from its SEC filings, read through
// Zetaris. Point in time: only filings made on or before the desk date count,
// so a week-1 decision never sees a later filing. One query is federated
// (Halden's ERP joined to SEC revenue) so the limit can be checked against
// POL-1's revenue ceiling in the same pass.
//
// The Analyst reports raw signals ("flags"); it does not judge them. Knowledge
// (sector notes) is applied later by the Risk Officer.

import { CUSTOMERS } from "../sources.ts";
import { inList, num, rowsOf, str, type DataDesk } from "../data.ts";
import type { Fundamentals } from "../domain.ts";
import type { Trace } from "../trace.ts";

export function fundamentalsSql(tickers: string[], asOf: string) {
  const list = inList(tickers);
  return {
    revenue: `SELECT c.ticker, c.credit_limit_usd, r.frame, r.period_end, r.value_usd AS revenue_usd FROM terms.customers c JOIN terms.sec_revenue r ON r.ticker = c.ticker WHERE c.as_of = '${asOf}' AND c.ticker IN (${list}) AND length(r.frame) = 8 AND r.period_end >= '2024-07-01' AND r.filed <= '${asOf}' ORDER BY c.ticker, r.period_end`,
    netIncome: `SELECT ticker, frame, period_end, value_usd AS net_income_usd FROM terms.sec_net_income WHERE ticker IN (${list}) AND length(frame) = 8 AND period_end >= '2025-01-01' AND filed <= '${asOf}' ORDER BY ticker, period_end`,
    liquidity: `SELECT a.ticker, a.frame, a.period_end, a.value_usd AS assets_current_usd, l.value_usd AS liabilities_current_usd FROM terms.sec_assets_current a JOIN terms.sec_liabilities_current l ON l.ticker = a.ticker AND l.frame = a.frame WHERE a.ticker IN (${list}) AND a.period_end >= '2025-06-01' AND a.filed <= '${asOf}' ORDER BY a.ticker, a.period_end`,
  };
}

const priorFrame = (frame: string) => `CY${Number(frame.slice(2, 6)) - 1}${frame.slice(6)}`;

export async function analyse(tickers: string[], asOf: string, data: DataDesk, trace: Trace): Promise<Map<string, Fundamentals>> {
  const sql = fundamentalsSql(tickers, asOf);
  const [rev, ni, liq] = await Promise.all([
    data.query(sql.revenue, `SEC revenue by quarter, joined to Halden's limits (${tickers.join(", ")})`, "Analyst"),
    data.query(sql.netIncome, `SEC net income by quarter (${tickers.join(", ")})`, "Analyst"),
    data.query(sql.liquidity, `SEC current assets vs current liabilities (${tickers.join(", ")})`, "Analyst"),
  ]);
  const out = new Map<string, Fundamentals>();
  for (const t of tickers) {
    const revRows = rowsOf(rev).filter((r) => str(r.ticker) === t).map((r) => ({ frame: str(r.frame), end: str(r.period_end), v: num(r.revenue_usd) }));
    const latest = revRows.sort((a, b) => a.end.localeCompare(b.end)).at(-1);
    const prior = latest ? revRows.find((r) => r.frame === priorFrame(latest.frame)) : undefined;
    const niRows = rowsOf(ni).filter((r) => str(r.ticker) === t).map((r) => ({ frame: str(r.frame), end: str(r.period_end), value: num(r.net_income_usd) })).sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
    const liqRow = rowsOf(liq).filter((r) => str(r.ticker) === t).sort((a, b) => str(b.period_end).localeCompare(str(a.period_end)))[0];

    const revenue = latest ? { frame: latest.frame, value: latest.v, priorFrame: priorFrame(latest.frame), prior: prior?.v ?? null, yoy: prior ? latest.v / prior.v - 1 : null } : null;
    const currentRatio = liqRow ? { frame: str(liqRow.frame), assets: num(liqRow.assets_current_usd), liabilities: num(liqRow.liabilities_current_usd), value: num(liqRow.assets_current_usd) / num(liqRow.liabilities_current_usd) } : null;
    const lossesInLast3 = niRows.filter((r) => r.value < 0).length;
    const flags: string[] = [];
    if (currentRatio && currentRatio.value < 1) flags.push(`current ratio ${currentRatio.value.toFixed(2)} is below 1.0`);
    if (lossesInLast3 >= 2) flags.push(`net loss in ${lossesInLast3} of the last 3 quarters`);
    if (revenue?.yoy !== null && revenue?.yoy !== undefined && revenue.yoy < -0.03) flags.push(`revenue down ${(revenue.yoy * -100).toFixed(1)}% year on year`);
    if (revenue?.yoy !== null && revenue?.yoy !== undefined && revenue.yoy > 0.25) flags.push(`revenue up ${(revenue.yoy * 100).toFixed(0)}% year on year`);

    const f: Fundamentals = {
      ticker: t,
      entity: CUSTOMERS.find((c) => c.ticker === t)?.name ?? t,
      revenue,
      netIncome: niRows.map(({ frame, value }) => ({ frame, value })),
      lossesInLast3,
      latestProfitable: niRows.length ? niRows[0].value > 0 : null,
      currentRatio,
      flags,
      evidence: [rev.queryId, ni.queryId, liq.queryId],
    };
    out.set(t, f);
    trace.log({
      agent_name: "Analyst", action: "read_filings", target_agent: "Underwriter", status: "success",
      input_summary: `${t} SEC filings up to ${asOf}`,
      output_summary: [
        revenue ? `revenue ${revenue.frame} $${(revenue.value / 1e9).toFixed(2)}B${revenue.yoy !== null ? ` (${revenue.yoy >= 0 ? "+" : ""}${(revenue.yoy * 100).toFixed(1)}% YoY)` : ""}` : "no revenue filed",
        niRows.length ? `net income ${niRows.map((r) => `${r.frame} ${r.value < 0 ? "-" : ""}$${Math.abs(r.value / 1e6).toFixed(0)}M`).join(", ")}` : "",
        currentRatio ? `current ratio ${currentRatio.value.toFixed(2)} (${currentRatio.frame})` : "",
        flags.length ? `flags: ${flags.join("; ")}` : "no flags",
      ].filter(Boolean).join(" · "),
      data: { ticker: t, fundamentals: f },
    });
  }
  return out;
}
