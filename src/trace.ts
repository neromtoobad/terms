// Run trace: one JSONL line per agent action in logs/trace-<run_id>.jsonl,
// a readable line on stdout, and a live feed for the UI (SSE). The trace is
// written as the run happens; nothing here is ever composed after the fact.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export type TraceStatus = "success" | "needs_revision" | "retry" | "error" | "fallback" | "info";

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent?: string;
  confidence?: number;
  retry_count?: number;
  status: TraceStatus;
  model?: string;
  data?: Record<string, unknown>;
}

const SECRET_RE = /(nvapi-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+)/g;
export const redact = (s: string): string => s.replace(SECRET_RE, (m) => m.slice(0, 6) + "...redacted");

export class Trace {
  readonly runId: string;
  readonly file: string;
  readonly events: TraceEvent[] = [];
  private bus = new EventEmitter();

  constructor(runId: string, logDir = "logs", private quiet = false) {
    this.runId = runId;
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, `trace-${runId}.jsonl`);
  }

  log(e: Omit<TraceEvent, "timestamp" | "run_id">): TraceEvent {
    const event: TraceEvent = {
      timestamp: new Date().toISOString(),
      run_id: this.runId,
      ...e,
      input_summary: redact(e.input_summary),
      output_summary: redact(e.output_summary),
    };
    this.events.push(event);
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    if (!this.quiet) {
      const level = event.status === "error" ? "ERROR" : event.status === "fallback" || event.status === "retry" ? "WARN" : "INFO";
      const arrow = event.target_agent ? ` -> ${event.target_agent}` : "";
      console.log(`[${level}] run_id=${this.runId} ${event.agent_name}${arrow} ${event.action}: ${event.output_summary}`);
    }
    this.bus.emit("event", event);
    return event;
  }

  subscribe(fn: (e: TraceEvent) => void): () => void {
    this.bus.on("event", fn);
    return () => this.bus.off("event", fn);
  }
}
