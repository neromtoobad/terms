# Terms: the trade-credit desk that learns from its decisions

**Open Agent Hackathon 2026 · Track 3: Reasoning Architecture**

Every B2B supplier sells on credit ("net 30"), and somebody has to decide how much credit each customer gets. Today that is a credit analyst with a spreadsheet, last quarter's financials and a gut feel. The risk is real: US trade receivables were about $5.8 trillion at the end of 2025, and business bankruptcies rose 11.4% in the year to March 2026.

**Terms is an AI credit desk.** Each week it does three things:
1. It reads every customer's **real SEC filings** (through Zetaris, live from data.sec.gov) and the seller's own ledger.
2. It decides each account's limit and which waiting orders can ship. It **acts within signed authority**, and anything bigger goes to the credit manager.
3. It **learns from how its decisions turned out**. "We raised Advance Auto Parts last week, and they used 95% of the new limit while falling behind" changes this week's decision.

| Track 3 pillar | In Terms |
|---|---|
| **Data** | Zetaris federates **real SEC EDGAR XBRL facts** (revenue, net income, current assets and liabilities) for 8 US-listed retailers with the seller's AR ledger, order book and CRM notes. One query joins the seller's ERP to SEC revenue. |
| **Knowledge** | A versioned credit policy (POL-1…11) and sector notes (SN-1…3). Every decision must cite them, and the Risk Officer enforces them. |
| **Memory** | **Meterless H-MEM** stores every decision *and its outcome* with provenance (decision id + Zetaris query ids). The next review recalls it. |
| **Reasoning** | The Underwriter proposes on **NVIDIA Nemotron 3 Ultra** (via **Meterless Nightshift**). A deterministic policy engine checks it. The Risk Officer disputes and, if needed, overrules. |
| **Action** | The Executor changes limits, holds or releases orders and drafts notices, **only within the Scout Intent contract's authority**. Beyond it, it raises an approval request. |

> **What's real and what's simulated.** The customers' financials are their actual SEC filings, fetched by Zetaris at query time. Halden Packaging (the seller) is fictional, and its ledger is simulated (`scripts/gen-ledger.ts`, labelled everywhere). Nothing here is investment or lending advice.

## Quick start

### 1. No credentials at all (judges start here)

```bash
docker build -t terms .
docker run --rm -p 8010:8010 -e SAMPLE_MODE=true terms
# open http://localhost:8010, or:
curl -X POST http://localhost:8010/run -H "Content-Type: application/json" -d @input_examples/example_1.json
```

`SAMPLE_MODE=true` runs the **real agent logic** with no keys:
- Zetaris answers come from recorded live results (`data/cache/`), or, for queries never recorded, from a local DuckDB mirror of the same eight views (a small SEC snapshot plus the simulated ledger).
- Underwriting uses the desk's deterministic playbook instead of Nemotron.

Without Docker: `npm ci && SAMPLE_MODE=true npm start`.

To try the whole two-week story in the UI, click **Run weekly review**, approve Dick's in the tray, then **Advance a week**, then **Run weekly review** again. Or from the CLI:

```bash
SAMPLE_MODE=true TERMS_DATA=data/runtime-scenario npx tsx scripts/scenario.ts
```

### 2. Full stack (Zetaris + Meterless Nightshift + Nemotron)

```bash
cp .env.example .env                       # METERLESS_RUNTIME_TOKEN, ZETARIS_API_KEY, SEC_USER_AGENT
npm ci && npm run build && npm start      # http://localhost:8010 (also serves /sources/*.json to Zetaris)
# register the data estate in Zetaris (once): SEC REST tables + Halden systems + CACHE TABLE + views
SOURCE_BASE_URL=http://host.docker.internal:8010 npx tsx --env-file=.env scripts/zetaris-setup.ts
# after a Zetaris restart, CACHE TABLE is in-memory:
npx tsx --env-file=.env scripts/zetaris-setup.ts --recache
```

