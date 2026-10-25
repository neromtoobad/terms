// Risk Officer: holds every proposal to the credit policy before anything is
// executed. It applies the desk's knowledge (sector notes), checks each hard
// condition, and either accepts, adjusts (e.g. caps an increase), disputes
// with the Underwriter once, or overrules the model with the policy's own
// answer. It also decides whether the result needs the credit manager.

import { randomUUID } from "node:crypto";
import type { AccountFile, Decision, Proposal } from "../domain.ts";
import type { PolicyView } from "../policy.ts";
import type { Authority } from "./intake.ts";
import type { Trace } from "../trace.ts";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function violations(a: AccountFile, v: PolicyView, p: Proposal): string[] {
  const l = a.ledger;
  const out: string[] = [];
  const adverse = v.holdAll.length > 0 || v.prepayOrCut || v.revertTo !== undefined;
  if (v.cutAlready && p.newLimit < l.limit) out.push(`the limit was already cut under POL-5 within 30 days; cutting again needs a new condition`);
  if (p.newLimit > l.limit && !v.eligibleIncrease) out.push(`an increase is not allowed: ${v.noIncrease.join(", ")}`);
  if (p.newLimit > l.limit && v.eligibleIncrease && p.newLimit > v.maxLimit) out.push(`${usd(p.newLimit)} is above the policy maximum of ${usd(v.maxLimit)} (POL-6 caps an increase at 25%; POL-1 ceiling ${usd(v.ceiling)})`);
  if (v.revertTo !== undefined && p.newLimit > v.revertTo) out.push(`POL-8 requires reverting to ${usd(v.revertTo)}`);
  if (v.prepayOrCut && !v.cutAlready && v.revertTo === undefined && p.action !== "PREPAY" && p.newLimit > l.limit * 0.75) out.push(`POL-5 requires prepayment on new orders or a cut of at least 25% (to ${usd(l.limit * 0.75)} or less)`);
  let used = l.openAr;
  for (const o of p.orders) {
    const order = l.pendingOrders.find((x) => x.order_id === o.order_id);
    if (!order || o.action !== "release") continue;
    if (v.holdAll.length) out.push(`${o.order_id} cannot ship: ${v.holdAll.join(", ")} hold every new order`);
    else if (used + order.amount > p.newLimit) out.push(`${o.order_id} (${usd(order.amount)}) does not fit: ${usd(used)} open + order > ${usd(p.newLimit)} limit (POL-10)`);
    else used += order.amount;
  }
  if (!adverse && (p.action === "DECREASE" || p.action === "HOLD" || p.action === "PREPAY" || p.newLimit < l.limit)) {
    const why = v.dismissedFlags.length ? ` The ${v.dismissedFlags.map((d) => `${d.flag} is dismissed by ${d.by}`).join("; ")}.` : "";
    out.push(`no policy condition supports ${p.action === "PREPAY" ? "prepayment" : p.action === "HOLD" ? "a hold" : "a cut"}.${why}`);
  }
  return out;
}

export function finalize(a: AccountFile, v: PolicyView, p: Proposal, authority: Authority, extra: { riskNotes: string[]; disputes: number }): Decision {
  const l = a.ledger;
  // Cite what the evidence triggers, plus the clauses that govern the action itself.
  // Models tend to over-cite; a clause that does not apply is dropped.
  const hit = v.conditions.filter((c) => c.hit && c.id !== "POL-6").map((c) => c.id);
  const governs = new Set(["POL-2", "POL-9", "POL-10", ...hit, ...(p.newLimit > l.limit ? ["POL-6", "POL-1"] : []), ...v.dismissedFlags.map((d) => d.by), ...v.approvalClauses]);
  const dropped = p.clauses.filter((c) => !governs.has(c));
  if (dropped.length) extra.riskNotes.push(`Dropped citations that do not apply here: ${dropped.join(", ")}`);
  const clauses = [...new Set([...p.clauses.filter((c) => governs.has(c)), ...hit, "POL-9"])];
  const increase = p.newLimit - l.limit;
  const approvalWhy: string[] = [];
  if (increase > authority.maxAutoIncreaseUsd) approvalWhy.push(`the increase of ${usd(increase)} is above the desk's ${usd(authority.maxAutoIncreaseUsd)} authority (POL-2)`);
  if (increase > 0 && p.newLimit > authority.maxAutoLimitUsd) approvalWhy.push(`the new limit is above ${usd(authority.maxAutoLimitUsd)} (POL-2)`);
  if (increase > 0 && v.approvalClauses.length) approvalWhy.push(`${v.approvalClauses.join(", ")} requires the credit manager for increases`);
  // The action must say what the numbers do (a model may label an unchanged limit "DECREASE").
  const action = p.newLimit > l.limit ? "INCREASE" : p.newLimit < l.limit ? "DECREASE"
    : p.action === "INCREASE" || p.action === "DECREASE" ? (p.orders.some((o) => o.action === "prepay") ? "PREPAY" : p.orders.some((o) => o.action === "hold") ? "HOLD" : "KEEP")
    : p.action;
  return {
    ...p,
    action,
    clauses,
    id: `dec-${randomUUID().slice(0, 8)}`,
    ticker: a.ticker,
    fromLimit: l.limit,
    needsApproval: approvalWhy.length > 0,
    approvalReason: approvalWhy.join("; ") || undefined,
    riskNotes: extra.riskNotes,
    disputes: extra.disputes,
    dismissedFlags: v.dismissedFlags,
    evidence: [...new Set([...a.fundamentals.evidence, ...a.ledger.evidence])],
  };
}

export class RiskOfficer {
  constructor(private trace: Trace) {}

  review(a: AccountFile, v: PolicyView, p: Proposal): string[] {
    const found = violations(a, v, p);
    for (const d of v.dismissedFlags) {
      this.trace.log({
        agent_name: "Risk Officer", action: "apply_knowledge", status: "info",
        input_summary: `${a.ticker}: Analyst flag "${d.flag}"`,
        output_summary: `dismissed by ${d.by}: normal for this sector, not a distress signal on its own`,
        data: { ticker: a.ticker, clause: d.by },
      });
    }
    this.trace.log({
      agent_name: "Risk Officer", action: found.length ? "object" : "accept", target_agent: found.length ? "Underwriter" : "Executor",
      status: found.length ? "needs_revision" : "success",
      input_summary: `${a.ticker}: ${p.action} ${usd(a.ledger.limit)} → ${usd(p.newLimit)} (${p.by})`,
      output_summary: found.length ? found.join(" · ") : `consistent with policy: ${v.conditions.filter((c) => c.hit).map((c) => c.id).join(", ") || "no adverse conditions"}`,
      data: { ticker: a.ticker, conditions: v.conditions, violations: found },
    });
    return found;
  }

  overrule(a: AccountFile, v: PolicyView, p: Proposal, remaining: string[]): Proposal {
    this.trace.log({
      agent_name: "Risk Officer", action: "overrule_model", target_agent: "Executor", status: "needs_revision",
      input_summary: `${a.ticker}: model still proposes ${p.action} ${usd(p.newLimit)}`,
      output_summary: `policy answer applied instead: ${v.recommended.action} ${usd(v.recommended.newLimit)} (${remaining[0]})`,
      data: { ticker: a.ticker, rejected: p, applied: v.recommended },
    });
    return { ...v.recommended, rationale: `${v.recommended.rationale} (The Risk Officer overruled the model's ${p.action}: ${remaining[0]})` };
  }
}
