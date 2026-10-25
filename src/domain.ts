// Shared types for the desk.

export type Action = "KEEP" | "INCREASE" | "DECREASE" | "HOLD" | "PREPAY";
export type OrderAction = "release" | "hold" | "prepay";

// What Scout Intent binds from a request (carried inside the signed contract).
export interface Request {
  text: string;
  intent: "portfolio_review" | "account_review" | "order_release" | "limit_request" | "outcome_review" | "forbidden";
  tickers: string[];          // accounts in scope (all 8 for a portfolio review)
  orderId?: string;
  requestedLimit?: number;
  route: "act" | "decline" | "clarify";
  notes: string[];
}

// Analyst: the customer's real financials from SEC filings (via Zetaris).
export interface Fundamentals {
  ticker: string;
  entity: string;
  revenue: { frame: string; value: number; priorFrame: string; prior: number | null; yoy: number | null } | null;
  netIncome: { frame: string; value: number }[]; // last three quarters, newest first
  lossesInLast3: number;
  latestProfitable: boolean | null;
  currentRatio: { frame: string; value: number; assets: number; liabilities: number } | null;
  flags: string[];            // raw signals, before knowledge is applied
  evidence: string[];         // Zetaris query ids
}

// Collections: Halden's own ledger for the account (via Zetaris).
export interface Ledger {
  ticker: string;
  asOf: string;
  name: string;
  termsDays: number;
  erpLimit: number;
  limit: number;              // effective limit (desk decision over the ERP)
  openAr: number;
  utilization: number;
  pastDue: { invoice: string; days: number; amount: number }[];
  maxDaysPastDue: number;     // undisputed invoices only
  avgDaysLate6m: number | null;
  disputes: { invoice: string; amount: number }[];
  disputedTotal: number;
  pendingOrders: { order_id: string; amount: number; ship_by: string }[];
  notes: { date: string; category: string; note: string }[];
  evidence: string[];
}

export interface Memory {
  id: string;
  content: string;
  relevance: number;
  refs: string[];
}

export interface AccountFile {
  ticker: string;
  fundamentals: Fundamentals;
  ledger: Ledger;
  memories: Memory[];
}

export interface Proposal {
  action: Action;
  newLimit: number;
  orders: { order_id: string; action: OrderAction }[];
  rationale: string;
  clauses: string[];
  confidence: number;
  by: "model" | "playbook";
  model?: string;
}

export interface Decision extends Proposal {
  id: string;
  ticker: string;
  fromLimit: number;
  needsApproval: boolean;
  approvalReason?: string;
  riskNotes: string[];        // what the Risk Officer changed or confirmed
  disputes: number;
  dismissedFlags: { flag: string; by: string }[];
  evidence: string[];
  execution?: {
    status: "applied" | "pending_approval" | "blocked" | "no_change";
    actions: string[];
    approvalId?: string;
    noticeId?: string;
  };
}
