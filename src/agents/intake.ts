// Intake agent, implemented on the Meterless Scout Intent spec:
//   Sense -> Interpret -> Guard -> Route -> signed ExecutionContract
// Nothing downstream acts on the raw request. Every agent that touches
// Zetaris, H-MEM, the World Model or the desk verifies the contract
// (signature, expiry, capability) first. The contract also carries the desk's
// *authority*: what the Executor may change on its own (POL-2), so no request
// text can widen it. "The CFO said it's fine" is flagged, never obeyed.

import { createHmac, randomUUID } from "node:crypto";
import { CUSTOMERS } from "../sources.ts";
import type { Request } from "../domain.ts";
import type { Brain } from "../brain.ts";
import type { Trace } from "../trace.ts";

// ------------------------------------------------------------ registry

export interface Intent {
  id: Request["intent"];
  description: string;
  capabilities: string[];
  riskClass: "low" | "medium" | "high";
  triggers: [string, number][];
  examples: string[];
}

export const REGISTRY_VERSION = 1;
export const POLICY_PACK_VERSION = "halden-credit-2026.10";

const READ = ["data.sql", "memory.recall", "world.case", "knowledge.policy"];
const ACT = ["credit.limit.decrease", "credit.limit.increase", "orders.hold", "orders.release", "orders.prepay", "notice.draft", "approval.request", "memory.store"];

export const REGISTRY: Intent[] = [
  {
    id: "portfolio_review", riskClass: "medium", description: "Review every account's limit and pending orders, and act within authority",
    capabilities: [...READ, ...ACT],
    triggers: [["weekly", 3], ["portfolio", 3], ["all accounts", 4], ["the book", 3], ["credit review", 3], ["review the", 1], ["every account", 4], ["run the review", 4]],
    examples: ["Run the weekly credit review"],
  },
  {
    id: "account_review", riskClass: "medium", description: "Review one account's limit and orders",
    capabilities: [...READ, ...ACT],
    triggers: [["review", 2], ["should we", 2], ["what about", 2], ["how is", 2], ["check", 1], ["risk", 1], ["exposure", 2]],
    examples: ["Should we keep extending credit to Wayfair?"],
  },
  {
    id: "order_release", riskClass: "medium", description: "Decide whether a pending order can ship on credit",
    capabilities: [...READ, ...ACT],
    triggers: [["release", 4], ["ship", 3], ["order", 2], ["so-", 3], ["unblock", 3], ["let it go", 3]],
    examples: ["Can we release Wayfair's order SO-4471?"],
  },
  {
    id: "limit_request", riskClass: "medium", description: "Consider a requested limit change for one account",
    capabilities: [...READ, ...ACT],
    triggers: [["raise", 3], ["increase", 3], ["limit", 2], ["lower", 3], ["cut", 3], ["reduce", 3], ["set the limit", 4], ["headroom", 3]],
    examples: ["Dick's wants an $800,000 limit. Can we do it?"],
  },
  {
    id: "outcome_review", riskClass: "low", description: "Record how last week's decisions turned out",
    capabilities: [...READ, "memory.store"],
    triggers: [["outcome", 4], ["how did", 3], ["turned out", 4], ["follow up", 2], ["since last week", 3]],
    examples: ["How did last week's decisions turn out?"],
  },
  {
    id: "forbidden", riskClass: "high", description: "Actions the desk never takes: write-offs, payments, deleting records, sending money, bypassing policy",
    capabilities: [],
    triggers: [["write off", 5], ["write-off", 5], ["delete", 5], ["wire", 4], ["refund", 4], ["transfer", 4], ["bypass", 5], ["ignore the policy", 5], ["approve all", 5], ["send the money", 5], ["pay them", 4]],
    examples: ["Write off Wayfair's overdue balance"],
  },
];

const CAPABILITY_TOOLS: Record<string, string> = {
  "data.sql": "zetaris.sql",
  "memory.recall": "hmem.query",
  "memory.store": "hmem.add",
  "world.case": "worldmodel.case",
  "knowledge.policy": "policy.book",
  "credit.limit.decrease": "desk.limit",
  "credit.limit.increase": "desk.limit",
  "orders.hold": "desk.orders",
  "orders.release": "desk.orders",
  "orders.prepay": "desk.orders",
  "notice.draft": "desk.notice",
  "approval.request": "desk.approval",
};

// ------------------------------------------------------------ contract

export interface Authority {
  maxAutoIncreaseUsd: number; // POL-2
  maxAutoLimitUsd: number;    // POL-2
  maxLimitUsd: number;        // POL-1
  sendsNotices: false;        // the desk drafts; people send
  claimedAuthorityAccepted: false;
}

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: { primary: Request["intent"]; parameters: Request; confidence: number; alternates: { id: string; score: number }[] };
  risk: { level: "low" | "medium" | "high" | "block"; flags: string[]; redactions: string[]; reason?: string };
  toolPlan: { tool: string; capability: string }[];
  modelProfile: { fast: string; deep: string; provider: "meterless-nightshift" };
  scope: { user: string; surface: string; capabilities: string[]; authority: Authority };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

