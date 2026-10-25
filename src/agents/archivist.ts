// Archivist: the desk's memory and its shared case file.
//
// - Meterless H-MEM: every executed decision is stored with provenance (the
//   Zetaris query ids behind it and the decision id), and so is how it turned
//   out a week later. Before underwriting, each account's history is recalled,
//   so the desk does not repeat a mistake it has already seen.
// - Meterless World Model: the live case file for a run. Accounts, the policy
//   conditions found, each decision and the queries that evidence it, written
//   by several agents through the single-writer queue.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HMEM } from "../../engines/hmem/src/index.ts";
import { WorldModel, type WorldEvent } from "../../engines/world-model/src/index.ts";
import { config } from "../config.ts";
import type { Decision, Memory } from "../domain.ts";
import type { PolicyView } from "../policy.ts";
import type { Trace } from "../trace.ts";

let hmemSingleton: HMEM | null = null;
let worldSingleton: WorldModel | null = null;

export function deskMemory(dir = join(config.dataDir, "hmem")): HMEM {
  if (!hmemSingleton) {
    mkdirSync(dir, { recursive: true });
    hmemSingleton = new HMEM({ persistDir: dir, actor: "terms-archivist" });
  }
  return hmemSingleton;
}

export function caseFile(dir = config.dataDir): WorldModel {
  if (!worldSingleton) {
    mkdirSync(dir, { recursive: true });
    worldSingleton = new WorldModel({ namespace: "terms", storage: "local", directory: dir, conflictPolicy: "most-recent-wins" });
  }
  return worldSingleton;
}

// Demo reset: forget everything the desk has learned (memory and case files).
export function wipeArchives(dir = config.dataDir): void {
  rmSync(join(dir, "hmem"), { recursive: true, force: true });
  rmSync(join(dir, ".world"), { recursive: true, force: true });
  hmemSingleton = null;
  worldSingleton = null;
}

export function resetArchives(): void {
  hmemSingleton = new HMEM({ actor: "terms-archivist" });
  worldSingleton = new WorldModel({ namespace: "terms", storage: "memory", conflictPolicy: "most-recent-wins" });
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export class Archivist {
  readonly hmem = deskMemory();
  readonly world = caseFile();

  constructor(private trace: Trace, private runId: string) {}

  private src(by: string) {
    return { kind: "agent", by, at: new Date(), runId: this.runId };
  }

  recall(ticker: string, name: string): Memory[] {
    // H-MEM retrieval over the whole desk memory, narrowed to this account and
    // ordered newest first: in credit, what happened last week outranks an
    // older, similar-sounding note.
    const res = this.hmem.query(`${ticker} ${name} credit decision outcome`, { topN: 60, threshold: 0 });
    const memories = res.memories
      .filter((m) => m.memory.tags?.includes(ticker))
      .sort((a, b) => b.memory.timestamp - a.memory.timestamp)
      .slice(0, 5)
      .map((m) => ({ id: m.memory.id, content: m.memory.content, relevance: +m.relevance.toFixed(3), refs: m.memory.provenance?.refs ?? [] }));
    this.trace.log({
      agent_name: "Archivist", action: "recall_memory", target_agent: "Underwriter", status: "success",
      input_summary: `H-MEM: ${ticker} decisions and outcomes`,
      output_summary: memories.length ? `${memories.length} recalled; latest: ${memories[0].content.slice(0, 140)}` : "nothing on file for this account yet",
      data: { engine: "H-MEM", ticker, memories },
    });
    return memories;
  }

  rememberDecision(d: Decision, asOf: string): string {
    const exec = d.execution?.status === "pending_approval" ? `requested approval for ${usd(d.fromLimit)} → ${usd(d.newLimit)}` : d.newLimit !== d.fromLimit ? `${d.newLimit > d.fromLimit ? "raised" : "cut"} the limit ${usd(d.fromLimit)} → ${usd(d.newLimit)}` : `kept ${usd(d.fromLimit)}`;
    const orders = d.orders.length ? `; orders ${d.orders.map((o) => `${o.order_id} ${o.action}`).join(", ")}` : "";
    const content = `DECISION ${asOf} ${d.ticker}: ${d.action}, ${exec}${orders}. Clauses ${d.clauses.join(", ")}. ${d.rationale.slice(0, 260)}`;
    const rec = this.hmem.add({
      content, type: "factual", layer: "long_term",
      tags: [d.ticker, "decision", d.action, asOf],
      confidence: d.confidence,
      source: `terms:${this.runId}`,
      provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `${d.id} in ${this.runId}`, refs: [d.id, ...d.evidence] },
      missionId: this.runId,
    });
    return rec.id;
  }

  rememberOutcome(ticker: string, content: string, verdict: "good" | "bad" | "neutral", refs: string[]): string {
    const rec = this.hmem.add({
      content, type: "factual", layer: "long_term",
      tags: [ticker, "outcome", verdict],
      confidence: 0.9,
      source: `terms:${this.runId}`,
      provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `outcome review ${this.runId}`, refs },
      missionId: this.runId,
    });
    this.trace.log({
      agent_name: "Archivist", action: "store_outcome", status: "success",
      input_summary: `${ticker} outcome (${verdict})`, output_summary: content.slice(0, 220),
      data: { engine: "H-MEM", ticker, memoryId: rec.id, verdict, refs },
    });
    return rec.id;
  }

  // World Model case file
  async openCase(request: string, asOf: string): Promise<void> {
    await this.world.upsertContext({ type: "credit_review", externalKey: { system: "terms", id: this.runId }, attrs: { request, asOf }, source: this.src("Intake") });
  }

  async putConditions(v: PolicyView, by: string): Promise<void> {
    const ctx = `credit_review:terms:${this.runId}`;
    await this.world.upsertEntity({ type: "account", externalKey: { system: "halden", id: v.ticker }, attrs: { ticker: v.ticker, watchList: v.watchList }, source: this.src(by) });
    for (const c of v.conditions.filter((x) => x.hit)) {
      await this.world.assertFact({ about: `account:halden:${v.ticker}`, predicate: `condition:${c.id}`, value: c.detail, confidence: 1, context: ctx, source: this.src(by) });
    }
  }

  async putDecision(d: Decision, by: string): Promise<void> {
    const ctx = `credit_review:terms:${this.runId}`;
    await this.world.upsertEntity({ type: "decision", externalKey: { system: this.runId, id: d.id }, attrs: { ticker: d.ticker, action: d.action, from: d.fromLimit, to: d.newLimit, clauses: d.clauses.join(",") }, source: this.src(by) });
    await this.world.relate({ from: `decision:${this.runId}:${d.id}`, type: "decides", to: `account:halden:${d.ticker}`, context: ctx, source: this.src(by) });
    for (const q of d.evidence) {
      await this.world.upsertEntity({ type: "query", externalKey: { system: "zetaris", id: q }, source: this.src(by) });
      await this.world.relate({ from: `decision:${this.runId}:${d.id}`, type: "evidenced_by", to: `query:zetaris:${q}`, context: ctx, source: this.src(by) });
    }
    if (d.execution) await this.world.assertFact({ about: `decision:${this.runId}:${d.id}`, predicate: "execution", value: d.execution.status, confidence: 1, context: ctx, source: this.src("Executor") });
  }

  events(): number {
    return this.world.events().length;
  }

  onCaseEvent(fn: (e: WorldEvent) => void): () => void {
    return this.world.subscribeEvents(fn);
  }
}
