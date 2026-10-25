// One job, end to end.
//
// Review (portfolio, one account, an order release or a limit request):
//   Intake (Scout Intent contract with authority) -> Budget quote
//   -> Markovian steps of two accounts each; the carryover is the portfolio
//      exposure ledger, which enforces POL-11 across steps:
//        Analyst (SEC via Zetaris) + Collections (ledger via Zetaris)
//        -> Archivist recall (H-MEM: past decisions and outcomes)
//        -> policy engine (knowledge) -> Underwriter (Nemotron Ultra)
//        -> Risk Officer (dispute once, else overrule) -> Executor (within authority)
//        -> Archivist (H-MEM decision memory; World Model case file)
// Outcome review (after the week advances):
//   Collections reads the new week's ledger for every account decided last
//   week, and the Archivist writes how each decision turned out to H-MEM.

import { randomUUID } from "node:crypto";
import { Markovian } from "../engines/markovian/src/index.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { Brain } from "./brain.ts";
import { config } from "./config.ts";
import { DataDesk } from "./data.ts";
import { asOf as deskDate, desk, lastDecrease, lastIncrease, saveDesk } from "./desk.ts";
import type { AccountFile, Decision, Ledger, Request } from "./domain.ts";
import { evaluate } from "./policy.ts";
import { analyse } from "./agents/analyst.ts";
import { Archivist } from "./agents/archivist.ts";
import { Budget } from "./agents/budget.ts";
import { collect } from "./agents/collections.ts";
import { Executor } from "./agents/executor.ts";
import { AUTHORITY, intake, refresh, type ExecutionContract } from "./agents/intake.ts";
import { RiskOfficer, finalize } from "./agents/risk.ts";
import { underwrite } from "./agents/underwriter.ts";
import { WEEKS } from "./sources.ts";
import { Trace } from "./trace.ts";

export interface RunInput {
  run_id?: string;
  input: { query: string };
  options?: { sample_mode?: boolean };
}

export interface Outcome {
  ticker: string;
  decisionId: string;
  decided: string;
  verdict: "good" | "bad" | "neutral";
  summary: string;
  evidence: string[];
}

export interface RunOutput {
  run_id: string;
  status: "success" | "declined" | "error";
  output: {
    summary: string;
    as_of: string;
    week: number;
    decisions: Decision[];
    outcomes: Outcome[];
    approvals_requested: string[];
    notices_drafted: string[];
    portfolio?: { total_limits: number; watch_list_limits: number; watch_list_share: number };
    accounts: Record<string, { fundamentals: AccountFile["fundamentals"]; ledger: AccountFile["ledger"]; memories: AccountFile["memories"]; conditions: { id: string; hit: boolean; detail: string }[] }>;
    recommendations: string[];
    artifacts: { type: string; path: string }[];
    clarification?: { question: string; options: string[] };
  };
  agents: { name: string; role: string }[];
  contract?: Pick<ExecutionContract, "contractId" | "intent" | "risk" | "toolPlan" | "expiresAt" | "registryVersion"> & { authority: ExecutionContract["scope"]["authority"]; lineage: string[] };
  memory: { recalled: number; stored: number };
  engines: Record<string, string>;
  cost: Record<string, unknown>;
  data_sources: Record<string, number>;
  trace_id: string;
  log_file: string;
  execution_time_seconds: number;
  error?: { type: string; message: string; recoverable: boolean };
}

