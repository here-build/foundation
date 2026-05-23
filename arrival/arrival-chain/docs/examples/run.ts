/**
 * Generic arrival-chain pipeline runner.
 *
 *   pnpm tsx scripts/arrival-chain/run.ts --config path/to/config.json
 *
 * Config shape:
 *   {
 *     "files": {                 // project-relative path → source path on disk
 *       "_lib.scm":         "docs/arrival-chain-samples/_lib.scm",
 *       "personas.json":    ".data/personas.json",
 *       "main.scm":         "my-pipeline.scm"
 *     },
 *     "entry": "main.scm",
 *     "env":   { "product-context": "..." },
 *     "models": {
 *       "fast":   "openai:gpt-4o-mini",
 *       "strong": "anthropic:claude-sonnet-4-6",
 *       "high":   "anthropic:claude-opus-4-7"
 *     },
 *     "output": "out/result.json"  // optional; defaults to stdout
 *   }
 *
 * Each `models` entry's provider must match a backend the runner knows
 * how to instantiate. Today: "openai", "anthropic", "providers" (the
 * tier-dispatching @host/providers backend, in which case modelName
 * IS the tier name and gets passed through).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  runPipeline,
  type ModelBackend,
} from "@here.build/arrival-chain";
import { anthropicBackend } from "@here.build/arrival-chain/backends/anthropic";
import { openaiBackend } from "@here.build/arrival-chain/backends/openai";
import { tieredProvidersBackend } from "@here.build/arrival-chain/backends/providers";

interface Config {
  files: Record<string, string>;
  entry: string;
  env?: Record<string, string | number | boolean>;
  models?: Record<string, string>;
  output?: string;
}

function parseArgs(argv: string[]): { config: string } {
  const out = { config: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) out.config = argv[++i];
  }
  if (!out.config) {
    console.error("usage: run.ts --config <path>");
    process.exit(2);
  }
  return out;
}

function buildBackends(models: Record<string, string>): Record<string, ModelBackend> {
  const providers = new Set<string>();
  for (const spec of Object.values(models)) providers.add(spec.split(":")[0]);

  const backends: Record<string, ModelBackend> = {};
  for (const p of providers) {
    if (p === "openai") backends[p] = openaiBackend();
    else if (p === "anthropic") backends[p] = anthropicBackend();
    else if (p === "providers") backends[p] = tieredProvidersBackend();
    else throw new Error(`unknown provider "${p}" (use openai|anthropic|providers)`);
  }
  return backends;
}

async function main(): Promise<void> {
  // Lazy-loaded so the script can be imported as a module without
  // pulling node:fs into a browser bundle.
  process.loadEnvFile?.(".env.local");

  const { config: configPath } = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(configPath, "utf-8");
  const cfg = JSON.parse(raw) as Config;

  const configDir = path.dirname(path.resolve(configPath));
  const files: Record<string, string> = {};
  for (const [projectPath, diskPath] of Object.entries(cfg.files)) {
    const resolved = path.isAbsolute(diskPath) ? diskPath : path.resolve(configDir, diskPath);
    files[projectPath] = await fs.readFile(resolved, "utf-8");
  }

  const backends = cfg.models ? buildBackends(cfg.models) : tieredProvidersBackend();

  // Optional live publishing for apps/monitor-chain. Set
  //   AC_PUBLISH=1  AC_WS_URL=ws://localhost:1235  AC_DOC_ID=my-run
  // and open monitor-chain at ?doc=my-run to watch the run live.
  const publish = process.env.AC_PUBLISH === "1"
    ? {
        wsUrl: process.env.AC_WS_URL ?? "ws://localhost:1235",
        docId: process.env.AC_DOC_ID ?? "arrival-chain",
      }
    : undefined;
  if (publish) console.error(`[run] publishing to ${publish.wsUrl} doc=${publish.docId}`);

  const t0 = Date.now();
  const result = await runPipeline({
    files,
    entry: cfg.entry,
    env: cfg.env,
    models: cfg.models,
    backends,
    publish,
  });
  const elapsedMs = Date.now() - t0;

  const serialised = JSON.stringify(result, null, 2);
  if (cfg.output) {
    const outPath = path.isAbsolute(cfg.output) ? cfg.output : path.resolve(configDir, cfg.output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, serialised, "utf-8");
    console.error(`[run] wrote ${outPath} in ${elapsedMs}ms`);
  } else {
    console.log(serialised);
    console.error(`[run] ${elapsedMs}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