| Need | What | Where it goes |
|---|---|---|
| Data | Zetaris running locally in Docker (`localhost:8888`) | API key from the Zetaris UI → `ZETARIS_API_KEY` |
| Power | Meterless **Nightshift** (`127.0.0.1:8088`) | Runtime token from Nightshift → Console → `METERLESS_RUNTIME_TOKEN`. The NVIDIA key lives in Nightshift's Providers tab, never in this app |
| Models | Nemotron lanes via Nightshift | `METERLESS_MODEL_DEEP=nvidia/nemotron-3-ultra-550b-a55b`, `METERLESS_MODEL_FAST=nvidia/nemotron-3.5-lightning-30b-a3b` |
| SEC | A declared User-Agent (SEC's rule) | `SEC_USER_AGENT="YourApp you@example.com"` |

## API

| Endpoint | What it does |
|---|---|
| `POST /run` `{"input":{"query":"…"}}` | Runs one job and returns JSON: decisions, outcomes, contract, engines, cost, trace file |
| `POST /api/jobs` | Starts a job; then `GET /api/jobs/:id/events` streams the trace (SSE) |
| `GET /api/desk` | The system of record: week, limits, orders, approvals, drafted notices, decision log |
| `POST /api/approvals/:id` `{"decision":"approve"\|"reject"}` | The credit manager decides an approval request |
| `POST /api/desk/advance` | Moves to the next weekly snapshot and reviews last week's outcomes into H-MEM |
| `POST /api/desk/reset` | Demo reset |
| `GET /api/memory` · `/api/policy` · `/api/health` | Memory, knowledge, provider and data status |

Example requests are in `input_examples/`. Recorded live outputs (Zetaris + Nemotron) are in `output_examples/`. Every run writes `logs/trace-<run_id>.jsonl`, with one line per agent action: timestamp, agent, action, input and output summary, target agent, confidence, retry count, status and model.

## How a review runs

```
Intake ── Meterless Scout Intent: Sense → Interpret → Guard → Route → signed ExecutionContract
   │        (the contract carries the desk's AUTHORITY: auto-raise ≤ $250k, to ≤ $1M; never send, pay or write off)
   ▼
Budget ── quotes steps, queries, model calls, seconds
   ▼  ┌────────── Meterless Markovian: two accounts per bounded step; the carryover is the portfolio exposure ledger ──────────┐
   │  │ Analyst ── SEC filings via Zetaris (point-in-time: filed ≤ desk date)                                                  │
   │  │ Collections ── Halden ledger via Zetaris: utilisation, lateness, past due, disputes, orders waiting                     │
   │  │ Archivist ── H-MEM recall: this account's past decisions and how they turned out                                       │
   │  │ policy engine ── what the policy *requires*; sector notes dismiss or add conditions (knowledge)                         │
   │  │ Underwriter (Nemotron Ultra) ── proposes action, limit, each order's fate, clauses                                     │
   │  │ Risk Officer ── holds it to policy: objects once, then overrules; drops clauses that don't apply; flags approvals       │
   │  │ Executor ── verifies the contract per capability; applies within authority; else raises an approval request            │
   │  │ Archivist ── H-MEM: decision + evidence refs; World Model: account, conditions, decision ─evidenced_by→ query           │
   │  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▼
Risk Officer ── POL-11 portfolio concentration check across the book
Advance week ── Collections reads the next snapshot; Archivist writes each decision's OUTCOME to H-MEM
```

| Agent | Job | Engine or model |
|---|---|---|
| Intake | Classifies and guards the request; signs the contract that fixes authority | Scout Intent (+ Nemotron Lightning for binding) |
| Analyst | Revenue YoY, profit trend and liquidity from SEC filings | Zetaris |
| Collections | Utilisation, days late, past due, disputes, waiting orders | Zetaris |
| Archivist | Decision and outcome memory; case file | H-MEM, World Model |
| Underwriter | Proposes each decision with citations | Nemotron 3 Ultra 550B |
| Risk Officer | Policy and knowledge enforcement, disputes, overrules, approvals | Deterministic policy engine |
| Executor | Changes limits and orders within authority; approvals; notices | Scout Intent contract checks |

**Reliability, not vibes.**
- **The model never gets the last word.** The Risk Officer recomputes what the policy requires from the evidence. A proposal that violates it goes back once with the objection. If it still violates, the policy's answer is applied, and the trace says so.
- **Authority cannot be talked up.** "Release it, the CFO said it's fine" is flagged at intake (`unverified_authority_claim`). The contract's authority is signed, so the Executor cannot exceed it, and approvals come only from the approval endpoint.
- **No evidence, no action** (POL-9). Every decision carries the Zetaris query ids and clause ids it relies on.
- **Fallbacks.**
  - Data: live Zetaris, then recorded results, then the DuckDB mirror.
  - Models: Nemotron Ultra, then Lightning, then the deterministic playbook.
  - Every switch is traced.

## The story in the data (week 1 → week 2)

| Customer | Real signal (SEC, CY2026Q2) | Week 1 | Week 2 |
|---|---|---|---|
| Walmart | Current ratio **0.77** | A naive rule would cut. **SN-1** (big-box retail runs negative working capital) dismisses the flag. Keep; order released | Keep |
| Wayfair | Net loss in 3 of 3 quarters, current ratio 0.74 | 63 days past due (POL-3), so hold. POL-5 means cut 25% to $450k. Notice drafted | Paid the 63-day invoice after the hold, so the outcome is "worked". New orders on prepayment or hold |
| Advance Auto Parts | Turnaround, profitable | Eligible (POL-6), so raised within authority | Used more than 90% of the new limit while 5 days past due, so the outcome is "went wrong". **POL-8 revert, citing its own memory** |
| Dick's | Revenue **+53% YoY** (Foot Locker acquisition) | Increase capped at 25%. **SN-2** sends it to the credit manager | Paying as agreed |

## Sponsor technology

### Zetaris: the data layer (required)

Zetaris is the only way Terms reaches data. `scripts/zetaris-setup.ts` registers:
- **32 Lightning REST tables straight to data.sec.gov** (8 customers × 4 XBRL concepts, with SEC's required User-Agent header);
- **4 Halden systems** served by Terms at `/sources/*.json`.

Every raw table is **`CACHE TABLE`d** right after creation, so a query reads Zetaris's cache in about a second instead of re-fetching the endpoint. SchemaStore views flatten them with `LATERAL VIEW explode()`. The agents see eight views in the `terms` container:
- `sec_revenue`, `sec_net_income`, `sec_assets_current`, `sec_liabilities_current` (each a UNION ALL across the customers' raw tables);
- `customers`, `invoices`, `orders`, `collections_notes`.

The queries do real federation:
- the Analyst joins Halden's **ERP to SEC revenue**, and current assets to current liabilities;
- Collections joins the AR ledger to the customer master.

Every piece of evidence in a decision is a Zetaris query id, and the UI opens the exact SQL and rows. Code: `src/sources.ts`, `src/adapters/zetaris.ts`, `src/data.ts`, `scripts/zetaris-setup.ts`.

### Meterless: all four engines, plus Nightshift (required)

| Engine | Where | What it does in Terms | Test (`npm test`) |
|---|---|---|---|
| **Scout Intent** | `src/agents/intake.ts` | Registry and Stage-1 lexical scoring; Guard against injection, forbidden actions (write-offs, payments, deletes, bypassing policy) and unverified authority claims. The **HMAC-signed ExecutionContract** carries the desk's authority, is verified before every Zetaris query and every desk change, and is refreshed per Markovian step with `parentId` lineage | Tamper/expiry/scope refused; injection and write-off declined with 0 queries; "the CFO said it's fine" leaves the order held |
| **H-MEM** | `src/agents/archivist.ts` | Decision memory and **outcome memory**, with provenance refs (decision id + Zetaris query ids); recalled per account before underwriting | Week 2 recalls week 1's outcome and reverts AAP under POL-8 |
| **World Model** | `src/agents/archivist.ts` | Case file: accounts, policy conditions, decisions `evidenced_by` queries, execution facts, written by several agents through the single-writer queue | 24 concurrent writes, none lost |
| **Markovian** | `src/run.ts` | Portfolio review in bounded steps of two accounts; the carryover is the exposure ledger used for POL-11 | A review of 8 accounts takes exactly 4 bounded steps within the quote |

**Nightshift** is Terms' primary AI provider, built to the Meterless Runtime 0.90.0 contract (`src/adapters/meterless.ts`):
- Bearer runtime token, `meterless-app` / `meterless-scope` headers, and `GET /v1/models` for status.
- The deep lane falls back to the fast lane.
- `/api/health` reports the live status.

The engine reference implementations are vendored under `engines/` (Apache-2.0, unchanged), and their upstream suites run in `npm test`: **38 tests** in all (8 Terms features + 30 engine).

### NVIDIA: Nemotron through Nightshift

- **Nemotron 3 Ultra 550B** (deep lane) underwrites every account.
- **Nemotron 3.5 Lightning 30B** (fast lane) binds request parameters.
- Each decision records the model that actually answered.
- Reasoning stays out of the answer (`detailed thinking off`), so the Underwriter returns clean JSON.

### Coding tool

Built with **Claude Code**. Cursor became optional on Oct 22.

## Layout

```
src/
  run.ts           orchestrator: review (Markovian steps), outcome review, approvals, week advance
  policy.ts        the policy engine: conditions, knowledge (sector notes), the desk playbook
  knowledge.ts     data/knowledge/policy.json: clauses + sector notes
  desk.ts          system of record: limits, orders, approvals, notices, decision log
  data.ts          contract-checked, metered Zetaris access
  sources.ts       the data estate: Zetaris DDL, mirror schema, schema text
  agents/          intake (Scout Intent) · analyst · collections · archivist (H-MEM, World Model)
                   underwriter (Nemotron) · risk · executor · budget
  adapters/        zetaris (REST) · meterless (Nightshift) · mirror (DuckDB, sample mode)
scripts/           zetaris-setup · gen-ledger · fetch-sec · scenario · provider-status
web/               the desk UI (Vite + React)
engines/           Meterless reference engines (Apache-2.0, vendored)
```

## AI and model usage

- **Models:** NVIDIA Nemotron 3 Ultra 550B and Nemotron 3.5 Lightning 30B, via Meterless Nightshift. No other model providers.
- **Development:** built with Claude Code (AI-assisted coding, scaffolding, debugging and docs). The code was reviewed and tested by the author.
- **Sample mode:** recorded Zetaris results or the local mirror, and the deterministic playbook. No model calls, no network.

## Data and licences

- **SEC EDGAR:** company XBRL facts, fetched live by Zetaris from data.sec.gov with a declared User-Agent, within SEC's fair-access rules. A small snapshot (8 companies × 4 concepts, filings from 2023 on) is kept for the offline mirror only.
- **Halden Packaging:** fictional, with a simulated ledger generated by `scripts/gen-ledger.ts` (seeded and reproducible). No personal data.
- **Third-party:** Hono (MIT) · @hono/node-server (MIT) · DuckDB node API (MIT) · React (MIT) · Vite (MIT) · Meterless engines (Apache-2.0) · Schibsted Grotesk, Geist, Geist Mono (SIL OFL).

## Limitations (honest)

- The seller's ledger is simulated, and the two weekly snapshots are scripted to show a realistic aftermath of the week-1 decisions.
- SEC data is quarterly and lags; the desk uses only filings made on or before its desk date.
- The policy thresholds are illustrative; a real desk would calibrate them to its own loss history.
- Model proposals vary run to run. The policy engine keeps the *executed* decisions within policy, and the Risk Officer's objections and overrules are in the trace.

## Pre-existing components (declared)

- Meterless engine reference implementations (`engines/`), unchanged, Apache-2.0.
- Plumbing patterns (the Zetaris REST adapter, the Nightshift provider, the trace and the budget meter) are adapted from the author's Causa entry built in this same hackathon window.
