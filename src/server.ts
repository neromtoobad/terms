// HTTP entry point.
//   POST /run                      run one job and return the JSON result (judges' programmatic path)
//   POST /api/jobs                 start a job in the background, returns { run_id }
//   GET  /api/jobs/:id             job status / result
//   GET  /api/jobs/:id/events      live trace (server-sent events) for the desk UI
//   GET  /api/desk                 the desk's system of record: week, limits, orders, approvals, notices
//   POST /api/approvals/:id        the credit manager approves or rejects { decision, note }
//   POST /api/desk/advance         move to the next weekly snapshot and review last week's outcomes
//   POST /api/desk/reset           demo reset: week 1, no decisions, empty memory
//   GET  /api/memory               what the desk remembers (H-MEM)
//   GET  /api/policy               the credit policy and sector notes
//   GET  /api/health               provider + data status
//   GET  /sources/:name.json       Halden's systems, as Zetaris fetches them
//   GET  /                         the desk UI (web/dist)

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { deskMemory, wipeArchives } from "./agents/archivist.ts";
import { asOf, desk, resetDesk } from "./desk.ts";
import { policyBook } from "./knowledge.ts";
import { AGENTS, advanceWeek, decideApproval, runJob, type RunInput, type RunOutput } from "./run.ts";
import { HALDEN_SOURCES, WEEKS } from "./sources.ts";
import type { Trace, TraceEvent } from "./trace.ts";

const app = new Hono();

interface Job {
  id: string;
  question: string;
  status: "running" | "done";
  startedAt: string;
  events: TraceEvent[];
  result?: RunOutput;
  listeners: Set<(e: TraceEvent | { type: "done"; result: RunOutput }) => void>;
}
const jobs = new Map<string, Job>();
let busy = false; // one job at a time: the desk is a single system of record

// Finished jobs are kept on disk so the desk survives a restart.
const jobDir = () => join(config.dataDir, "jobs");
function persist(job: Job): void {
  mkdirSync(jobDir(), { recursive: true });
  const { listeners: _l, ...rest } = job;
  writeFileSync(join(jobDir(), `${job.id}.json`), JSON.stringify(rest));
}
if (existsSync(jobDir())) {
  for (const f of readdirSync(jobDir()).sort().slice(-20)) {
    const j = JSON.parse(readFileSync(join(jobDir(), f), "utf8")) as Omit<Job, "listeners">;
    jobs.set(j.id, { ...j, listeners: new Set() });
  }
}

function parseInput(body: unknown): RunInput | null {
  const b = body as Partial<RunInput> & { query?: string };
  const query = b?.input?.query ?? b?.query;
  if (typeof query !== "string" || !query.trim()) return null;
  return { run_id: b.run_id, input: { query: query.slice(0, 1000) }, options: b.options };
}

function startJob(req: RunInput): Job {
  const id = req.run_id ?? `run-${Date.now().toString(36)}`; // sortable: restored in order
  req.run_id = id;
  const job: Job = { id, question: req.input.query, status: "running", startedAt: new Date().toISOString(), events: [], listeners: new Set() };
  jobs.set(id, job);
  busy = true;
  runJob(req, {
    onTrace: (t: Trace) =>
      t.subscribe((e) => {
        job.events.push(e);
        for (const l of job.listeners) l(e);
      }),
  }).then((result) => {
    job.status = "done";
    job.result = result;
    busy = false;
    persist(job);
    for (const l of job.listeners) l({ type: "done", result });
  });
  return job;
}

app.post("/run", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ status: "error", error: { type: "BadRequest", message: 'expected {"input":{"query":"..."}}', recoverable: true } }, 400);
  const res = await runJob(req);
  return c.json(res, res.status === "error" ? 500 : 200);
});

app.post("/api/jobs", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ error: 'expected {"query":"..."}' }, 400);
  if (busy) return c.json({ error: "the desk is already working on a job" }, 409);
  return c.json({ run_id: startJob(req).id });
});

app.get("/api/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({ id: job.id, question: job.question, status: job.status, startedAt: job.startedAt, events: job.events, result: job.result });
});

