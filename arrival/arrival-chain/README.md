# `@here.build/arrival-chain`

A distributed, content-addressed, write-once inference substrate built on Plexus + arrival-scheme.

## What it is, in one paragraph

Programs are written in arrival-scheme; `(infer …)` and `(infer/chat …)` calls resolve through a content-keyed `InferStore` — a single-flight cache where the first request for a content tuple `[model, prompt, schema, cacheKey]` opens a cell and every later request for the same tuple awaits it. The store is runtime-bound (`project.bindInfer(store)`), not part of the synced model: a run is a pure function of the project's files, so each host resolves inference inline through its own store while sharing a disk/HTTP cache as configured. The Plexus `Project` doc holds only the versioned source files; cross-doc sync of that doc is automatic via Plexus's CRDT semantics. Replay is content-keyed: same inputs ⇒ same cache hits, deterministically.

## API surface

```ts
// Doc root (from "@here.build/arrival-chain")
class Project extends PlexusModel<null> {
  @syncing.child.map files: Map<string, Program>;   // versioned source files (path → Program)

  // Inference plane — runtime, not synced. Bind a content-keyed InferStore
  // before running programs; programs call `(infer "model-id" …)` and the
  // store routes by literal model id (no provider/tier table on the model).
  bindInfer(store): void;
  get infer(): InferStore;

  // Files + run
  addFile(path, source?): Program;
  addProgram(path, source?): Program;          // back-compat alias for addFile
  run(source, opts?): Promise<unknown>;        // exec a program against this project
}

// The Plexus instance that owns a Project root
class ArrivalChain extends Plexus<Project> {}

// Top-to-bottom entry point (from "@here.build/arrival-chain/runner", Node-only)
function runPipeline(opts): Promise<unknown>;
//   { files, entry, router, signal?, budgetMs?, publish? }
//   router: a ModelRouter (StaticRouter | singletonRouter | LayeredRouter)
//   per-run config is config-as-code: a `config.scm` in `files`
```

Backend authoring helpers (`lazyBackend`, `parseChatPrompt`, `renderSchema`,
`specMessages`) live in `@here.build/arrival-inference`, alongside the provider
backends and the model router.

### Backends

Provider backends (`openaiBackend`, `anthropicBackend`, `openrouterBackend`,
`ollamaBackend`, `vercelBackend`), the model spec/router, the infer store, and the
chat-protocol kernel live in `@here.build/arrival-inference`. Import them directly:

```ts
import { Project } from "@here.build/arrival-chain";
import { runPipeline } from "@here.build/arrival-chain/runner";
import {
  openaiBackend,
  anthropicBackend,
  StaticRouter,
} from "@here.build/arrival-inference";

// `runPipeline` takes a `ModelRouter` (model-id → backend lookup).
const router = new StaticRouter({
  "gpt-4o-mini": openaiBackend({ apiKey: "…" }),
  "claude-opus-4-7": anthropicBackend({ maxTokens: 8000 }),
});
```

System prompts are userland — backends don't inject defaults. If a
program wants one, it includes `(infer/chat/system "…")` in its
message list (or wraps via a project-local helper).

## Programs are arrival-scheme

Built-in preamble exposes:

```scheme
;; Inference
(infer tier prompt)                        ; basic; #f sentinels for schema/cache-key
(infer tier prompt schema)
(infer tier prompt schema cache-key)
(infer/chat tier messages schema cache-key)

;; Chat constructors
(infer/chat/system    "…")
(infer/chat/user      "…")
(infer/chat/assistant "…")

;; Schema DSL — tagged-list, renders to JSON Schema
(s/object (s/field/string  "name" "optional description")
          (s/field/integer "age")
          (s/field/array   "pains" (s/array "string"))
          (s/field/enum    "bucket" (s/enum "A" "B" "C" "D")))

;; Config-as-code — per-run knobs live in a config.scm the entry requires
(require "config.scm")                     ; spills (define config/<name> …) forms
config/replays                             ; IS the value; an ordinary binding

;; Cross-file imports (runtime require)
(require "_lib.scm")                       ; .scm → defines spill into the run env
(require "data.json")                      ; .json → parsed, bound as `data`
(require "data.yaml")                      ; .yaml / .yml → parsed (same value shape)
(require "data.toml")                      ; .toml → parsed
(require "data.ndjson")                    ; .ndjson → array of parsed lines
(require "prompt.txt")                     ; .txt → raw string, bound as `prompt`
```

Structured-data requires (`.json`, `.yaml`, `.yml`, `.toml`, `.ndjson`) are
**value-kind**: the file is parsed and bound to a single name (the basename),
not spilled like a `.scm`. All four object formats normalize to the same JSON
value shape, so YAML/TOML are just more ergonomic ways to author the same data a
`.json` would carry — pick by what's pleasant to hand-edit.

