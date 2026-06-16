# @here.build/arrival-scheme-env-infer

An [arrival-scheme](../arrival-scheme/README.md) palette pack: the inference verbs (`infer` / `infer/chat`) plus the dependent MCP-agentic capability, built on [@here.build/arrival-inference](../arrival-inference/README.md).

It lives as a separate package so the inference dependency stays out of arrival-scheme's core — the edge runs `chain → here`, never back.

## Install

```bash
pnpm add @here.build/arrival-scheme-env-infer
```

## Usage

Root the capabilities into a scheme env to make the verbs available to programs:

```ts
import {
  arrivalInferCapability,
  arrivalMcpCapability,
  arrivalAgenticCapability,
} from "@here.build/arrival-scheme-env-infer";
```

- `arrivalInferCapability` — the `infer` / `infer/chat` verbs.
- `arrivalDeriveCapability` — derive-entity middleware.
- `arrivalMcpCapability` + `arrivalAgenticCapability` — MCP dispatch and the agentic tool-loop (depend on the infer capability).
- `runAgenticInfer` plus seal/membrane helpers (`asLlmModel`, `canonicalizeMessages`, `InferFn`, `McpEffectResolver`, …).

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
