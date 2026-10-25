// Underwriter: proposes the decision for one account (action, new limit, what
// happens to each pending order) with the clauses and evidence it relies on.
// Reasoning runs on Nemotron Ultra through Meterless Nightshift; without a
// model the desk's playbook proposes instead, and the trace says so.

import { policyText } from "../knowledge.ts";
import type { AccountFile, Action, OrderAction, Proposal } from "../domain.ts";
import type { PolicyView } from "../policy.ts";
import type { Brain } from "../brain.ts";
import type { Trace } from "../trace.ts";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
// Keep whole sentences: cut at the last full stop within the limit.
const sentences = (s: string, max: number) => (s.length <= max ? s : s.slice(0, s.lastIndexOf(". ", max) + 1 || max));
const ACTIONS: Action[] = ["KEEP", "INCREASE", "DECREASE", "HOLD", "PREPAY"];

export function dossier(a: AccountFile, view: PolicyView, requestedLimit?: number): string {
  const f = a.fundamentals;
  const l = a.ledger;
  return [
    `Customer: ${f.entity} (${a.ticker}), desk date ${l.asOf}.`,
    `SEC filings: ${f.revenue ? `revenue ${f.revenue.frame} ${usd(f.revenue.value)}${f.revenue.yoy !== null ? ` (${(f.revenue.yoy * 100).toFixed(1)}% vs ${f.revenue.priorFrame})` : ""}` : "no revenue"}; net income ${f.netIncome.map((n) => `${n.frame} ${usd(n.value)}`).join(", ") || "n/a"}; ${f.currentRatio ? `current ratio ${f.currentRatio.value.toFixed(2)} (${f.currentRatio.frame})` : "no balance sheet"}. Analyst flags: ${f.flags.join("; ") || "none"}.`,
    `Ledger: terms net ${l.termsDays}; limit ${usd(l.limit)}${l.limit !== l.erpLimit ? ` (ERP ${usd(l.erpLimit)})` : ""}; open ${usd(l.openAr)} (${Math.round(l.utilization * 100)}% used); average ${l.avgDaysLate6m?.toFixed(1) ?? "?"} days late over 6 months; past due: ${l.pastDue.map((p) => `${p.invoice} ${p.days}d ${usd(p.amount)}`).join(", ") || "none"}; disputed ${usd(l.disputedTotal)}.`,
    `Orders waiting for credit: ${l.pendingOrders.map((o) => `${o.order_id} ${usd(o.amount)} ship by ${o.ship_by}`).join(", ") || "none"}.`,
    `Notes: ${l.notes.slice(-4).map((n) => `[${n.date} ${n.category}] ${n.note}`).join(" ") || "none"}`,
    `Desk memory (H-MEM): ${a.memories.slice(0, 4).map((m) => m.content).join(" | ") || "nothing recorded for this account"}`,
    `Policy conditions computed from the evidence: ${view.conditions.map((c) => `${c.id} ${c.hit ? "HIT" : "ok"} (${c.detail})`).join("; ")}.`,
    requestedLimit ? `The request asks for a limit of ${usd(requestedLimit)}.` : "",
  ].filter(Boolean).join("\n");
}

export async function underwrite(a: AccountFile, view: PolicyView, brain: Brain, trace: Trace, opts: { requestedLimit?: number; feedback?: string; previous?: Proposal } = {}): Promise<Proposal> {
  const reply = await brain.think<{ action?: string; new_limit_usd?: number; orders?: { order_id: string; action: string }[]; rationale?: string; clauses?: string[]; confidence?: number }>(
    "Underwriter", "deep",
    `You are the underwriter on a B2B trade-credit desk at Halden Packaging. Decide this customer's credit for the week. Follow the credit policy exactly and cite clause ids. You may: KEEP the limit, INCREASE it, DECREASE it, HOLD orders, or require PREPAY on new orders. For each pending order say release, hold or prepay. Ground every statement in the numbers given; never invent figures.\n\nCredit policy and sector notes:\n${policyText()}`,
    `${dossier(a, view, opts.requestedLimit)}\n${opts.feedback ? `\nThe Risk Officer rejected your previous proposal (${opts.previous?.action} ${usd(opts.previous?.newLimit ?? 0)}): ${opts.feedback}\nRevise it.\n` : ""}\nReturn {"action": "KEEP|INCREASE|DECREASE|HOLD|PREPAY", "new_limit_usd": number, "orders": [{"order_id": "...", "action": "release|hold|prepay"}], "rationale": "2-3 sentences citing numbers and clause ids", "clauses": ["POL-…", "SN-…"], "confidence": 0-1}`,
    { maxTokens: 900 }
  );
  if (reply && ACTIONS.includes(String(reply.action).toUpperCase() as Action) && Number.isFinite(Number(reply.new_limit_usd))) {
    const known = new Set(a.ledger.pendingOrders.map((o) => o.order_id));
    const orders = a.ledger.pendingOrders.map((o) => {
      const r = reply.orders?.find((x) => x.order_id === o.order_id);
      const act = String(r?.action ?? "hold").toLowerCase();
      return { order_id: o.order_id, action: (["release", "hold", "prepay"].includes(act) ? act : "hold") as OrderAction };
    });
    void known;
    const p: Proposal = {
      action: String(reply.action).toUpperCase() as Action,
      newLimit: Math.round(Number(reply.new_limit_usd)),
      orders,
      rationale: sentences(String(reply.rationale ?? ""), 900),
      clauses: (reply.clauses ?? []).map(String).filter((c) => /^(POL|SN)-\d+$/.test(c)),
      confidence: Math.max(0, Math.min(1, Number(reply.confidence ?? 0.6))),
      by: "model",
      model: brain.lastModel,
    };
    trace.log({
      agent_name: "Underwriter", action: opts.feedback ? "revise_proposal" : "propose", target_agent: "Risk Officer", status: "success", model: brain.lastModel, confidence: p.confidence,
      input_summary: `${a.ticker} account file${opts.feedback ? " + Risk Officer objection" : ""}`,
      output_summary: `${p.action} ${usd(a.ledger.limit)} → ${usd(p.newLimit)}; orders ${p.orders.map((o) => `${o.order_id} ${o.action}`).join(", ") || "none"}; cites ${p.clauses.join(", ") || "nothing"}. ${p.rationale.slice(0, 220)}`,
      data: { ticker: a.ticker, proposal: p },
    });
    return p;
  }
  const p = view.recommended;
  trace.log({
    agent_name: "Underwriter", action: "propose", target_agent: "Risk Officer", status: brain.online ? "fallback" : "success", confidence: p.confidence,
    input_summary: `${a.ticker} account file`,
    output_summary: `${brain.online ? "model reply unusable; " : ""}playbook: ${p.action} ${usd(a.ledger.limit)} → ${usd(p.newLimit)}; orders ${p.orders.map((o) => `${o.order_id} ${o.action}`).join(", ") || "none"}; cites ${p.clauses.join(", ")}`,
    data: { ticker: a.ticker, proposal: p },
  });
  return p;
}