Every `infer` returns a list. Scalar response → `["text"]`. Structured array → the array. Use `(car (infer …))` for scalars, `(map … (infer …))` for arrays.

## How to run

Package scripts (from `foundations/arrival/arrival-chain`):

```sh
pnpm test          # vitest run — the behaviour suite in src/__tests__/
pnpm test:watch    # vitest in watch mode
pnpm research      # vitest run --config vitest.research.config.ts (src/__research__/)
pnpm custdev       # vitest run --config vitest.custdev.config.ts (LLM-as-user loops)
pnpm benchmarks    # vitest run --config vitest.benchmarks.config.ts
pnpm build         # tsc
pnpm typecheck     # tsc -p tsconfig.test.json --noEmit
```

There is no CLI binary. A pipeline is run programmatically through the
`runPipeline` entry on the Node-only `/runner` subpath:

```ts
import { runPipeline } from "@here.build/arrival-chain/runner";
import { openaiBackend, anthropicBackend, StaticRouter } from "@here.build/arrival-inference";

const result = await runPipeline({
  files: {
    "config.scm": `(define config/name "world")`,
    "main.scm": `(require "config.scm") (greet config/name)`,
  },
  entry: "main.scm",
  router: new StaticRouter({
    "gpt-4o-mini": openaiBackend({ apiKey: process.env.OPENAI_API_KEY }),
    "claude-opus-4-7": anthropicBackend({ maxTokens: 8000 }),
  }),
  // optional: publish the Project (code-storage) doc over a y-websocket relay.
  // publish: { wsUrl: "ws://localhost:1235", projectDocId: "my-run" },
});
```

`runPipeline` bootstraps a fresh in-process `Project`, binds a content-keyed
`InferStore` over the router, populates it from `files`, runs the `entry`
program, and returns its last expression. `router` is a `ModelRouter`
(model-id → backend lookup) — build one with `StaticRouter`,
`singletonRouter`, or `LayeredRouter` from `@here.build/arrival-inference`.

Per-run config is config-as-code: ship a `config.scm` in `files` holding
`(define config/<name> …)` forms and `(require "config.scm")` it from the
entry. There is no separate `env` block.

## Patterns

The pattern catalogue lives as runnable tests in `src/__tests__/` — accumulating folds where each step embeds priors (`audience-loop.test.ts`), convergence loops with data-dependent depth, map-with-feedback (`map-with-feedback.test.ts`), persona generation (`generate-personas.test.ts`), and the standard linear/parallel pipelines (`herebuild-multi.test.ts`, `herebuild-react.test.ts`).

The two patterns that are most uniquely served by this substrate:

1. **Accumulating fold.** "Each new persona must stand apart from every prior one." Can't be expressed in a fixed-shape DAG. In scheme it's `(let loop ((r seeds) (acc '())) …)`. The substrate's cache makes the whole chain replay-stable because each step's prompt deterministically embeds the priors that produced the cached results at earlier steps.

2. **Convergence loop.** "Refine until predicate, bounded by N." Chain depth is data-dependent. Bounded recursion in scheme; each step's prompt embeds the prior step's value + the critique that explained why it failed.

## Properties the substrate has, by construction

- **Cache identity = content.** Same `[model, prompt, schema, cacheKey]` tuple ⇒ same task ⇒ same result on replay.
- **Cache key uses the concrete model id** (`spec.model`, see `infer-store.ts` in `@here.build/arrival-inference`) — not a tier. Repointing a role to a different model is a cache miss by design: a different model is a different task. Tier/role names are authoring sugar that resolve to a concrete id before caching.
- **Distributed for free.** Single-process and multi-process exercise the same code path. `runPipeline({ publish })` syncs the Project (code-storage) doc over a y-websocket relay (`wsUrl`); the inference plane is host-local (a single-flight `InferStore`), so each host resolves `(infer …)` through its own store while sharing a disk/HTTP cache as configured.
- **Cross-doc reactivity.** Any MobX consumer that observes the same published `Project` doc sees mutations stream live without protocol code.
- **Stateless from scheme.** No scheme-side writes — config is read-only `config/<name>` bindings spilled by `(require "config.scm")`; all writes happen in JS-side workers. Execution is a pure function of the project's files, which is what makes replay sound.

## Substrate notes

See `src/__research__/substrate-notes.test.ts` for documented working shapes around arrival-scheme's promise-handling. The seam to be aware of: `let`-bound infer results that are passed AS A VALUE (not consumed by a force-able op first) can reach the next rosetta call as un-forced Promises. Threading values through `string-append`, `map`'s per-iteration boundary, or a top-level fn forces correctly.
