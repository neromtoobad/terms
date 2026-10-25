// Runtime configuration. Everything sensitive comes from environment
// variables (node --env-file or the shell); nothing is hard-coded.

const env = (k: string, d = ""): string => {
  const v = (process.env[k] ?? d).trim();
  // Placeholders from .env.example count as unset.
  return /^(PASTE_|your-|change-me$)/i.test(v) ? d : v;
};
const bool = (k: string, d = false): boolean => {
  const v = env(k);
  return v ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : d;
};

export const config = {
  port: Number(env("PORT", "8010")),
  host: env("HOST", "0.0.0.0"),
  // SAMPLE_MODE: no live credentials needed. Zetaris answers come from the
  // recorded live results in data/cache or the local mirror, and the agents
  // use the desk's deterministic underwriting instead of Nemotron.
  sampleMode: bool("SAMPLE_MODE"),
  logLevel: env("LOG_LEVEL", "INFO"),
  dataDir: env("TERMS_DATA", "data/runtime"),

  meterless: {
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: env("METERLESS_APP", "terms"),
    fastModel: env("METERLESS_MODEL_FAST", env("METERLESS_MODEL", "meterless/fast")),
    deepModel: env("METERLESS_MODEL_DEEP", env("METERLESS_MODEL", "meterless/deep")),
    timeoutMs: Number(env("METERLESS_TIMEOUT_MS", "180000")),
  },

  zetaris: {
    restUrl: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
    timeoutMs: Number(env("ZETARIS_TIMEOUT_MS", "120000")),
    rowLimit: Number(env("ZETARIS_ROW_LIMIT", "500")),
    recordCache: bool("RECORD_CACHE", true),
  },

  // SEC asks every client to identify itself; Zetaris sends this header on the
  // REST tables it registers against data.sec.gov.
  secUserAgent: env("SEC_USER_AGENT", "Terms-hackathon-demo admin@nerom.site"),

  budget: {
    maxRounds: Number(env("TERMS_MAX_STEPS", "6")),
    maxQueries: Number(env("TERMS_MAX_QUERIES", "40")),
    maxModelCalls: Number(env("TERMS_MAX_MODEL_CALLS", "40")),
    maxSeconds: Number(env("TERMS_MAX_SECONDS", "600")),
  },
};

export type Config = typeof config;