export const AGENTS = [
  { name: "Intake", role: "Scout Intent: classifies and guards the request, and signs the contract that fixes the desk's authority" },
  { name: "Analyst", role: "Reads each customer's real SEC filings through Zetaris: revenue trend, profit, liquidity" },
  { name: "Collections", role: "Reads Halden's ledger through Zetaris: utilisation, lateness, past due, disputes, orders waiting" },
  { name: "Archivist", role: "H-MEM memory of past decisions and how they turned out; World Model case file" },
  { name: "Underwriter", role: "Proposes each decision on Nemotron Ultra, citing clauses and evidence" },
  { name: "Risk Officer", role: "Applies the policy and sector notes, disputes the model, overrules it if needed, flags approvals" },
  { name: "Executor", role: "Changes limits and orders within authority; raises approvals and drafts notices for the rest" },
];

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export async function runJob(req: RunInput, hooks: { onTrace?: (t: Trace) => void; quiet?: boolean } = {}): Promise<RunOutput> {
  const runId = (req.run_id || `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`).replace(/[^A-Za-z0-9_-]/g, "");
  const started = Date.now();
  const trace = new Trace(runId, "logs", hooks.quiet);
  hooks.onTrace?.(trace);
  const sample = req.options?.sample_mode ?? config.sampleMode;
  const budget = new Budget(trace);
  const brain = new Brain(trace, budget, sample ? new MeterlessProvider({ token: "" }) : undefined);
  const zetaris = new ZetarisClient(undefined, sample);
  const date = deskDate();
  const week = desk().week;

  const base = (status: RunOutput["status"], extra: Omit<Partial<RunOutput>, "output"> & { output?: Partial<RunOutput["output"]> }): RunOutput => ({
    run_id: runId, status,
    agents: AGENTS, memory: { recalled: 0, stored: 0 },
    engines: { scout_intent: "contract issued", hmem: "-", world_model: "-", markovian: "-" },
    cost: budget.statement(), data_sources: {},
    trace_id: runId, log_file: trace.file,
    execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    ...extra,
    output: { summary: "", as_of: date, week, decisions: [], outcomes: [], approvals_requested: [], notices_drafted: [], accounts: {}, recommendations: [], artifacts: [{ type: "trace", path: trace.file }], ...extra.output },
  });

  trace.log({
    agent_name: "System", action: "start_run", status: "info",
    input_summary: req.input.query.slice(0, 200),
    output_summary: `desk date ${date} (week ${week}); provider ${brain.online ? `Meterless Nightshift (${brain.provider.baseUrl})` : "none: playbook underwriting"}; data ${zetaris.mode === "live" ? "Zetaris live (SEC + Halden)" : "recorded Zetaris results + local mirror"}`,
  });

  try {
    const { contract: issued, clarification } = await intake(req.input.query, trace, brain, runId);
    let contract = issued;
    const lineage = [contract.contractId];
    const r: Request = contract.intent.parameters;
    const contractView = () => ({ contractId: contract.contractId, intent: contract.intent, risk: contract.risk, toolPlan: contract.toolPlan, expiresAt: contract.expiresAt, registryVersion: contract.registryVersion, authority: contract.scope.authority, lineage });

    if (r.route === "decline") {
      return base("declined", { output: { summary: `Declined at intake: ${contract.risk.reason}.` }, contract: contractView() });
    }
    if (r.route === "clarify") {
      return base("declined", { output: { summary: "Which customer? The request does not name one the desk covers.", clarification }, contract: contractView() });
    }

    budget.quoteJob(r);
    const archivist = new Archivist(trace, runId);
    await archivist.openCase(r.text, date);
    const data = new DataDesk(zetaris, trace, budget, () => contract);

    if (r.intent === "outcome_review") {
      const outcomes = await reviewOutcomes(r, date, week, data, archivist, trace);
      const sources = sourceCounts(data);
      return base("success", {
        output: {
          summary: outcomes.length ? `Reviewed ${outcomes.length} decisions from week ${week - 1}: ${outcomes.filter((o) => o.verdict === "bad").map((o) => `${o.ticker} went wrong`).join(", ") || "none went wrong"}.` : "No decisions from an earlier week to review.",
          outcomes,
        },
        contract: contractView(),
        memory: { recalled: 0, stored: outcomes.length },
        engines: { scout_intent: `contract ${lineage[0].slice(0, 8)}`, hmem: `${outcomes.length} outcomes stored`, world_model: `${archivist.events()} case-file events`, markovian: "-" },
        cost: budget.statement(), data_sources: sources,
      });
    }

    const risk = new RiskOfficer(trace);
    const executor = new Executor(trace, runId, () => contract);
    const decisions: Decision[] = [];
    const accounts: RunOutput["output"]["accounts"] = {};
    let recalled = 0;
    let stored = 0;
    const chunks: string[][] = [];
    for (let i = 0; i < r.tickers.length; i += 2) chunks.push(r.tickers.slice(i, i + 2));

    // Exposure carried across steps; POL-11 is checked over it at the end.
    const book = new Map<string, { limit: number; watch: boolean }>();

    const markov = new Markovian({ chunkConfig: { chunkSize: 2000, maxChunks: Math.max(1, chunks.length), carryoverTokens: 256 } });
    const run = await markov.run({
      goal: r.text,
      mode: "ARCHITECT",
      reflect: false,
      stepFn: async ({ step, carryover }) => {
        const tickers = chunks[step];
        if (!tickers) return { content: "[TASK_COMPLETE]" };
        contract = refresh(contract); // Scout Intent: one contract per step, with lineage
        lineage.push(contract.contractId);
        if (!budget.approve("rounds", "System")) return { content: "Budget exhausted.\n[TASK_COMPLETE]" };
        trace.log({
          agent_name: "System", action: "step_start", status: "info", target_agent: "Analyst",
          input_summary: `Markovian step ${step + 1}/${chunks.length}; carryover ${carryover.length} chars`,
          output_summary: `accounts ${tickers.join(", ")}${carryover ? `; carried: ${carryover.replace(/\n/g, " | ").slice(0, 180)}` : ""}`,
          data: { engine: "Markovian", step: step + 1, tickers, carryover },
        });

        const [funds, ledgers] = await Promise.all([analyse(tickers, date, data, trace), collect(tickers, date, data, trace)]);
        for (const t of tickers) {
          const f = funds.get(t);
          const l = ledgers.get(t);
          if (!f || !l) continue;
          const memories = archivist.recall(t, l.name);
          recalled += memories.length;
          const file: AccountFile = { ticker: t, fundamentals: f, ledger: l, memories };
          const view = evaluate(file, { asOf: date, lastIncrease: lastIncrease(t), lastDecrease: lastDecrease(t), requestedLimit: r.intent === "limit_request" && r.tickers[0] === t ? r.requestedLimit : undefined, authority: contract.scope.authority });
          await archivist.putConditions(view, "Risk Officer");
          accounts[t] = { fundamentals: f, ledger: l, memories, conditions: view.conditions };

          let proposal = await underwrite(file, view, brain, trace, { requestedLimit: r.intent === "limit_request" ? r.requestedLimit : undefined });
          let found = risk.review(file, view, proposal);
          let disputes = 0;
          const riskNotes: string[] = [];
          if (found.length && proposal.by === "model") {
            disputes++;
            const revised = await underwrite(file, view, brain, trace, { requestedLimit: r.requestedLimit, feedback: found.join(" "), previous: proposal });
            const again = risk.review(file, view, revised);
            if (again.length) {
              riskNotes.push(`Model overruled: ${again[0]}`);
              proposal = risk.overrule(file, view, revised, again);
            } else {
              riskNotes.push(`Model revised its proposal after the Risk Officer objected: ${found[0]}`);
              proposal = revised;
            }
            found = [];
          } else if (found.length) {
            riskNotes.push(`Adjusted to policy: ${found[0]}`);
            proposal = view.recommended;
          }
          for (const d of view.dismissedFlags) riskNotes.push(`Analyst flag "${d.flag}" dismissed by ${d.by}`);

          const decision = finalize(file, view, proposal, contract.scope.authority, { riskNotes, disputes });
          book.set(t, { limit: decision.newLimit, watch: view.watchList });
          decision.execution = executor.execute(decision, date, week);
          await archivist.putDecision(decision, "Executor");
          archivist.rememberDecision(decision, date);
          stored++;
          decisions.push(decision);
        }
        const exposure = [...book.entries()].map(([t, b]) => `${t} ${usd(b.limit)}${b.watch ? " (watch)" : ""}`).join(", ");
        const last = step + 1 >= chunks.length;
        return { content: `Step ${step + 1} done.\n<CARRYOVER>${exposure}</CARRYOVER>${last ? "\n[TASK_COMPLETE]" : ""}` };
      },
    });

    // Portfolio view (POL-11) across every account the desk holds.
    const total = [...book.values()].reduce((a, b) => a + b.limit, 0);
    const watch = [...book.values()].filter((b) => b.watch).reduce((a, b) => a + b.limit, 0);
    const portfolio = r.intent === "portfolio_review" ? { total_limits: total, watch_list_limits: watch, watch_list_share: total ? watch / total : 0 } : undefined;
    if (portfolio) {
      trace.log({
        agent_name: "Risk Officer", action: "portfolio_check", status: portfolio.watch_list_share <= 0.3 ? "success" : "needs_revision",
        input_summary: "POL-11 watch-list concentration",
        output_summary: `watch-list limits ${usd(watch)} of ${usd(total)} (${(portfolio.watch_list_share * 100).toFixed(1)}%, cap 30%)`,
      });
    }

    const s = desk();
    const approvals = decisions.map((d) => d.execution?.approvalId).filter(Boolean) as string[];
    const notices = decisions.map((d) => d.execution?.noticeId).filter(Boolean) as string[];
    const changed = decisions.filter((d) => d.action !== "KEEP" || d.newLimit !== d.fromLimit);
    const claim = contract.risk.flags.includes("unverified_authority_claim") ? "The request's claim that someone senior approved it was not accepted; the desk applied the policy and its own authority. " : "";
    const summary = claim + (r.intent === "portfolio_review"
      ? `Week ${week} review (${date}): ${decisions.length} accounts. ${changed.length ? changed.map((d) => `${d.ticker} ${d.action.toLowerCase()}${d.newLimit !== d.fromLimit ? ` ${usd(d.fromLimit)} → ${usd(d.newLimit)}` : ""}${d.execution?.status === "pending_approval" ? " (awaiting approval)" : ""}`).join("; ") : "no changes"}. ${decisions.length - changed.length} kept.`
      : decisions.map((d) => `${d.ticker}: ${d.action} ${d.newLimit !== d.fromLimit ? `${usd(d.fromLimit)} → ${usd(d.newLimit)}` : usd(d.fromLimit)}${d.execution?.status === "pending_approval" ? " (awaiting the credit manager)" : ""}. ${d.rationale}`).join(" "));
    trace.log({
      agent_name: "System", action: "finish_run", status: "success",
      input_summary: `${run.chunks.length} Markovian steps (${run.status})`,
      output_summary: `${decisions.length} decisions, ${approvals.length} approval requests, ${notices.length} notices drafted; World Model events ${archivist.events()}`,
    });
    void s;

    return base("success", {
      output: {
        summary, decisions, approvals_requested: approvals, notices_drafted: notices, portfolio, accounts,
        recommendations: [...new Set(decisions.flatMap((d) => (d.execution?.status === "pending_approval" ? [`Credit manager: review approval ${d.execution.approvalId} for ${d.ticker} (${usd(d.fromLimit)} → ${usd(d.newLimit)}).`] : d.execution?.noticeId ? [`Send notice ${d.execution.noticeId} to ${d.ticker} after review.`] : [])))],
      },
      contract: contractView(),
      memory: { recalled, stored },
      engines: {
        scout_intent: `contract ${lineage[0].slice(0, 8)} refreshed ${lineage.length - 1}x`,
        hmem: `${recalled} recalled, ${stored} stored`,
        world_model: `${archivist.events()} case-file events`,
        markovian: `${run.chunks.length} bounded steps (${run.status}), ~${run.totalTokensSaved} tokens saved (estimated)`,
      },
      cost: budget.statement(), data_sources: sourceCounts(data),
    });
  } catch (e) {
    const err = e as Error & { type?: string };
    trace.log({ agent_name: "System", action: "run_failed", status: "error", input_summary: req.input.query.slice(0, 120), output_summary: err.message.slice(0, 300) });
    return base("error", { output: { summary: "The run failed before the desk could decide." }, error: { type: err.type ?? err.name ?? "Error", message: err.message, recoverable: true } });
  }
}

