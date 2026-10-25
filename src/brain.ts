// Model access for every agent. All calls go through Meterless Nightshift
// (the primary provider), are charged to the job budget, and are traced with the
// model that actually served them. If Nightshift is unreachable, out of
// budget, or SAMPLE_MODE is on, think() returns null and the caller uses its
// deterministic reasoning path instead; that switch is traced as a fallback.

import { config } from "./config.ts";
import { MeterlessProvider, extractJson, type ChatMessage } from "./adapters/meterless.ts";
import type { Budget } from "./agents/budget.ts";
import type { Trace } from "./trace.ts";

export type Lane = "fast" | "deep";

export class Brain {
  readonly provider: MeterlessProvider;
  private down = false;
  lastModel = "";

  constructor(private trace: Trace, private budget: Budget, provider?: MeterlessProvider) {
    this.provider = provider ?? new MeterlessProvider();
    if (config.sampleMode || !this.provider.configured) this.down = true;
  }

  get online(): boolean {
    return !this.down;
  }

  private deepFailures = 0;

  async think<T>(agent: string, lane: Lane, system: string, user: string, opts: { maxTokens?: number } = {}): Promise<T | null> {
    if (this.down) return null;
    if (!this.budget.approve("modelCalls", agent)) return null;
    // After two deep-lane timeouts, route deep work to the fast lane for the rest of the run.
    const useDeep = lane === "deep" && this.deepFailures < 2;
    const model = useDeep ? config.meterless.deepModel : config.meterless.fastModel;
    const messages: ChatMessage[] = [
      { role: "system", content: system + "\nReply with JSON only. No prose outside the JSON." },
      { role: "user", content: user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.provider.chat(messages, { model, maxTokens: opts.maxTokens ?? 1800, temperature: 0.2 });
        this.lastModel = res.model;
        this.budget.tokens += res.usage?.total_tokens ?? Math.round((system.length + user.length + res.text.length) / 4);
        try {
          return extractJson<T>(res.text);
        } catch (e) {
          // Malformed JSON: tell the model what went wrong and retry once.
          this.trace.log({
            agent_name: agent, action: "model_reply_unparseable", status: "retry", retry_count: attempt + 1, model: res.model,
            input_summary: `lane=${lane}`, output_summary: `${(e as Error).message}; asking again`,
          });
          messages.push({ role: "assistant", content: res.text.slice(0, 4000) }, { role: "user", content: "That was not valid JSON. Return only the JSON object." });
          if (!this.budget.approve("modelCalls", agent)) return null;
        }
      } catch (e) {
        const msg = (e as Error).message;
        const transient = /HTTP (502|503|504|429)|timeout|aborted|first token/i.test(msg);
        if (transient && useDeep) {
          this.deepFailures++;
          this.trace.log({
            agent_name: agent, action: "lane_timeout", status: "retry", model,
            input_summary: `deep lane via Meterless Nightshift`,
            output_summary: `${msg.slice(0, 120)}; retrying on the fast lane (${config.meterless.fastModel})`,
          });
          return this.think<T>(agent, "fast", system, user, opts);
        }
        this.down = true;
        this.trace.log({
          agent_name: agent, action: "provider_unavailable", status: "fallback", model,
          input_summary: `lane=${lane} via Meterless Nightshift`,
          output_summary: `${(e as Error).message.slice(0, 160)}; switching to deterministic reasoning for the rest of the run`,
        });
        return null;
      }
    }
    return null;
  }
}