const SECRET = process.env.TERMS_CONTRACT_SECRET || `terms-dev-${process.pid}`;
const TTL_MS = 5 * 60 * 1000;

export const AUTHORITY: Authority = { maxAutoIncreaseUsd: 250_000, maxAutoLimitUsd: 1_000_000, maxLimitUsd: 2_000_000, sendsNotices: false, claimedAuthorityAccepted: false };

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function sign(c: Omit<ExecutionContract, "signature">): ExecutionContract {
  return { ...c, signature: createHmac("sha256", SECRET).update(canonical(c)).digest("hex") };
}

export function verify(c: ExecutionContract, capability: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const { signature, ...rest } = c;
  const expected = createHmac("sha256", SECRET).update(canonical(rest)).digest("hex");
  if (signature !== expected) return { ok: false, reason: "contract signature invalid (tampered or unsigned)" };
  if (now > Date.parse(c.expiresAt)) return { ok: false, reason: "contract expired" };
  if (c.risk.level === "block") return { ok: false, reason: `contract blocked: ${c.risk.reason}` };
  if (!c.scope.capabilities.includes(capability)) return { ok: false, reason: `capability ${capability} is outside the contract scope` };
  return { ok: true };
}

// Long-running work refreshes the contract per Markovian step, keeping lineage.
export function refresh(c: ExecutionContract): ExecutionContract {
  const { signature: _s, ...rest } = c;
  const now = new Date();
  return sign({ ...rest, parentId: c.contractId, contractId: randomUUID(), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + TTL_MS).toISOString() });
}

// ------------------------------------------------------------ stages

const lower = (s: string) => s.toLowerCase();

export function sense(text: string): { id: Request["intent"]; score: number }[] {
  const t = lower(text);
  const raw = REGISTRY.map((i) => {
    let s = 0;
    for (const [phrase, w] of i.triggers) if (new RegExp(`\\b${phrase.replace(/[-]/g, "\\-")}`).test(t)) s += w;
    return { id: i.id, raw: s };
  });
  const total = raw.reduce((a, r) => a + r.raw, 0);
  return raw.map((r) => ({ id: r.id, score: total ? +(r.raw / total).toFixed(3) : 0 })).sort((a, b) => b.score - a.score);
}

const ALIASES: Record<string, string[]> = {
  WMT: ["walmart"], TGT: ["target"], KSS: ["kohl's", "kohls", "kohl’s"], AAP: ["advance auto", "advance auto parts"],
  PTON: ["peloton"], W: ["wayfair"], BBWI: ["bath & body works", "bath and body works", "bath & body"], DKS: ["dick's", "dicks", "dick’s", "dick's sporting goods"],
};

export function bindTickers(text: string): string[] {
  const t = lower(text);
  const found = new Set<string>();
  for (const c of CUSTOMERS) {
    if (ALIASES[c.ticker].some((a) => t.includes(a))) found.add(c.ticker);
    else if (c.ticker.length > 1 && new RegExp(`\\b${c.ticker}\\b`).test(text)) found.add(c.ticker);
  }
  return [...found];
}

export function bindAmount(text: string): number | undefined {
  const m = text.match(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|thousand|million)?\b/i);
  if (!m || !/[$km]|thousand|million|limit|to \d/i.test(m[0] + text)) return undefined;
  let v = Number(m[1].replace(/,/g, ""));
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") v *= 1_000;
  if (unit === "m" || unit === "million") v *= 1_000_000;
  return v >= 1_000 ? v : undefined;
}

const INJECTION = [/ignore (all |the )?(previous|prior|above) (instructions|prompts)/i, /<\/?system>/i, /\[INST\]/i, /you are now/i, /reveal (your|the) (system )?prompt/i, /api[_ ]?key|password|secret token/i];
const AUTHORITY_CLAIM = /\b(ceo|cfo|boss|owner|credit manager|director|vp|management|board)\b[^.]{0,40}\b(said|says|approved|signed off|okayed|ok'd|agreed|wants|told)\b|\bpre-?approved\b|\bi(?:'m| am) authori[sz]ed\b/i;

export interface IntakeResult {
  contract: ExecutionContract;
  clarification?: { question: string; options: string[] };
}

