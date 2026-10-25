import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------- types (mirror the API)

type Action = "KEEP" | "INCREASE" | "DECREASE" | "HOLD" | "PREPAY";
interface TraceEvent { timestamp: string; agent_name: string; action: string; input_summary: string; output_summary: string; status: string; model?: string; target_agent?: string; data?: Record<string, any> }
interface Fundamentals { ticker: string; entity: string; revenue: { frame: string; value: number; priorFrame: string; prior: number | null; yoy: number | null } | null; netIncome: { frame: string; value: number }[]; lossesInLast3: number; latestProfitable: boolean | null; currentRatio: { frame: string; value: number } | null; flags: string[]; evidence: string[] }
interface Ledger { ticker: string; asOf: string; name: string; termsDays: number; erpLimit: number; limit: number; openAr: number; utilization: number; pastDue: { invoice: string; days: number; amount: number }[]; maxDaysPastDue: number; avgDaysLate6m: number | null; disputes: { invoice: string; amount: number }[]; disputedTotal: number; pendingOrders: { order_id: string; amount: number; ship_by: string }[]; notes: { date: string; category: string; note: string }[]; evidence: string[] }
interface Memory { id: string; content: string }
interface Condition { id: string; hit: boolean; detail: string }
interface Decision { id: string; ticker: string; action: Action; fromLimit: number; newLimit: number; orders: { order_id: string; action: string }[]; rationale: string; clauses: string[]; confidence: number; by: "model" | "playbook"; model?: string; needsApproval: boolean; approvalReason?: string; riskNotes: string[]; disputes: number; dismissedFlags: { flag: string; by: string }[]; evidence: string[]; execution?: { status: string; actions: string[]; approvalId?: string; noticeId?: string } }
interface Outcome { ticker: string; decided: string; verdict: "good" | "bad" | "neutral"; summary: string }
interface Account { fundamentals: Fundamentals; ledger: Ledger; memories: Memory[]; conditions: Condition[] }
interface RunResult { run_id: string; status: string; output: { summary: string; as_of: string; week: number; decisions: Decision[]; outcomes: Outcome[]; portfolio?: { total_limits: number; watch_list_share: number }; accounts: Record<string, Account> }; contract?: { contractId: string; lineage: string[]; risk: { flags: string[] } } }
interface Approval { id: string; ticker: string; from: number; to: number; orders: string[]; reason: string; status: string; decidedBy?: string; decisionId: string }
interface Notice { id: string; ticker: string; subject: string; body: string }
interface Desk { week: number; asOf: string; weeks: string[]; limits: Record<string, number>; approvals: Approval[]; notices: Notice[]; orders: Record<string, { state: string }>; busy: boolean }
interface Clause { id: string; title: string; text: string }

const CUSTOMERS: { ticker: string; name: string }[] = [
  { ticker: "WMT", name: "Walmart" }, { ticker: "TGT", name: "Target" }, { ticker: "KSS", name: "Kohl's" }, { ticker: "AAP", name: "Advance Auto Parts" },
  { ticker: "PTON", name: "Peloton" }, { ticker: "W", name: "Wayfair" }, { ticker: "BBWI", name: "Bath & Body Works" }, { ticker: "DKS", name: "Dick's Sporting Goods" },
];
const nameOf = (t: string) => CUSTOMERS.find((c) => c.ticker === t)?.name ?? t;

