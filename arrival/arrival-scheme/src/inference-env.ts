import { wrappedOps } from "./bridge.js";
import { Environment } from "./Environment.js";
import { env as userEnv, registerCxrResolver } from "./stdlib.js";
import { nil } from "./types.js";
import { keywordAccessorResolver } from "./membrane.js";

// The inference-plane base env: the totalic environment where models author and
// evaluate Scheme. NOT a security fence — the Graal-thesis sweep deleted every
// host-reaching verb (eval / load / set-obj! / set-special! / new / instanceof)
// at the source, so they no longer EXIST to be fenced. Non-existence is a
// stronger guarantee than a per-env block list, and it removes the "two
// construction paths must agree on one block list" hazard the 2026-05-28 escape
// audit was built around. The only language-crossing door is the always-on
// polyglot membrane (`@` / `@?` / `@keys` + the interop member-access policy).
//
// `wrappedOps` is spread directly onto this base.
//
// The old `SAFE_BUILTINS` snapshot — `global_env.get(name)` for each whitelisted
// name, eagerly at module load — is GONE. It was a relic of the null-parent island:
// with no parent, the env had to COPY its builtins. This env now inherits user_env
// (below), so those builtins are reachable live via the chain — the copy was both
// redundant AND a hazard: it raced the async assembly of the value-domain clusters
// onto global_env (a load-order miss captured `undefined` for `vector`/`car`/…).
// Inheritance has no such race; and post-sweep the full env leaks nothing
// host-reaching, so the whitelist projection bought no safety either.
export const inferenceEnv = new Environment(
  "inference",
  {
    ...wrappedOps,
    nil,
    // car/cdr/filter/map/reduce — the SchemeJSArray-aware + FL-dispatching interop
    // overlay — moved to the `scheme/fl-interop` capability (env/fl-interop.ts),
    // assembled onto this env in the bootstrap chain (bridge.ts initBridge).
    // `@` / `@?` / `@keys` (polyglot member access) are no longer shadowed here —
    // the polyglot capability binds the identical `readMember`/`hasMember`/`memberKeys`
    // on user_env, reachable by inheritance. (`:key` keeps its resolver below.)
    // The loose-JS shadows that USED to live here — `symbol->string`/`string->symbol`,
    // the numeric predicates (`zero?`/`positive?`/`negative?`/`max`/`min`), and the
    // string ops (`string-length`/`string-upcase`/`string-downcase`/`string-ref`) —
    // are dropped. Each returned a RAW JS value (number/string/bool) that shadowed the
    // sound base binding: the numeric core (wrappedOps, spread above) and the string/
    // arrival-extensions packs return provenance-carrying BOXED Scheme values. The
    // base versions surface by inheritance / the spread; the loose copies only erased
    // lineage and the proper Scheme type.

    // `string-contains` stays inline: it has NO base provider (the strings cluster has
    // no `string-contains`). It is a simplified boolean `.includes`, not the R7RS
    // index-returning `string-contains` — a candidate to relocate into the strings
    // pack with proper semantics later, not a redundant shadow to drop now.
    "string-contains": (haystack: any, needle: any) =>
      (haystack?.__string__ ?? String(haystack)).includes(needle?.__string__ ?? String(needle)),

    // `equal?` is no longer shadowed here — the equality cluster binds the identical
    // `structuralEqual(a, b)` (its `seen` map defaults to `new Map()`), reachable by
    // inheritance.

    // first/last/second/third, assoc, sort, length — the array-aware (JS-array +
    // LIPS-pair) nil-tolerant accessors — moved to the `scheme/fl-interop`
    // capability (env/fl-interop.ts), assembled onto this env in the bootstrap
    // chain (bridge.ts initBridge), alongside car/cdr/filter/map/reduce.

    // `when` / `unless` are no longer shadowed here — they are real `define-macro`s
    // (with evaluator special-forms), so the macro is resolved before any frame
    // lookup. The inline procedure approximations they replaced were dead (never
    // reached) AND broken (a procedure gets pre-evaluated args, so the "conditional"
    // could not condition).
  },
  // Inherit the full env (user_env) instead of being a curated null-parent island.
  // Post-sweep the full env leaks nothing host-reaching (eval/load/new deleted, the
  // scheme namespace gone), so the allowlist projection + whitelist-copy that this
  // null parent forced are now redundant — this overlay is collapsing into a thin
  // membrane/FL layer on the one env.
  userEnv,
);

// The unbounded `c[ad]+r` catchall. SAFE_BUILTINS copies only a hand-maintained
// (and incomplete) slice of the family above; the resolver makes ANY accessor
// word the sweet lens can fuse resolve — without inheriting it (null parent).
registerCxrResolver(inferenceEnv);
// The `:key` keyword accessor catchall (sibling to c[ad]+r). On the inference-env
// base too, so a `:`-prefixed symbol resolves to its `@`-alias pluck.
inferenceEnv.registerResolver(keywordAccessorResolver);

/**
 * @deprecated Renamed to {@link inferenceEnv}. This was never a security sandbox —
 * it is the inference-plane base env. The `sandboxedEnv` spelling is kept as an
 * alias for cross-package consumers (arrival-mcp / -chain / -inference / -sampler)
 * through the migration window; it is removed once every consumer is codemodded.
 */
export const sandboxedEnv = inferenceEnv;
