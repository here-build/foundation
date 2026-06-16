# @here.build/arrival-scheme-env-ramda

An opt-in [arrival-scheme](../arrival-scheme/README.md) palette pack that wires [Ramda](https://ramdajs.com/)'s accessor, path, collection, logic, and string verbs into the env.

These verbs were evicted from the base sandbox to keep the external `ramda` dependency out of the core. This pack re-enters them — each offered under every name a user might reach for (it's a vocabulary, not a narrow API).

## Install

```bash
pnpm add @here.build/arrival-scheme-env-ramda
```

## Usage

The package default-exports an `EnvCapability('scheme/ramda')`. Root it into a scheme env to opt in:

```ts
import ramdaVerbs from "@here.build/arrival-scheme-env-ramda";
// assemble it into your env to expose prop/get/path/group-by/sort-by/… to programs
```

Omit it and — with `sideEffects: false` — `ramda` tree-shakes away entirely.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
