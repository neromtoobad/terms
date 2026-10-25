// The policy engine: what Halden's credit policy *requires* for an account,
// computed deterministically from the evidence. The Risk Officer holds every
// proposal to it, and it doubles as the desk's playbook when no model is
// available (SAMPLE_MODE, or Nightshift down).
//
// Knowledge is applied here, not in the Analyst: sector notes can dismiss a
// raw flag (SN-1: big-box retail runs a current ratio below 1.0 by design) or
// add a requirement (SN-2: acquired growth means staged, approved increases).

import { daysBetween, type LimitChange } from "./desk.ts";
import { sectorNotesFor } from "./knowledge.ts";
import type { AccountFile, Proposal } from "./domain.ts";
import type { Authority } from "./agents/intake.ts";

export interface Condition {
  id: string;
  hit: boolean;
  detail: string;
}

export interface PolicyView {
  ticker: string;
  conditions: Condition[];
  noIncrease: string[];          // clause ids that block an increase
  holdAll: string[];             // clause ids that require every new order to be held
  prepayOrCut: boolean;          // POL-5
  cutAlready: boolean;           // POL-5's cut was made in the last 30 days
  revertTo?: number;             // POL-8
  eligibleIncrease: boolean;     // POL-6
  maxLimit: number;              // highest limit the policy allows right now
  ceiling: number;               // POL-1
  approvalClauses: string[];     // clauses that make an increase need approval
  watchList: boolean;            // POL-11 input
  dismissedFlags: { flag: string; by: string }[];
  recommended: Proposal;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const roundUp = (n: number, step = 25_000) => Math.ceil(n / step) * step;
const roundDown = (n: number, step = 25_000) => Math.floor(n / step) * step;

export function evaluate(a: AccountFile, ctx: { asOf: string; lastIncrease?: LimitChange; lastDecrease?: LimitChange; requestedLimit?: number; authority: Authority }): PolicyView {
  const { fundamentals: f, ledger: l } = a;
  const notes = sectorNotesFor(a.ticker).map((n) => n.id);
  const conditions: Condition[] = [];
  const add = (id: string, hit: boolean, detail: string) => conditions.push({ id, hit, detail });

  const ceiling = Math.min(ctx.authority.maxLimitUsd, f.revenue ? 0.01 * f.revenue.value : ctx.authority.maxLimitUsd);
  add("POL-1", l.limit > ceiling, `ceiling ${usd(ceiling)} (the lower of $2,000,000 and 1% of ${f.revenue ? `${f.revenue.frame} revenue` : "revenue"})`);

  const pol3 = l.maxDaysPastDue > 60;
  add("POL-3", pol3, pol3 ? `${l.pastDue[0].invoice} is ${l.maxDaysPastDue} days past due` : `oldest undisputed past due ${l.maxDaysPastDue} days`);

  const pol4 = f.lossesInLast3 >= 2;
  add("POL-4", pol4, `net loss in ${f.lossesInLast3} of the last ${f.netIncome.length} quarters`);

  const pol5 = !!f.currentRatio && f.currentRatio.value < 1 && f.latestProfitable === false;
  // A cut of 25% or more in the last 30 days already satisfies POL-5's "cut" branch.
  const cutAlready = !!ctx.lastDecrease && daysBetween(ctx.lastDecrease.at, ctx.asOf) <= 30 && ctx.lastDecrease.to <= ctx.lastDecrease.from * 0.75;
  add("POL-5", pol5, f.currentRatio ? `current ratio ${f.currentRatio.value.toFixed(2)}, latest quarter ${f.latestProfitable ? "profitable" : "a loss"}${pol5 && cutAlready ? `; limit already cut ${usd(ctx.lastDecrease!.from)} → ${usd(ctx.lastDecrease!.to)} on ${ctx.lastDecrease!.at}` : ""}` : "no balance sheet filed");

  const pol7 = l.disputedTotal > 10_000;
  add("POL-7", pol7, l.disputes.length ? `${usd(l.disputedTotal)} disputed (${l.disputes.map((d) => d.invoice).join(", ")})` : "no disputes in the ledger");

  const inc = ctx.lastIncrease;
  const recentIncrease = !!inc && daysBetween(inc.at, ctx.asOf) <= 30 && daysBetween(inc.at, ctx.asOf) > 0;
  const pol8 = recentIncrease && l.pastDue.length > 0 && l.utilization > 0.9;
  add("POL-8", pol8, recentIncrease
    ? `raised ${usd(inc!.from)} → ${usd(inc!.to)} on ${inc!.at}; now ${Math.round(l.utilization * 100)}% used, ${l.pastDue.length ? `${l.pastDue[0].invoice} ${l.pastDue[0].days} days past due` : "nothing past due"}`
    : "no increase in the last 30 days");

  const yoy = f.revenue?.yoy ?? null;
  const why6: string[] = [];
  if (l.avgDaysLate6m === null || l.avgDaysLate6m > 5) why6.push(`pays ${l.avgDaysLate6m?.toFixed(1) ?? "?"} days late on average (max 5)`);
  if (l.utilization < 0.8) why6.push(`utilisation ${Math.round(l.utilization * 100)}% (needs 80%)`);
  if (yoy === null || yoy < -0.03) why6.push(yoy === null ? "no comparable revenue quarter" : `revenue ${(yoy * 100).toFixed(1)}% YoY (floor −3%)`);
  if (f.latestProfitable !== true) why6.push("latest quarter not profitable");
  if (l.maxDaysPastDue > 30) why6.push(`invoice ${l.maxDaysPastDue} days past due (max 30)`);
  const eligible = why6.length === 0;
  add("POL-6", eligible, eligible ? `eligible: up to +25% (${usd(roundDown(l.limit * 1.25, 12_500))})` : `not eligible: ${why6.join("; ")}`);

  // Knowledge: sector notes.
  const dismissedFlags: { flag: string; by: string }[] = [];
  for (const flag of f.flags) {
    if (/current ratio/.test(flag) && notes.includes("SN-1") && !pol5) dismissedFlags.push({ flag, by: "SN-1" });
  }
  const sn2 = notes.includes("SN-2") && (yoy ?? 0) > 0.25;
  if (notes.includes("SN-1") && f.currentRatio && f.currentRatio.value < 1) add("SN-1", true, `current ratio ${f.currentRatio.value.toFixed(2)} is normal for ${a.ticker}'s model; not a distress signal on its own`);
  if (sn2) add("SN-2", true, `revenue +${((yoy ?? 0) * 100).toFixed(0)}% YoY after an acquisition: raise in stages, with approval`);

  const noIncrease = [pol3 && "POL-3", pol4 && "POL-4", pol5 && "POL-5", pol7 && "POL-7", pol8 && "POL-8", !eligible && "POL-6"].filter(Boolean) as string[];
  const holdAll = [pol3 && "POL-3", pol8 && "POL-8"].filter(Boolean) as string[];
  const cap = Math.min(ceiling, eligible ? roundDown(l.limit * 1.25, 12_500) : l.limit);
  const approvalClauses = sn2 ? ["SN-2"] : [];

  const view: Omit<PolicyView, "recommended"> = {
    ticker: a.ticker, conditions, noIncrease, holdAll, prepayOrCut: pol5, cutAlready, revertTo: pol8 ? inc!.from : undefined,
    eligibleIncrease: eligible && noIncrease.length === 0, maxLimit: Math.max(cap, 0), ceiling, approvalClauses,
    watchList: pol4 || pol5, dismissedFlags,
  };
  return { ...view, recommended: playbook(a, view, ctx.requestedLimit) };
}

// The desk's deterministic underwriting: what an experienced credit analyst
// following the policy would do.
export function playbook(a: AccountFile, v: Omit<PolicyView, "recommended">, requestedLimit?: number): Proposal {
  const p = underwritePlaybook(a, v, requestedLimit);
  // What the desk remembers about this account (H-MEM) goes into the record.
  const lesson = a.memories.find((m) => m.content.startsWith("OUTCOME"));
  if (lesson) p.rationale += ` Desk memory: ${lesson.content.replace(/^OUTCOME \S+ \S+: /, "")}`;
  return p;
}

function underwritePlaybook(a: AccountFile, v: Omit<PolicyView, "recommended">, requestedLimit?: number): Proposal {
  const l = a.ledger;
  const pending = l.pendingOrders.reduce((s, o) => s + o.amount, 0);
  const cited = (ids: string[]) => [...new Set([...ids, "POL-9"])];
  const fit = (limit: number, hold: boolean) => {
    let used = l.openAr;
    return l.pendingOrders.map((o) => {
      if (hold) return { order_id: o.order_id, action: "hold" as const };
      if (used + o.amount <= limit) {
        used += o.amount;
        return { order_id: o.order_id, action: "release" as const };
      }
      return { order_id: o.order_id, action: "hold" as const };
    });
  };

  if (v.revertTo !== undefined) {
    return {
      action: "DECREASE", newLimit: v.revertTo, orders: fit(v.revertTo, true), confidence: 0.9, by: "playbook",
      clauses: cited(["POL-8"]),
      rationale: `The increase to ${usd(l.limit)} was followed within 30 days by a past-due invoice (${l.pastDue[0]?.invoice}, ${l.pastDue[0]?.days} days) and ${Math.round(l.utilization * 100)}% use of the new limit. POL-8: revert to ${usd(v.revertTo)} and hold new orders until the account is current.`,
    };
  }
  if (v.holdAll.length && v.prepayOrCut && !v.cutAlready) {
    const cut = roundDown(l.limit * 0.75);
    return {
      action: "DECREASE", newLimit: cut, orders: fit(cut, true), confidence: 0.92, by: "playbook",
      clauses: cited([...v.holdAll, ...v.noIncrease.filter((c) => c !== "POL-6"), "POL-5"]),
      rationale: `${l.pastDue[0]?.invoice} is ${l.maxDaysPastDue} days past due (POL-3: hold every new order), and the filings show a current ratio of ${a.fundamentals.currentRatio?.value.toFixed(2)} with a loss last quarter (POL-5). Cut the limit 25% to ${usd(cut)} and hold orders until the overdue invoice is paid.`,
    };
  }
  if (v.holdAll.length) {
    return {
      action: "HOLD", newLimit: l.limit, orders: fit(l.limit, true), confidence: 0.9, by: "playbook", clauses: cited(v.holdAll),
      rationale: `${l.pastDue[0]?.invoice} is ${l.maxDaysPastDue} days past due. POL-3: hold every new order until it is paid.`,
    };
  }
  if (v.prepayOrCut) {
    return {
      action: "PREPAY", newLimit: l.limit, orders: l.pendingOrders.map((o) => ({ order_id: o.order_id, action: "prepay" as const })), confidence: 0.85, by: "playbook",
      clauses: cited(["POL-5", ...v.noIncrease.filter((c) => c === "POL-4")]),
      rationale: `Current ratio ${a.fundamentals.currentRatio?.value.toFixed(2)} with a loss in the latest quarter (POL-5): keep the limit at ${usd(l.limit)} and ship new orders only against prepayment.${v.noIncrease.includes("POL-4") ? " Losses in most recent quarters also rule out any increase (POL-4)." : ""}`,
    };
  }
  const needsRoom = l.openAr + pending > l.limit;
  const wanted = requestedLimit ?? (needsRoom ? roundUp((l.openAr + pending) * 1.1) : undefined);
  if (v.eligibleIncrease && wanted && wanted > l.limit) {
    const to = Math.min(wanted, v.maxLimit);
    return {
      action: "INCREASE", newLimit: to, orders: fit(to, false), confidence: 0.8, by: "playbook",
      clauses: cited(["POL-6", "POL-2", "POL-10", ...v.approvalClauses]),
      rationale: `Pays ${l.avgDaysLate6m?.toFixed(1)} days late on average, ${Math.round(l.utilization * 100)}% used, revenue ${((a.fundamentals.revenue?.yoy ?? 0) * 100).toFixed(1)}% YoY and profitable: eligible under POL-6. Raise to ${usd(to)}${requestedLimit && requestedLimit > to ? ` (not the ${usd(requestedLimit)} asked: POL-6 caps an increase at 25%)` : ""} so the pending order${l.pendingOrders.length === 1 ? "" : "s"} fit${v.approvalClauses.length ? `; ${v.approvalClauses.join(", ")} sends it to the credit manager` : ""}.`,
    };
  }
  const orders = fit(l.limit, false);
  const held = orders.filter((o) => o.action === "hold").map((o) => o.order_id);
  return {
    action: "KEEP", newLimit: l.limit, orders, confidence: 0.85, by: "playbook",
    clauses: cited(["POL-10", ...(held.length ? v.noIncrease : []), ...(v.dismissedFlags.length ? ["SN-1"] : [])]),
    rationale: `No policy condition calls for a change. Keep ${usd(l.limit)}${l.pendingOrders.length ? `; ${held.length ? `${held.join(", ")} does not fit the limit and stays on hold` : "the pending order fits within the limit and can ship"}` : ""}.${v.dismissedFlags.length ? ` The ${v.dismissedFlags[0].flag} is normal for this business (SN-1).` : ""}${requestedLimit && requestedLimit > l.limit ? ` The requested ${usd(requestedLimit)} is not allowed: ${v.noIncrease.join(", ") || "POL-1"}.` : ""}`,
  };
}