function sourceCounts(data: DataDesk): Record<string, number> {
  const sources: Record<string, number> = {};
  for (const r of data.results.values()) sources[r.source] = (sources[r.source] ?? 0) + 1;
  return sources;
}

// ---------------------------------------------------------------- outcomes

async function reviewOutcomes(r: Request, date: string, week: number, data: DataDesk, archivist: Archivist, trace: Trace): Promise<Outcome[]> {
  const s = desk();
  const prior = new Map<string, (typeof s.decisions)[number]>();
  for (const d of s.decisions.filter((x) => x.week === week - 1)) prior.set(d.ticker, d);
  const tickers = [...prior.keys()].filter((t) => r.tickers.includes(t));
  if (!tickers.length) return [];
  const ledgers = await collect(tickers, date, data, trace);
  const out: Outcome[] = [];
  for (const t of tickers) {
    const d = prior.get(t)!;
    const l = ledgers.get(t);
    if (!l) continue;
    const approval = s.approvals.find((a) => a.decisionId === d.id);
    const raised = d.toLimit > d.fromLimit || approval?.status === "approved";
    const pd = l.pastDue[0];
    let verdict: Outcome["verdict"] = "neutral";
    let text: string;
    if (raised) {
      const bad = l.pastDue.length > 0 && l.utilization > 0.9;
      verdict = bad ? "bad" : "good";
      text = `OUTCOME ${date} ${t}: after the increase to ${usd(approval?.status === "approved" ? approval.to : d.toLimit)} on ${d.asOf}, ${Math.round(l.utilization * 100)}% of the limit is in use and ${pd ? `${pd.invoice} is ${pd.days} days past due` : "nothing is past due"}.${bad ? " The customer stretched the new headroom while falling behind: an early-warning sign (POL-8)." : " Paying as agreed."}`;
    } else if (approval?.status === "pending") {
      text = `OUTCOME ${date} ${t}: the increase to ${usd(approval.to)} requested on ${d.asOf} is still awaiting the credit manager; ${pd ? `${pd.invoice} is ${pd.days} days past due` : "nothing is past due"}.`;
    } else if (d.action === "HOLD" || d.action === "DECREASE" || d.action === "PREPAY") {
      const was = d.orders.length ? ` with ${d.orders.map((o) => o.order_id).join(", ")} held` : "";
      verdict = l.maxDaysPastDue < 60 ? "good" : "bad";
      text = `OUTCOME ${date} ${t}: after the ${d.action.toLowerCase()} on ${d.asOf}${was}, the oldest past-due invoice is ${l.maxDaysPastDue ? `${l.maxDaysPastDue} days` : "cleared"}${l.notes.at(-1) ? `. Latest note: ${l.notes.at(-1)!.note.replace(/\.$/, "")}` : ""}.${verdict === "good" ? " The hold got the overdue invoice paid." : ""}`;
    } else {
      verdict = l.pastDue.length ? "neutral" : "good";
      text = `OUTCOME ${date} ${t}: kept at ${usd(d.toLimit)} on ${d.asOf}; ${pd ? `${pd.invoice} is now ${pd.days} days past due` : "paid as agreed"}${l.disputes.length ? `; ${usd(l.disputedTotal)} disputed` : ""}.`;
    }
    archivist.rememberOutcome(t, text, verdict, [d.id, ...l.evidence]);
    out.push({ ticker: t, decisionId: d.id, decided: `${d.action} on ${d.asOf}`, verdict, summary: text, evidence: l.evidence });
  }
  return out;
}

