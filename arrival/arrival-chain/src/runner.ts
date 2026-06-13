import invariant from "tiny-invariant";
import { ArrivalChain } from "./arrival-chain.js";
import { createInferStore } from "@here.build/arrival-inference";
import type { ModelRouter } from "@here.build/arrival-inference";
import { Project } from "./project.js";

export interface PublishOptions {
  /** y-websocket relay URL, e.g. `ws://localhost:1235`. */
  wsUrl: string;
  /** Doc id (room) for the Project doc on the relay. */
  projectDocId: string;
  /** @deprecated The inference cache is no longer a synced doc — it's a local
   *  single-flight `InferStore`. Accepted (and ignored) for back-compat. */
  cacheDocId?: string;
}

export interface RunPipelineOptions {
  /** Map of project-relative path → file content. */
  files: Record<string, string>;
  /** Path of the entry program (must be a key of `files`). */
  entry: string;
  /** Model-id → backend lookup (required). Construct via `StaticRouter`, `LayeredRouter`, or `singletonRouter`. */
  router: ModelRouter;
  /** Optional abort signal to stop running workers + program. */
  signal?: AbortSignal;
  /** Optional wall-clock budget (ms) for program evaluation. Composes with
   *  `signal` (first to fire wins); cut at the evaluator's TICK boundary. */
  budgetMs?: number;
  /** If set, publish the Project (code-storage) doc over y-websocket. The
   *  inference plane is host-local and never synced. */
  publish?: PublishOptions;
}

interface Disposable {
  destroy: () => void;
}

/**
 * Self-contained "run this program against this data with these
 * backends" entry point. Used by the CLI script and by tests that
 * exercise the whole substrate top-to-bottom.
 *
 * Bootstraps a fresh in-process Project, binds a content-keyed `InferStore` over
 * the supplied router, populates from `files` (config-as-code: per-run config lives
 * in a `config.scm` file the entry requires), runs the entry program, and returns
 * whatever it evaluates to as its last expression. Inference resolves inline through
 * the store's single-flight cells — no out-of-band worker to spawn or drain.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<unknown> {
  let chain;
  let publishProviders: Disposable[] = [];

  if (opts.publish) {
    // Lazy import so this module stays usable in environments without
    // a WS implementation (tests, browser). Only the Project (code-storage)
    // doc is synced; the inference plane is host-local.
    const Y = await import("yjs");
    const { WebsocketProvider } = await import("y-websocket");

    const projectDoc = new Y.Doc({ guid: opts.publish.projectDocId });
    chain = ArrivalChain.bootstrap(new Project(), opts.publish.projectDocId, projectDoc);

    publishProviders = [
      new WebsocketProvider(opts.publish.wsUrl, opts.publish.projectDocId, projectDoc) as Disposable,
    ];
  } else {
    chain = ArrivalChain.bootstrap(new Project());
  }

  const project = chain.root;
  project.bindInfer(createInferStore(opts.router));

  for (const [path, content] of Object.entries(opts.files)) {
    project.addFile(path, content);
  }

  const ownAc = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? ownAc!.signal;

  const entryFile = project.files.get(opts.entry);
  invariant(!!entryFile, () => `runPipeline: entry "${opts.entry}" is not in files`);
  try {
    return await entryFile.run({ signal, budgetMs: opts.budgetMs });
  } finally {
    if (ownAc) ownAc.abort();
    for (const provider of publishProviders) {
      try {
        provider.destroy();
      } catch {
        /* awareness cleanup quirk */
      }
    }
  }
}
