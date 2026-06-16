# @here.build/foundations

Foundation packages powering [here.build](https://here.build).

## Packages

### `plexus/`
Reactive state management with automatic replication, layered on Yjs. TypeScript classes sync across clients via the most popular JS CRDT protocol. See `plexus/README.md`.

### `arrival/`
A stack for S-expression tool protocols and MCP-style integrations — a sandboxed Scheme interpreter, an LLM inference runtime, provenance analysis, and the orchestration that composes them.

- `arrival` — the AI-agent framework tying the stack together
- `arrival-scheme` — Scheme interpreter (fork of [LIPS.js](https://github.com/jcubic/lips))
- `arrival-sweet` — sweet-expression lens: classic↔sweet scheme-source rendering (zero-dependency leaf)
- `arrival-env` — types and protocol for S-expression serialization
- `arrival-serializer` — converts JavaScript values to Scheme/Lisp representations
- `arrival-chain` — orchestration core: project model, evaluator wiring, capability env-packs, loader, effect membrane
- `arrival-chain-view` — faithful, deterministic projection of a chain program into a target language (JS first)
- `arrival-inference` — the "talk to LLMs" layer: model router, provider backends, cost, infer cache, agentic tool-loop
- `arrival-provenance` — trace capture + analysis (forest, statechart, region tree, reverse-chain slicer)
- `arrival-mcp` — build Model Context Protocol tools as values (discovery + action tiers) on the official SDK
- `arrival-scheme-env-infer` — palette pack: inference verbs (`infer` / `infer-chat`) + the dependent mcp-agentic pack
- `arrival-scheme-env-ramda` — palette pack: Ramda accessor/collection/logic verbs wired into the env

### `common/`
Shared infrastructure.

- `collections` — `DefaultedMap`, `DefaultedWeakMap`, and MobX-reactive variants
- `error-invariant` — global `Error.invariant` assertion helper
- `lexical-namer` — lexical-scope-aware, collision-free name assignment over a scope tree
- `eslint-config` — shared ESLint configuration (`@here.build/eslint-configs`)
- `tsconfig` — shared TypeScript configuration (`@here.build/tsconfig`)

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Each package exposes its own `turbo.json`-compatible tasks; the root `turbo.json` orchestrates `build`, `test`, `typecheck`, and `lint` across the workspace.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build

## Contact

team@here.build