// ---------------------------------------------------------------- formatting

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const kusd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${+(a / 1e6).toFixed(a >= 1e8 ? 0 : 2)}M` : `${Math.round(a / 1e3)}K`;
  return `${n < 0 ? "−" : ""}$${s}`;
};
const dateLabel = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
function cell(x: unknown): string {
  const n = typeof x === "number" ? x : typeof x === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(x.trim()) ? Number(x) : null;
  if (n === null || !Number.isFinite(n)) return String(x ?? "");
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// A decision's card finish and label.
function finish(d?: Decision): { cls: string; label: string } {
  if (!d) return { cls: "f-blank", label: "Not reviewed" };
  if (d.execution?.status === "pending_approval") return { cls: "f-appr", label: "Needs approval" };
  return { cls: { KEEP: "f-keep", INCREASE: "f-inc", DECREASE: "f-dec", HOLD: "f-hold", PREPAY: "f-hold" }[d.action], label: { KEEP: "Keep", INCREASE: "Raised", DECREASE: "Cut", HOLD: "Hold", PREPAY: "Prepay" }[d.action] };
}
const orderLabel = (state: string) => ({ release: "ships", released: "ships", hold: "held", held: "held", prepay: "on prepayment", prepay_required: "on prepayment", pending_approval: "waits for approval" } as Record<string, string>)[state] ?? state;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  return (await r.json()) as T;
}

// ---------------------------------------------------------------- app

export default function App() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [policy, setPolicy] = useState<Record<string, Clause>>({});
  const [examples, setExamples] = useState<string[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [selected, setSelected] = useState("W");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState<any>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showLog, setShowLog] = useState(false);
  const queries = useRef(new Map<string, any>());
  const sheetRef = useRef<HTMLDivElement>(null);

  const refreshDesk = () => api<Desk>("/api/desk").then(setDesk);
  useEffect(() => {
    refreshDesk();
    api<any>("/api/health").then(setHealth);
    api<any>("/api/policy").then((p) => setPolicy(Object.fromEntries([...p.clauses, ...p.sector_notes].map((c: Clause) => [c.id, c]))));
    api<string[]>("/api/examples").then(setExamples);
    // Restore the latest review (and outcomes) after a reload.
    api<{ id: string; status: string }[]>("/api/jobs").then(async (jobs) => {
      let gotDecisions = false;
      let gotOutcomes = false;
      for (const j of jobs) {
        if (j.status !== "done" || (gotDecisions && gotOutcomes)) continue;
        const full = await api<{ events: TraceEvent[]; result: RunResult }>(`/api/jobs/${j.id}`);
        for (const e of full.events) if (e.action === "zetaris_query" && e.data?.queryId) queries.current.set(e.data.queryId, e.data);
        if (!gotDecisions && full.result.output.decisions.length) { setResult(full.result); setEvents(full.events); gotDecisions = true; }
        if (!gotOutcomes && full.result.output.outcomes.length) { setOutcomes(full.result.output.outcomes); gotOutcomes = true; }
      }
    });
  }, []);

  function stream(runId: string, label: string) {
    setRunning(label);
    setEvents([]);
    const es = new EventSource(`/api/jobs/${runId}/events`);
    es.addEventListener("trace", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as TraceEvent;
      if (e.action === "zetaris_query" && e.data?.queryId) queries.current.set(e.data.queryId, e.data);
      setEvents((prev) => [...prev.slice(-300), e]);
    });
    es.addEventListener("done", (m) => {
      es.close();
      const r = JSON.parse((m as MessageEvent).data) as RunResult;
      setRunning(null);
      if (r.output.decisions.length) setResult(r);
      if (r.output.outcomes.length) setOutcomes(r.output.outcomes);
      if (!r.output.decisions.length && !r.output.outcomes.length) setResult((prev) => (prev ? { ...prev, output: { ...prev.output, summary: r.output.summary } } : r));
      if (r.output.decisions.length === 1) setSelected(r.output.decisions[0].ticker);
      refreshDesk();
    });
  }

  async function ask(q: string) {
    if (!q.trim() || running) return;
    const r = await api<{ run_id?: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ query: q }) });
    if (r.run_id) stream(r.run_id, q);
  }
  async function advance() {
    if (running) return;
    const r = await api<{ run_id: string | null }>("/api/desk/advance", { method: "POST" });
    await refreshDesk();
    if (r.run_id) stream(r.run_id, "Checking how last week's terms held up");
  }
  async function reset() {
    if (running) return;
    await api("/api/desk/reset", { method: "POST" });
    setResult(null);
    setOutcomes([]);
    setEvents([]);
    refreshDesk();
  }
  async function decide(id: string, decision: "approve" | "reject") {
    await api(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision, by: "Credit manager" }) });
    refreshDesk();
  }

  // While a run streams, decisions and account files are assembled from the trace.
  const live = useMemo(() => {
    const decisions: Record<string, Decision> = {};
    const accounts: Record<string, Account> = {};
    const from: Record<string, number> = {};
    const reviewing = new Set<string>();
    for (const e of events) {
      if (e.action === "step_start") { reviewing.clear(); for (const t of e.data?.tickers ?? []) reviewing.add(t); }
      const t = e.data?.ticker;
      if (!t) continue;
      const acc = (accounts[t] ??= { fundamentals: null as any, ledger: null as any, memories: [], conditions: [] });
      if (e.data?.fundamentals) acc.fundamentals = e.data.fundamentals;
      if (e.data?.ledger) { acc.ledger = e.data.ledger; from[t] = e.data.ledger.limit; }
      if (e.action === "recall_memory") acc.memories = e.data?.memories ?? [];
      if (e.data?.conditions) acc.conditions = e.data.conditions;
      const p = e.agent_name === "Underwriter" ? e.data?.proposal : e.action === "overrule_model" ? e.data?.applied : null;
      if (p) decisions[t] = { riskNotes: [], dismissedFlags: [], evidence: [], needsApproval: false, disputes: 0, id: "", fromLimit: from[t] ?? p.newLimit, ...p, ticker: t };
      if (e.agent_name === "Executor" && e.data?.actions && decisions[t]) { decisions[t] = { ...decisions[t], execution: { status: e.action === "request_approval" ? "pending_approval" : "applied", actions: e.data.actions } }; reviewing.delete(t); }
    }
    for (const k of Object.keys(accounts)) if (!accounts[k].fundamentals || !accounts[k].ledger) delete accounts[k];
    return { decisions, accounts, reviewing };
  }, [events]);

  const decisions: Record<string, Decision> = running ? live.decisions : Object.fromEntries((result?.output.decisions ?? []).map((d) => [d.ticker, d]));
  const accounts: Record<string, Account> = running ? { ...(result?.output.accounts ?? {}), ...live.accounts } : result?.output.accounts ?? {};
  const approvals = desk?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const order = useMemo(() => {
    const rank = (t: string) => { const d = decisions[t]; if (!d) return 9; if (d.execution?.status === "pending_approval") return 0; return { DECREASE: 1, HOLD: 2, PREPAY: 2, INCREASE: 3, KEEP: 5 }[d.action]; };
    return CUSTOMERS.map((c) => c.ticker).sort((a, b) => rank(a) - rank(b));
  }, [result, running, events.length]);

  const totalLimits = result?.output.portfolio?.total_limits ?? Object.values(decisions).reduce((s, d) => s + d.newLimit, 0);
  const openAr = Object.values(accounts).reduce((s, a) => s + (a.ledger?.openAr ?? 0), 0);
  const changes = Object.values(decisions).filter((d) => d.newLimit !== d.fromLimit || d.action !== "KEEP").length;
  const lastLine = running ? [...events].reverse().find((e) => e.status !== "info" || e.action === "step_start")?.output_summary : undefined;
  const clauseTip = (id: string) => (policy[id] ? `${policy[id].title}: ${policy[id].text}` : id);
  const openEvidence = (q: string) => { const r = queries.current.get(q); if (r) setDrawer(r); };
  const pick = (t: string) => { setSelected(t); setTimeout(() => sheetRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); };

  const provider = health?.provider?.status === "online";
  const zetaris = health?.zetaris?.mode === "live";

  return (
    <div className="app">
      <header className="top">
        <div className="logo"><i><b /></i>Terms</div>
        <span className="mono sub">Credit desk · Halden Packaging <em>(simulated seller)</em></span>
        <div className="weeks">
          {(desk?.weeks ?? []).map((w, i) => <span key={w} className={desk?.week === i + 1 ? "on" : ""}>{i === 0 ? "Week of " : ""}{dateLabel(w)}</span>)}
        </div>
        <div className="actions">
          <button className="btn l" disabled={!!running || (desk ? desk.week >= desk.weeks.length : true)} onClick={advance}>Advance week</button>
          <button className="btn k" disabled={!!running} onClick={() => ask("Run the weekly credit review")}>{running ? "Working…" : "Run weekly review"}</button>
        </div>
      </header>

      <section className="hero">
        <div className="book">
          <div className="mono dim">Credit book · 8 customers · SEC filings live via Zetaris</div>
          <div className="big">{totalLimits ? <>{usd(totalLimits)}<s>.00</s></> : <>$—<s>.00</s></>}</div>
          <div className="lede">
            {running ? <><span className="pulse" />{lastLine ?? running}</> : result ? (changes ? `${changes} change${changes === 1 ? "" : "s"} this week.${pending.length ? ` ${pending.length} need${pending.length === 1 ? "s" : ""} you.` : ""}` : "No changes this week.") : "Run the weekly review: the desk reads each customer's SEC filings and Halden's ledger, then sets terms."}
          </div>
          <div className="tiles">
            <div className="tile"><em>Open receivables</em><b>{openAr ? kusd(openAr) : "—"}</b></div>
            <div className="tile"><em>Watch-list</em><b>{result?.output.portfolio ? `${(result.output.portfolio.watch_list_share * 100).toFixed(1)}%` : "—"}<small> / 30%</small></b></div>
            <button className="tile link" disabled={!pending.length} onClick={() => pending[0] && pick(pending[0].ticker)}><em>Waiting on you</em><b>{pending.length ? `${pending.length} approval${pending.length > 1 ? "s" : ""}` : "nothing"}</b></button>
          </div>
          <div className="src mono dim">
            <span className={`d ${zetaris ? "on" : ""}`} />Zetaris {!health ? "…" : zetaris ? "live" : "recorded"}
            <span className={`d ${provider ? "on" : ""}`} />Nemotron via Nightshift {!health ? "…" : provider ? "online" : "playbook"}
          </div>
        </div>
        <div className="fan">
          {order.slice().reverse().map((t, i) => {
            const k = order.length - 1 - i;
            return <Card key={t} t={t} d={decisions[t]} a={accounts[t]} busy={live.reviewing.has(t) && !!running} onClick={() => pick(t)}
              style={{ left: `calc(50% - 160px + ${(k - 3.5) * 46}px)`, top: `${96 + Math.abs(k - 3.5) * 9}px`, transform: `rotate(${(k - 3.5) * 6.5}deg) ${k === 0 ? "translateY(-34px) scale(1.1)" : ""}`, zIndex: 20 - k }} />;
          })}
        </div>
      </section>

      <section className="ask">
        <form onSubmit={(e) => { e.preventDefault(); ask(query); setQuery(""); }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ask the desk: “Dick's wants an $800,000 limit. Can we do it?”" disabled={!!running} />
          <button className="btn k" disabled={!!running || !query.trim()}>Ask</button>
        </form>
        <div className="chips">{examples.filter((x) => x !== "Run the weekly credit review").map((x) => <button key={x} className="chip" disabled={!!running} onClick={() => ask(x)}>{x}</button>)}</div>
      </section>

      {outcomes.length > 0 && (
        <section className="sec">
          <div className="sec-h"><h2>How last week's terms held up</h2><span className="mono">written to the desk's memory · H-MEM</span></div>
          <div className="held">
            {outcomes.map((o) => (
              <div key={o.ticker} className={`hold-row ${o.verdict}`}>
                <span className="tk">{o.ticker}</span>
                <span className="v">{o.verdict === "bad" ? "went wrong" : o.verdict === "good" ? "held up" : "watch"}</span>
                <p>{o.summary.replace(/^OUTCOME \S+ \S+: /, "")}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="sec">
        <div className="sec-h"><h2>This week's terms</h2><span className="mono">{desk ? `as of ${longDate(desk.asOf)}` : ""} · tap a card for its term sheet</span></div>
        <div className="grid">
          {order.map((t) => <Card key={t} t={t} d={decisions[t]} a={accounts[t]} busy={live.reviewing.has(t) && !!running} sel={selected === t} outcome={outcomes.find((o) => o.ticker === t)} onClick={() => pick(t)} />)}
        </div>
      </section>

      <section className="sec" ref={sheetRef}>
        <div className="sec-h"><h2>Term sheet · {nameOf(selected)}</h2><span className="mono">signed by the desk · evidence attached</span></div>
        <TermSheet t={selected} d={decisions[selected]} a={accounts[selected]} desk={desk} result={result} running={!!running}
          clauseTip={clauseTip} openEvidence={openEvidence} decide={decide} openNotice={(id) => setNotice(desk?.notices.find((n) => n.id === id) ?? null)} />
      </section>

      <section className="sec">
        <button className="log-toggle" onClick={() => setShowLog((v) => !v)}><span className="mono">Desk log</span> <b>{events.length} entries · every query, proposal, objection and action</b> <i>{showLog ? "Hide" : "Show"}</i></button>
        {showLog && (
          <div className="log">
            {[...events].reverse().slice(0, 120).map((e, i) => (
              <div key={i} className={`le ${e.status}`}>
                <span className="mono">{e.timestamp.slice(11, 19)}</span>
                <span className="who">{e.agent_name}</span>
                <span className="what">{e.output_summary}</span>
                {e.data?.queryId && <button className="qid" onClick={() => openEvidence(e.data!.queryId)}>{e.data.queryId}</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="foot">
        <span>Customers' financials are their real SEC filings, read live by Zetaris from data.sec.gov. Halden Packaging and its ledger are simulated. Reasoning by NVIDIA Nemotron via Meterless Nightshift. Not lending advice.</span>
        <button className="btn ghost" disabled={!!running} onClick={reset}>Reset demo</button>
      </footer>

      {drawer && (
        <div className="scrim" onClick={() => setDrawer(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dr-h"><div><div className="mono">Evidence · {drawer.source === "live" ? "ran on Zetaris (live)" : drawer.source === "cache" ? "recorded Zetaris result" : "local mirror"}</div><h3>{drawer.queryId}</h3></div><button className="btn l" onClick={() => setDrawer(null)}>Close</button></div>
            <pre>{drawer.sql}</pre>
            <table className="rows"><thead><tr>{drawer.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead><tbody>{drawer.rows.map((r: unknown[], i: number) => <tr key={i}>{r.map((x, j) => <td key={j}>{cell(x)}</td>)}</tr>)}</tbody></table>
            {drawer.rowCount > drawer.rows.length && <p className="mono" style={{ marginTop: 10 }}>showing {drawer.rows.length} of {drawer.rowCount} rows</p>}
          </div>
        </div>
      )}
      {notice && (
        <div className="scrim" onClick={() => setNotice(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dr-h"><div><div className="mono">Draft notice · {nameOf(notice.ticker)} · not sent (people send)</div><h3>{notice.subject}</h3></div><button className="btn l" onClick={() => setNotice(null)}>Close</button></div>
            <div className="letter">{notice.body.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the card: a customer's credit line

function Card({ t, d, a, busy, sel, outcome, style, onClick }: { t: string; d?: Decision; a?: Account; busy?: boolean; sel?: boolean; outcome?: Outcome; style?: React.CSSProperties; onClick: () => void }) {
  const f = finish(d);
  const limit = d ? d.newLimit : a?.ledger.limit;
  const used = a ? Math.round(a.ledger.utilization * 100) : null;
  const o = d?.orders[0];
  return (
    <button className={`card ${f.cls} ${busy ? "busy" : ""} ${sel ? "sel" : ""}`} style={style} onClick={onClick}>
      <div className="c-top"><span className="t">{t}</span><span className="stamp">{busy ? "Reviewing" : f.label}</span></div>
      <div className="n">{nameOf(t)}</div>
      <div className="chip-g" />
      <div className="lim">{limit !== undefined ? usd(limit) : "—"}{d && d.newLimit !== d.fromLimit && <span className="was">{usd(d.fromLimit)}</span>}</div>
      <div className="c-row"><span>NET {a?.ledger.termsDays ?? "—"}{used !== null ? ` · ${used}% used` : ""}</span><span>{o ? `${o.order_id} ${orderLabel(d?.execution?.status === "pending_approval" && o.action === "release" ? "pending_approval" : o.action)}` : d ? "no orders" : ""}</span></div>
      {outcome && <span className={`ribbon ${outcome.verdict}`}>{outcome.verdict === "bad" ? "last week went wrong" : "last week held up"}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- the term sheet

function TermSheet({ t, d, a, desk, result, running, clauseTip, openEvidence, decide, openNotice }: {
  t: string; d?: Decision; a?: Account; desk: Desk | null; result: RunResult | null; running: boolean;
  clauseTip: (id: string) => string; openEvidence: (q: string) => void; decide: (id: string, d: "approve" | "reject") => void; openNotice: (id: string) => void;
}) {
  if (!d || !a) {
    return <div className="ts"><Card t={t} a={a} onClick={() => {}} /><div className="sheet empty"><p>{running ? "The desk is reviewing this account…" : "No terms set for this account yet. Run the weekly review."}</p></div></div>;
  }
  const f = a.fundamentals;
  const l = a.ledger;
  const approval = desk?.approvals.find((x) => x.ticker === t && (x.status === "pending" || x.decisionId === d.id));
  const pendingApproval = approval?.status === "pending";
  const hits = a.conditions.filter((c) => c.hit && c.id !== "POL-6");
  const pol6 = a.conditions.find((c) => c.id === "POL-6");
  const contractId = result?.contract?.lineage?.at(-1) ?? result?.contract?.contractId ?? "";
  const lesson = a.memories.find((m) => m.content.startsWith("OUTCOME") || m.content.startsWith("APPROVAL"));
  return (
    <div className="ts">
      <div className="ts-left">
        <Card t={t} d={d} a={a} onClick={() => {}} style={{ transform: "rotate(-3deg)" }} />
        <div className="ts-note">
          <div className="mono">On file · H-MEM</div>
          {lesson ? <p>{lesson.content.replace(/^(OUTCOME|APPROVAL) \S+ \S+: /, "")}</p> : <p>Nothing learned about {nameOf(t)} yet. Next week the desk checks how these terms held up.</p>}
        </div>
      </div>
      <div className="sheet">
        <div className="sh-h">
          <div><div className="mono">Term sheet · Halden Packaging → {f.entity}</div><h3>{d.newLimit !== d.fromLimit || d.action !== "KEEP" ? "Revised credit terms" : "Credit terms confirmed"}, effective {longDate(l.asOf)}</h3></div>
          <span className="mono">ref {d.id || "draft"}</span>
        </div>
        <div className="tr"><span>Credit limit</span><b>{usd(d.newLimit)}{d.newLimit !== d.fromLimit && <s>{usd(d.fromLimit)}</s>}{pendingApproval && <i className="tag appr">requested</i>}</b></div>
        <div className="tr"><span>Payment terms</span><b>Net {l.termsDays} · pays {l.avgDaysLate6m?.toFixed(1) ?? "—"} days late on average · {Math.round(l.utilization * 100)}% used</b></div>
        {d.orders.map((o) => {
          const po = l.pendingOrders.find((x) => x.order_id === o.order_id);
          const state = desk?.orders[o.order_id]?.state ?? o.action;
          return <div className="tr" key={o.order_id}><span>Order {o.order_id}{po ? ` · ${usd(po.amount)}` : ""}</span><b className={`os ${state}`}>{orderLabel(state)}</b></div>;
        })}
        <div className="tr"><span>Because</span>
          <div className="why">
            {hits.length ? hits.map((c) => <p key={c.id}><i className={c.id.startsWith("SN") ? "sn" : ""} title={clauseTip(c.id)}>{c.id}</i>{c.detail}</p>) : <p><i className="ok">POL-10</i>No policy condition calls for a change.</p>}
            {d.action === "INCREASE" && pol6 && <p><i className="ok" title={clauseTip("POL-6")}>POL-6</i>{pol6.detail}</p>}
            {d.dismissedFlags.map((x) => <p key={x.flag}><i className="sn" title={clauseTip(x.by)}>{x.by}</i>flag cleared: {x.flag} is normal for this business</p>)}
          </div>
        </div>
        <div className="tr"><span>From the filings</span>
          <div className="facts">
            {f.revenue && <span><em>Revenue {f.revenue.frame}</em><b>{kusd(f.revenue.value)}</b>{f.revenue.yoy !== null && <i className={f.revenue.yoy < 0 ? "neg" : "pos"}>{f.revenue.yoy >= 0 ? "+" : ""}{(f.revenue.yoy * 100).toFixed(1)}% YoY</i>}</span>}
            <span><em>Net income, last 3 qtrs</em><b className="ni">{[...f.netIncome].reverse().map((n) => <u key={n.frame} className={n.value < 0 ? "neg" : ""}>{kusd(n.value)}</u>)}</b></span>
            {f.currentRatio && <span><em>Current ratio</em><b>{f.currentRatio.value.toFixed(2)}</b></span>}
          </div>
        </div>
        <div className="tr"><span>Reasoning</span><div><p className="rat">{d.rationale}</p>
          <p className="mono meta">{d.by === "model" ? `Underwriter · ${(d.model ?? "Nemotron").replace("nvidia/", "")}` : "Underwriter · desk playbook"} · confidence {Math.round(d.confidence * 100)}%{d.disputes ? ` · risk check objected ${d.disputes}× and the proposal was revised` : ""}</p>
          {d.riskNotes.filter((n) => !/^Dropped citations/.test(n) && !/dismissed by/.test(n)).map((n) => <p key={n} className="rnote">{n}</p>)}
        </div></div>
        <div className="tr"><span>Clauses</span><div className="qids">{d.clauses.map((c) => <em key={c} className="cl" title={clauseTip(c)}>{c}</em>)}</div></div>
        <div className="tr"><span>Evidence</span><div className="qids">{d.evidence.map((q) => <button key={q} className="qid" onClick={() => openEvidence(q)}>{q}</button>)}</div></div>
        <div className="sig">
          {pendingApproval ? (
            <>
              <div><div className="mono">Needs the credit manager's signature</div><p className="why-ap">{approval!.reason}</p>
                <div className="ap-btns"><button className="btn k" onClick={() => decide(approval!.id, "approve")}>Approve and sign</button><button className="btn l" onClick={() => decide(approval!.id, "reject")}>Reject</button></div></div>
              <div className="seal pend">PENDING<br /><small>approval</small></div>
            </>
          ) : (
            <>
              <div>
                <svg width="210" height="46" viewBox="0 0 210 46" aria-hidden="true"><path d="M4 34c18-22 30-26 34-14s-6 20 4 8 16-24 22-10-4 18 8 4 14-12 22-4 10 10 22-2 18-6 30 2 26-6 30-10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
                <div className="mono">{approval?.status === "approved" ? `Signed by ${approval.decidedBy ?? "the credit manager"} · ` : approval?.status === "rejected" ? `Rejected by ${approval.decidedBy ?? "the credit manager"} · ` : ""}contract {contractId.slice(0, 8)} · within desk authority</div>
              </div>
              <div className="sig-r">
                {d.execution?.noticeId && <button className="btn l" onClick={() => openNotice(d.execution!.noticeId!)}>Notice drafted ›</button>}
                <div className={`seal ${approval?.status === "rejected" ? "rej" : ""}`}>{approval?.status === "rejected" ? "REJECTED" : "EXECUTED"}<br /><small>{d.execution?.actions?.length ? `${d.execution.actions.length} action${d.execution.actions.length > 1 ? "s" : ""}` : "no change"}</small></div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
