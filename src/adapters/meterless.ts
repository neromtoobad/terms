// Meterless Runtime (Nightshift) as Terms's primary AI provider.
// Implements the Meterless Runtime 0.90.0 provider contract:
//  - base URL normalised to <host>/v1 (never /v1/v1)
//  - Authorization: Bearer <runtime token> on every call
//  - meterless-app on every request, meterless-scope: user on chat
//  - model ids are routing modes (meterless/<disposition>, meterless/<class>[.<disposition>])
//  - GET /v1/models decides status: 401/403 unauthorized, 200 online, else offline
//  - 180 s timeout, because a cold model load can take minutes
// Nightshift holds the NVIDIA key and serves Nemotron lanes; this app never
// sees provider keys.

import { config } from "../config.ts";

export type ProviderStatus = "online" | "unauthorized" | "offline";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string; // the routed model Nightshift reports, e.g. a Nemotron lane
  requested: string;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return "http://127.0.0.1:8088/v1";
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/(v1\/)?(chat\/completions|models|healthz)$/i, "");
  u = u.replace(/\/v1$/i, "");
  return `${u}/v1`;
}

export class MeterlessProvider {
  readonly baseUrl: string;
  private token: string;
  private app: string;
  private timeoutMs: number;
  modelsCache: string[] = [];

  constructor(opts: { baseUrl?: string; token?: string; app?: string; timeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? config.meterless.baseUrl);
    this.token = opts.token ?? config.meterless.token;
    this.app = (opts.app ?? config.meterless.app).toLowerCase();
    this.timeoutMs = opts.timeoutMs ?? config.meterless.timeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.token) && this.token !== "rt-local";
  }

  private headers(chat = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "meterless-app": this.app,
      "Content-Type": "application/json",
    };
    if (chat) h["meterless-scope"] = "user";
    return h;
  }

  async status(): Promise<{ status: ProviderStatus; models: string[]; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
      if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [] };
      if (res.status !== 200) return { status: "offline", models: [], detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: { id: string }[] };
      const models = (body.data ?? []).map((m) => m.id);
      this.modelsCache = models;
      if (!models.some((m) => m.startsWith("meterless/"))) return { status: "offline", models, detail: "no meterless/* routes" };
      return { status: "online", models };
    } catch (err) {
      return { status: "offline", models: [], detail: (err as Error).message };
    }
  }

  async chat(messages: ChatMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; json?: boolean } = {}): Promise<ChatResult> {
    if (!this.configured) throw new Error("Meterless Runtime token missing (METERLESS_RUNTIME_TOKEN)");
    const requested = opts.model ?? config.meterless.fastModel;
    const started = Date.now();
    // Nemotron reasoning models: keep the reasoning out of the answer so the
    // agents get clean JSON (NVIDIA's "detailed thinking off" convention).
    const nemotron = /nemotron/i.test(requested);
    const msgs = nemotron && process.env.METERLESS_THINKING !== "on"
      ? messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: `detailed thinking off. ${m.content}` } : m))
      : messages;
    const body: Record<string, unknown> = {
      model: requested,
      messages: msgs,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1600,
      stream: false,
      ...(nemotron && process.env.METERLESS_THINKING !== "on" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new Error("Meterless Runtime rejected the token (unauthorized)");
    if (!res.ok) throw new Error(`Meterless Runtime HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
      usage?: ChatResult["usage"];
    };
    const msg = data.choices?.[0]?.message;
    const text = (msg?.content ?? "").trim() || (msg?.reasoning_content ?? "").trim();
    if (!text) throw new Error("Meterless Runtime returned an empty completion");
    return { text, model: data.model ?? requested, requested, latencyMs: Date.now() - started, usage: data.usage };
  }
}

// Pull the first JSON object/array out of a model reply (models often wrap
// JSON in prose or code fences, and reasoning models prepend <think> blocks).
export function extractJson<T = unknown>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.search(/[\[{]/);
  if (start === -1) throw new Error("no JSON in model reply");
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as T;
  }
  throw new Error("unterminated JSON in model reply");
}
