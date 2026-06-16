// NATIVE_PACKS — the value-domain primitive clusters as assembled capability packs.
//
// These are the JS-implemented R7RS domains (chars / strings / lists / vectors /
// bytevectors + combinators + equality). `initBridge` ASSEMBLES them onto
// `global_env` (the native root) via `assembleEnv`. They used to reach the env by
// being spread into the `wrappedOps` monolith and applied imperatively by
// `applyToEnvironment`; now each is a live `EnvCapability` — the sole home of its
// domain's primitives. They are symbol-only (`{ value }` bindings, no prelude, no
// resources, no deps), so a pack's `apply` reduces to the very same `env.set` loop
// `applyToEnvironment` ran — the swap is behavior-identical, just sourced from the
// capability rather than its `_OPS` twin.
//
// Sibling of `BASE_PACKS` (the `.scm`-defined packs assembled onto `user_env`).
// Together they are the full pack-assembled surface. The remaining monolith is the
// numeric core + exception machinery still hand-built in `bridge.ts`'s `wrappedOps`
// (a `numbers` cluster is the next carve) and the global/user env split itself.

import type { EnvCapability } from "./capability.js";
import bytevectors from "./bytevectors.js";
import chars from "./chars.js";
import combinators from "./combinators.js";
import equality from "./equality.js";
import lists from "./lists.js";
import strings from "./strings.js";
import vectors from "./vectors.js";

export const NATIVE_PACKS: readonly EnvCapability[] = [
  chars,
  strings,
  lists,
  vectors,
  bytevectors,
  combinators,
  equality,
];