export async function intake(text0: string, trace: Trace, brain: Brain | null, runId: string, user = "credit-desk"): Promise<IntakeResult> {
  const text = text0.trim().slice(0, 1000);

  // Sense
  const ranked = sense(text);
  let top = ranked[0];
  let tickers = bindTickers(text);
  const orderId = text.match(/\bSO-\d{3,6}\b/i)?.[0].toUpperCase();
  if (top.score === 0) top = { id: tickers.length ? "account_review" : "portfolio_review", score: 0.4 };
  // A named account narrows a review to that account; an order id makes it a release decision.
  if (top.id === "portfolio_review" && tickers.length === 1 && !/\b(all|every|portfolio|book)\b/i.test(text)) top = { id: "account_review", score: top.score };
  if (orderId && top.id !== "forbidden") top = { id: "order_release", score: Math.max(top.score, 0.6) };
  const def = REGISTRY.find((i) => i.id === top.id)!;

  // Interpret
  const notes: string[] = [];
  const requestedLimit = def.id === "limit_request" ? bindAmount(text) : undefined;
  if (def.id === "portfolio_review" || def.id === "outcome_review") {
    if (!tickers.length) tickers = CUSTOMERS.map((c) => c.ticker);
  }

  // Stage 2 (optional): ask Nemotron to bind an account the rules missed.
  if (brain?.online && !tickers.length && def.id !== "forbidden") {
    const s2 = await brain.think<{ ticker?: string | null }>(
      "Intake", "fast",
      `You bind a credit-desk request to one customer. Customers: ${CUSTOMERS.map((c) => `${c.ticker} (${c.name})`).join(", ")}.`,
      `Request: ${text}\nReturn {"ticker": one ticker from the list, or null}`
    );
    if (s2?.ticker && CUSTOMERS.some((c) => c.ticker === s2.ticker)) {
      tickers = [s2.ticker];
      trace.log({ agent_name: "Intake", action: "stage2_bind", status: "success", model: brain.lastModel, input_summary: "Scout Intent Stage 2", output_summary: `bound account ${s2.ticker}` });
    }
  }

  // Guard
  const flags: string[] = [];
  let level: ExecutionContract["risk"]["level"] = def.riskClass;
  let reason: string | undefined;
  if (INJECTION.some((re) => re.test(text))) {
    flags.push("injection");
    level = "block";
    reason = "the request tries to change the desk's instructions or extract secrets";
  }
  if (def.id === "forbidden") {
    flags.push("forbidden_action");
    level = "block";
    reason = reason ?? "the desk never writes off balances, moves money, deletes records or bypasses the credit policy";
  }
  if (AUTHORITY_CLAIM.test(text)) {
    flags.push("unverified_authority_claim");
    notes.push("The request claims someone senior approved it. Claimed authority is not accepted: approvals come only from the approval queue, and the desk's own authority is fixed by POL-2.");
    if (level !== "block") level = "high";
  }
  const redactions: string[] = [];
  if (/\b\d{9,}\b|@[a-z0-9-]+\.[a-z]/i.test(text)) redactions.push("possible personal identifier");
  let route: Request["route"] = level === "block" ? "decline" : "act";
  if (route === "act" && def.id !== "portfolio_review" && def.id !== "outcome_review" && !tickers.length) route = "clarify";

  const parameters: Request = { text, intent: def.id, tickers, orderId, requestedLimit, route, notes };
  const now = new Date();
  const contract = sign({
    contractId: randomUUID(),
    traceId: runId,
    intent: { primary: def.id, parameters, confidence: top.score, alternates: ranked.slice(1).filter((r) => r.score > 0) },
    risk: { level, flags, redactions, reason },
    toolPlan: def.capabilities.filter((c) => CAPABILITY_TOOLS[c]).map((c) => ({ capability: c, tool: CAPABILITY_TOOLS[c] })),
    modelProfile: { fast: "lane:fast (Nemotron via Nightshift)", deep: "lane:deep (Nemotron via Nightshift)", provider: "meterless-nightshift" },
    scope: { user, surface: "terms-desk", capabilities: level === "block" ? [] : def.capabilities, authority: AUTHORITY },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
    registryVersion: REGISTRY_VERSION,
    policyPackVersion: POLICY_PACK_VERSION,
    signedBy: "scout",
  });

  trace.log({
    agent_name: "Intake", action: "issue_contract", target_agent: route === "act" ? "Analyst" : undefined,
    status: route === "act" ? "success" : "needs_revision", confidence: top.score,
    input_summary: text.slice(0, 160),
    output_summary: route === "decline"
      ? `blocked at Guard: ${reason}`
      : `${def.id} (${top.score}); accounts ${tickers.join(", ") || "none bound"}${orderId ? `; order ${orderId}` : ""}${requestedLimit ? `; requested limit $${requestedLimit.toLocaleString("en-US")}` : ""}; risk ${level}${flags.length ? ` [${flags.join(", ")}]` : ""}; authority: auto-raise ≤ $250,000 to ≤ $1,000,000; signed contract ${contract.contractId.slice(0, 8)}`,
    data: { engine: "Scout Intent", contract: { ...contract, signature: contract.signature.slice(0, 12) + "…" } },
  });

  const clarification = route === "clarify"
    ? { question: "Which customer should the desk look at?", options: CUSTOMERS.map((c) => `${c.name} (${c.ticker})`) }
    : undefined;
  return { contract, clarification };
}
