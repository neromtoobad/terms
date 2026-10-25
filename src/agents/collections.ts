// Collections: Halden's own view of the account, read through Zetaris from
// the AR ledger, the order book and the CRM: open receivables, how late the
// customer pays, what is past due, what is disputed, which orders wait for
// credit, and what staff have logged. The limit is the desk's effective limit
// (its own decisions on top of the ERP).

import { daysBetween, effectiveLimit } from "../desk.ts";
import { inList, num, rowsOf, str, type DataDesk } from "../data.ts";
import type { Ledger } from "../domain.ts";
import type { Trace } from "../trace.ts";

export function ledgerSql(tickers: string[], asOf: string) {
  const list = inList(tickers);
  return {
    invoices: `SELECT i.invoice_id, i.ticker, i.issue_date, i.due_date, i.amount_usd, i.paid_date, i.paid_usd, i.disputed, c.customer_name, c.payment_terms_days, c.credit_limit_usd FROM terms.invoices i JOIN terms.customers c ON c.ticker = i.ticker AND c.as_of = i.as_of WHERE i.as_of = '${asOf}' AND i.ticker IN (${list}) ORDER BY i.ticker, i.due_date`,
    orders: `SELECT order_id, ticker, order_date, ship_by, amount_usd, status FROM terms.orders WHERE as_of = '${asOf}' AND ticker IN (${list}) AND status = 'awaiting_credit' ORDER BY ticker, order_id`,
    notes: `SELECT note_date, ticker, category, note FROM terms.collections_notes WHERE as_of = '${asOf}' AND ticker IN (${list}) ORDER BY ticker, note_date`,
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export async function collect(tickers: string[], asOf: string, data: DataDesk, trace: Trace): Promise<Map<string, Ledger>> {
  const sql = ledgerSql(tickers, asOf);
  const [inv, ord, notes] = await Promise.all([
    data.query(sql.invoices, `AR ledger joined to the customer master as of ${asOf} (${tickers.join(", ")})`, "Collections"),
    data.query(sql.orders, `orders awaiting credit as of ${asOf}`, "Collections"),
    data.query(sql.notes, `collections notes as of ${asOf}`, "Collections"),
  ]);
  const out = new Map<string, Ledger>();
  for (const t of tickers) {
    const rows = rowsOf(inv).filter((r) => str(r.ticker) === t);
    if (!rows.length) continue;
    const head = rows[0];
    const erpLimit = num(head.credit_limit_usd);
    const limit = effectiveLimit(t, erpLimit);
    let openAr = 0;
    const pastDue: Ledger["pastDue"] = [];
    const disputes: Ledger["disputes"] = [];
    const lateness: number[] = [];
    for (const r of rows) {
      const due = str(r.due_date);
      const outstanding = num(r.amount_usd) - num(r.paid_usd);
      if (outstanding > 0.5) {
        openAr += outstanding;
        if (num(r.disputed) === 1) disputes.push({ invoice: str(r.invoice_id), amount: Math.min(outstanding, num(r.amount_usd)) });
        else if (due < asOf) pastDue.push({ invoice: str(r.invoice_id), days: daysBetween(due, asOf), amount: outstanding });
      }
      const paid = str(r.paid_date);
      if (paid && daysBetween(due, asOf) <= 180) lateness.push(Math.max(0, daysBetween(due, paid)));
    }
    // A dispute logged in the CRM can cover part of an invoice that was paid short.
    const noteRows = rowsOf(notes).filter((r) => str(r.ticker) === t).map((r) => ({ date: str(r.note_date), category: str(r.category), note: str(r.note) }));
    const l: Ledger = {
      ticker: t, asOf,
      name: str(head.customer_name),
      termsDays: num(head.payment_terms_days),
      erpLimit, limit,
      openAr,
      utilization: openAr / limit,
      pastDue: pastDue.sort((a, b) => b.days - a.days),
      maxDaysPastDue: pastDue.reduce((m, p) => Math.max(m, p.days), 0),
      avgDaysLate6m: lateness.length ? lateness.reduce((a, b) => a + b, 0) / lateness.length : null,
      disputes,
      disputedTotal: disputes.reduce((a, d) => a + d.amount, 0),
      pendingOrders: rowsOf(ord).filter((r) => str(r.ticker) === t).map((r) => ({ order_id: str(r.order_id), amount: num(r.amount_usd), ship_by: str(r.ship_by) })),
      notes: noteRows,
      evidence: [inv.queryId, ord.queryId, notes.queryId],
    };
    out.set(t, l);
    trace.log({
      agent_name: "Collections", action: "read_ledger", target_agent: "Underwriter", status: "success",
      input_summary: `${t} ledger as of ${asOf}`,
      output_summary: [
        `open ${money(openAr)} of ${money(limit)} (${Math.round(l.utilization * 100)}%)`,
        l.avgDaysLate6m !== null ? `pays ${l.avgDaysLate6m.toFixed(1)} days late on average` : "",
        l.maxDaysPastDue ? `oldest past due ${l.maxDaysPastDue} days` : "nothing past due",
        l.disputes.length ? `disputed ${money(l.disputedTotal)}` : "",
        l.pendingOrders.length ? `${l.pendingOrders.length} order(s) waiting: ${l.pendingOrders.map((o) => `${o.order_id} ${money(o.amount)}`).join(", ")}` : "",
      ].filter(Boolean).join(" · "),
      data: { ticker: t, ledger: l },
    });
  }
  return out;
}
