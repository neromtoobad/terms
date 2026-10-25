// The credit desk's system of record: the limits the desk has set on top of
// the ERP, order holds and releases, approval requests, drafted notices and
// the decision log. The Executor is the only agent that writes here, and only
// under a verified Scout Intent contract. Persisted to <dataDir>/desk.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { WEEKS } from "./sources.ts";

export type OrderState = "held" | "released" | "prepay_required" | "pending_approval";

export interface LimitChange {
  ticker: string;
  from: number;
  to: number;
  at: string;          // desk date (as_of of the week)
  decisionId: string;
  approvedBy: string;  // "desk (POL-2 authority)" or the approver
}

export interface Approval {
  id: string;
  ticker: string;
  from: number;
  to: number;
  orders: string[];    // orders that wait on this approval
  reason: string;
  clauses: string[];
  decisionId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface Notice {
  id: string;
  ticker: string;
  at: string;
  subject: string;
  body: string;
  status: "draft";     // the desk drafts; a person sends
  decisionId: string;
}

export interface LoggedDecision {
  id: string;
  runId: string;
  week: number;
  asOf: string;
  ticker: string;
  action: string;
  fromLimit: number;
  toLimit: number;
  orders: { order_id: string; action: string }[];
  clauses: string[];
  evidence: string[];
  execution: string;
}

export interface DeskState {
  week: number; // 1-based index into WEEKS
  limits: Record<string, number>;
  limitHistory: LimitChange[];
  orders: Record<string, { state: OrderState; at: string; decisionId: string }>;
  approvals: Approval[];
  notices: Notice[];
  decisions: LoggedDecision[];
}

const file = () => join(config.dataDir, "desk.json");
const fresh = (): DeskState => ({ week: 1, limits: {}, limitHistory: [], orders: {}, approvals: [], notices: [], decisions: [] });

let state: DeskState | null = null;

export function desk(): DeskState {
  if (!state) state = existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as DeskState) : fresh();
  return state;
}

export function saveDesk(): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(desk(), null, 1));
}

export function resetDesk(persist = true): DeskState {
  state = fresh();
  if (persist) saveDesk();
  return state;
}

export const asOf = (s = desk()): string => WEEKS[Math.min(s.week, WEEKS.length) - 1];

export function effectiveLimit(ticker: string, erpLimit: number): number {
  return desk().limits[ticker] ?? erpLimit;
}

export function lastIncrease(ticker: string): LimitChange | undefined {
  return [...desk().limitHistory].reverse().find((c) => c.ticker === ticker && c.to > c.from);
}

export function lastDecrease(ticker: string): LimitChange | undefined {
  return [...desk().limitHistory].reverse().find((c) => c.ticker === ticker && c.to < c.from);
}

export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