// ---------------------------------------------------------------- desk actions

export function decideApproval(id: string, decision: "approve" | "reject", by: string, note = ""): { ok: boolean; message: string } {
  const s = desk();
  const ap = s.approvals.find((a) => a.id === id);
  if (!ap) return { ok: false, message: "no such approval" };
  if (ap.status !== "pending") return { ok: false, message: `already ${ap.status}` };
  ap.status = decision === "approve" ? "approved" : "rejected";
  ap.decidedBy = by;
  ap.decidedAt = deskDate();
  ap.note = note;
  const trace = new Trace(`approval-${id}`, "logs", true);
  const archivist = new Archivist(trace, `approval-${id}`);
  if (decision === "approve") {
    s.limits[ap.ticker] = ap.to;
    s.limitHistory.push({ ticker: ap.ticker, from: ap.from, to: ap.to, at: deskDate(), decisionId: ap.decisionId, approvedBy: by });
    for (const o of ap.orders) s.orders[o] = { state: "released", at: deskDate(), decisionId: ap.decisionId };
  } else {
    for (const o of ap.orders) s.orders[o] = { state: "held", at: deskDate(), decisionId: ap.decisionId };
  }
  const d = s.decisions.find((x) => x.id === ap.decisionId);
  if (d && decision === "approve") d.toLimit = ap.to;
  saveDesk();
  archivist.rememberOutcome(ap.ticker, `APPROVAL ${deskDate()} ${ap.ticker}: ${by} ${ap.status} ${usd(ap.from)} → ${usd(ap.to)}${ap.orders.length ? ` (${ap.orders.join(", ")} ${decision === "approve" ? "released" : "kept on hold"})` : ""}${note ? `: ${note}` : ""}.`, "neutral", [ap.decisionId]);
  return { ok: true, message: `${ap.ticker} ${ap.status}` };
}

export function advanceWeek(): { week: number; asOf: string } {
  const s = desk();
  if (s.week < WEEKS.length) s.week += 1;
  saveDesk();
  return { week: s.week, asOf: deskDate() };
}

export type { Ledger };
void AUTHORITY;
