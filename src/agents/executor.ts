// Executor: the only agent that changes anything. It applies a decision to
// the desk (limits, order holds/releases/prepayment, drafted notices) after
// verifying the Scout Intent contract for each capability it uses, and only
// within the contract's authority. Anything beyond it becomes an approval
// request for the credit manager; the orders that depend on it wait.

import { randomUUID } from "node:crypto";
import { desk, saveDesk, type Approval, type OrderState } from "../desk.ts";
import type { Decision } from "../domain.ts";
import { verify, type ExecutionContract } from "./intake.ts";
import type { Trace } from "../trace.ts";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export class Executor {
  constructor(private trace: Trace, private runId: string, private contract: () => ExecutionContract) {}

  private can(cap: string, ticker: string): boolean {
    const check = verify(this.contract(), cap);
    if (!check.ok) this.trace.log({ agent_name: "Executor", action: "contract_refused", status: "error", input_summary: `${ticker}: ${cap}`, output_summary: check.reason });
    return check.ok;
  }

  execute(d: Decision, asOf: string, week: number): Decision["execution"] {
    const s = desk();
    const actions: string[] = [];
    const a = this.contract().scope.authority;
    let status: NonNullable<Decision["execution"]>["status"] = "no_change";
    let approvalId: string | undefined;

    if (!d.evidence.length || !d.clauses.length) {
      this.trace.log({ agent_name: "Executor", action: "refuse_unevidenced", status: "error", input_summary: d.ticker, output_summary: "POL-9: a decision without evidence is not executed" });
      return { status: "blocked", actions: ["refused: no evidence (POL-9)"] };
    }

    // Limit
    const delta = d.newLimit - d.fromLimit;
    if (delta < 0 && this.can("credit.limit.decrease", d.ticker)) {
      s.limits[d.ticker] = d.newLimit;
      s.limitHistory.push({ ticker: d.ticker, from: d.fromLimit, to: d.newLimit, at: asOf, decisionId: d.id, approvedBy: "desk (POL-2 authority)" });
      actions.push(`limit ${usd(d.fromLimit)} → ${usd(d.newLimit)}`);
      status = "applied";
    } else if (delta > 0) {
      const within = delta <= a.maxAutoIncreaseUsd && d.newLimit <= a.maxAutoLimitUsd && d.newLimit <= a.maxLimitUsd;
      if (!d.needsApproval && within && this.can("credit.limit.increase", d.ticker)) {
        s.limits[d.ticker] = d.newLimit;
        s.limitHistory.push({ ticker: d.ticker, from: d.fromLimit, to: d.newLimit, at: asOf, decisionId: d.id, approvedBy: "desk (POL-2 authority)" });
        actions.push(`limit ${usd(d.fromLimit)} → ${usd(d.newLimit)}`);
        status = "applied";
      } else if (this.can("approval.request", d.ticker)) {
        const waiting = d.orders.filter((o) => o.action === "release").map((o) => o.order_id);
        const ap: Approval = {
          id: `apr-${randomUUID().slice(0, 6)}`, ticker: d.ticker, from: d.fromLimit, to: d.newLimit, orders: waiting,
          reason: d.approvalReason ?? `outside the desk's authority (${usd(a.maxAutoIncreaseUsd)} per increase, ${usd(a.maxAutoLimitUsd)} max)`,
          clauses: d.clauses, decisionId: d.id, status: "pending", requestedAt: asOf,
        };
        s.approvals = s.approvals.filter((x) => !(x.ticker === d.ticker && x.status === "pending"));
        s.approvals.push(ap);
        approvalId = ap.id;
        actions.push(`approval ${ap.id} requested: ${usd(d.fromLimit)} → ${usd(d.newLimit)}`);
        status = "pending_approval";
      }
    }

    // Orders
    for (const o of d.orders) {
      let state: OrderState = o.action === "release" ? "released" : o.action === "prepay" ? "prepay_required" : "held";
      if (state === "released" && status === "pending_approval") state = "pending_approval";
      const cap = state === "released" ? "orders.release" : state === "prepay_required" ? "orders.prepay" : "orders.hold";
      if (!this.can(state === "pending_approval" ? "orders.hold" : cap, d.ticker)) continue;
      s.orders[o.order_id] = { state, at: asOf, decisionId: d.id };
      actions.push(`${o.order_id} ${state.replace("_", " ")}`);
      if (status === "no_change") status = "applied";
    }

    // Notice to the customer (drafted, never sent by the desk)
    let noticeId: string | undefined;
    const adverse = d.action === "DECREASE" || d.action === "HOLD" || d.action === "PREPAY";
    if (adverse && this.can("notice.draft", d.ticker)) {
      noticeId = `ntc-${randomUUID().slice(0, 6)}`;
      const held = d.orders.filter((o) => o.action !== "release").map((o) => o.order_id);
      s.notices.push({
        id: noticeId, ticker: d.ticker, at: asOf, status: "draft", decisionId: d.id,
        subject: d.action === "PREPAY" ? "New orders on prepayment terms" : d.newLimit < d.fromLimit ? `Credit limit change to ${usd(d.newLimit)}` : "Orders on hold",
        body: [
          `Dear accounts payable team,`,
          d.newLimit < d.fromLimit ? `Your credit limit with Halden Packaging is now ${usd(d.newLimit)} (was ${usd(d.fromLimit)}).` : "",
          held.length ? `${d.action === "PREPAY" ? "We can ship" : "We are holding"} order${held.length > 1 ? "s" : ""} ${held.join(", ")}${d.action === "PREPAY" ? " on receipt of prepayment" : " until your account is brought current"}.` : "",
          `Reason: ${d.rationale.replace(/\s*\(The Risk Officer.*$/, "")}`,
          `Please contact your account manager with any questions.`,
        ].filter(Boolean).join("\n\n"),
      });
      actions.push(`notice ${noticeId} drafted`);
    }

    s.decisions.push({
      id: d.id, runId: this.runId, week, asOf, ticker: d.ticker, action: d.action, fromLimit: d.fromLimit, toLimit: status === "pending_approval" ? d.fromLimit : d.newLimit,
      orders: d.orders, clauses: d.clauses, evidence: d.evidence, execution: status,
    });
    saveDesk();
    this.trace.log({
      agent_name: "Executor", action: status === "pending_approval" ? "request_approval" : status === "applied" ? "apply_decision" : "no_change",
      status: "success", input_summary: `${d.ticker}: ${d.action}`,
      output_summary: actions.join(" · ") || "nothing to change",
      data: { ticker: d.ticker, decisionId: d.id, actions, approvalId, noticeId },
    });
    return { status, actions, approvalId, noticeId };
  }
}
