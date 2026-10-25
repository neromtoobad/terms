// Run one job from the command line and print the JSON result.
//   npx tsx --env-file=.env src/cli.ts "Run the weekly credit review"
//   npx tsx src/cli.ts input_examples/example_1.json
import { existsSync, readFileSync } from "node:fs";
import { runJob } from "./run.ts";

const arg = process.argv[2] ?? "Run the weekly credit review";
const req = existsSync(arg) ? JSON.parse(readFileSync(arg, "utf8")) : { input: { query: arg } };
const res = await runJob(req, { quiet: !process.env.VERBOSE }); // trace lines would interleave with the JSON
console.log(JSON.stringify(res, null, 2));