app.get("/api/jobs/:id/events", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    for (const e of job.events) await stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
    if (job.status === "done") {
      await stream.writeSSE({ event: "done", data: JSON.stringify(job.result) });
      return;
    }
    await new Promise<void>((resolve) => {
      const l = (e: TraceEvent | { type: "done"; result: RunOutput }) => {
        if ("type" in e && e.type === "done") {
          stream.writeSSE({ event: "done", data: JSON.stringify(e.result) }).finally(() => {
            job.listeners.delete(l);
            resolve();
          });
        } else stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
      };
      job.listeners.add(l);
      stream.onAbort(() => {
        job.listeners.delete(l);
        resolve();
      });
    });
  });
});

app.get("/api/jobs", (c) =>
  c.json([...jobs.values()].reverse().slice(0, 20).map((j) => ({ id: j.id, question: j.question, status: j.status, startedAt: j.startedAt, summary: j.result?.output.summary })))
);

app.get("/api/desk", (c) => {
  const s = desk();
  const last = [...jobs.values()].reverse().find((j) => j.result?.output.decisions.length);
  return c.json({ ...s, asOf: asOf(), weeks: WEEKS, busy, lastRun: last ? { id: last.id, question: last.question } : null });
});

app.post("/api/approvals/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: string; by?: string };
  if (body.decision !== "approve" && body.decision !== "reject") return c.json({ error: 'expected {"decision":"approve"|"reject"}' }, 400);
  const r = decideApproval(c.req.param("id"), body.decision, body.by?.slice(0, 60) || "Credit manager", (body.note ?? "").slice(0, 300));
  return c.json(r, r.ok ? 200 : 400);
});

app.post("/api/desk/advance", (c) => {
  if (busy) return c.json({ error: "the desk is already working on a job" }, 409);
  const before = desk().week;
  const w = advanceWeek();
  if (w.week === before) return c.json({ ...w, run_id: null, message: "already at the latest snapshot" });
  const job = startJob({ input: { query: "How did last week's decisions turn out?" } });
  return c.json({ ...w, run_id: job.id });
});

app.post("/api/desk/reset", (c) => {
  if (busy) return c.json({ error: "the desk is already working on a job" }, 409);
  wipeArchives();
  resetDesk();
  jobs.clear();
  rmSync(jobDir(), { recursive: true, force: true });
  return c.json({ ok: true, week: 1, asOf: asOf() });
});

app.get("/api/memory", (c) => {
  const all = deskMemory().store.all();
  return c.json(all.slice(-60).reverse().map((m) => ({ id: m.id, content: m.content, tags: m.tags, confidence: m.confidence, refs: m.provenance?.refs ?? [], at: new Date(m.timestamp).toISOString() })));
});

app.get("/api/policy", (c) => c.json(policyBook()));

app.get("/api/health", async (c) => {
  const provider = new MeterlessProvider();
  const [p, z] = await Promise.all([config.sampleMode ? Promise.resolve({ status: "offline", models: [] as string[], detail: "SAMPLE_MODE" }) : provider.status(), new ZetarisClient().ping()]);
  return c.json({
    sample_mode: config.sampleMode,
    provider: { name: "Meterless Nightshift", base_url: provider.baseUrl, status: p.status, fast: config.meterless.fastModel, deep: config.meterless.deepModel, serves_lanes: p.models.includes(config.meterless.deepModel) },
    zetaris: { mode: new ZetarisClient().mode, ok: z.ok, detail: z.detail },
    agents: AGENTS,
  });
});

app.get("/sources/:file", (c) => {
  const name = c.req.param("file").replace(/\.json$/, "");
  if (!HALDEN_SOURCES.some((s) => s.name === name)) return c.json({ error: "unknown system" }, 404);
  return c.body(readFileSync(`data/sources/${name}.json`, "utf8"), 200, { "content-type": "application/json" });
});

app.get("/api/examples", (c) => {
  const dir = "input_examples";
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  return c.json([...new Set(files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).input.query as string))]);
});

if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[INFO] Terms listening on http://${config.host}:${info.port} (sample_mode=${config.sampleMode})`);
});
