// Prints Nightshift status and whether the pinned Nemotron lanes are served (no secrets printed).
import { MeterlessProvider } from "../src/adapters/meterless.ts";
import { config } from "../src/config.ts";
const p = new MeterlessProvider();
const s = await p.status();
console.log(s.status, s.detail ?? "", "deep:", config.meterless.deepModel, "fast:", config.meterless.fastModel, "has deep:", s.models.includes(config.meterless.deepModel));
