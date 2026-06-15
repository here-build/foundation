// @here.build/arrival-scheme-env-ramda — Ramda as an OPT-IN palette pack.
//
// Ramda was evicted from the base sandbox (it's an external dep the interpreter shouldn't carry);
// this package is where a host that wants it opts back in. So the cut here is "what can re-enter
// cleanly": the accessor moat + collection/logic/string ops that are pure `R.*` with no
// arrival-scheme-internal coupling. The polymorphic `map`/`filter`/`reduce` are NOT here — the
// sandbox now ships its OWN hardened versions (they need LIPS `Pair`/`Nil` internals), and a second
// set would shadow them.
//
// The design choice worth seeing: each verb is offered under EVERY name a user might reach for — a
// vocabulary, not an API. `prop`/`get`/`access`/`fetch` all resolve to `R.prop` so the program reads
// in whatever mental model its author thinks in; the aliases below are intentional, not redundant.

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import * as R from "ramda";

const RAMDA: Record<string, (...args: never[]) => unknown> = {
  // (Section dividers below group by what the user is trying to DO; the multiple names per row are
  // the deliberate aliasing — same R fn, different vocabulary.)
  // property access
  prop: R.prop,
  get: R.prop,
  access: R.prop,
  fetch: R.prop,
  // path navigation
  path: R.path,
  "get-in": R.path,
  navigate: R.path,
  dig: R.path,
  // safe / defaulted access
  "prop-or": R.propOr,
  "path-or": R.pathOr,
  "safe-prop": (key: string, obj: unknown) => R.prop(key as never, (obj ?? {}) as never),
  "safe-path": (path: readonly (string | number)[], obj: unknown) => R.path(path as never, (obj ?? {}) as never),
  // existence
  has: R.has,
  contains: R.has,
  "exists?": R.has,
  "present?": R.has,
  "has-path": R.hasPath,
  // multi-read + sub-record
  props: R.props,
  paths: R.paths,
  pick: R.pick,
  omit: R.omit,
  keys: R.keys,
  values: R.values,
  toPairs: R.toPairs,
  fromPairs: R.fromPairs,
  // collection
  "group-by": R.groupBy,
  classify: R.groupBy,
  "count-by": R.countBy,
  tally: R.countBy,
  "sort-by": R.sortBy,
  "order-by": R.sortBy,
  "sort-with": R.sortWith,
  "reduce-by": R.reduceBy,
  "reduce-right": R.reduceRight,
  // logic
  is: R.is,
  "is-nil": R.isNil,
  "is-empty": R.isEmpty,
  "default-to": R.defaultTo,
  "if-else": R.ifElse,
  // string
  split: R.split,
  match: R.match,
  test: R.test,
  replace: R.replace,
  "to-lower": R.toLower,
  "to-upper": R.toUpper,
};

/** The wired verb names — so a test can assert the surface without re-listing it. */
export const ramdaVerbs: readonly string[] = Object.keys(RAMDA);

// Symbols-only, no config/resource/deps: rooting this capability is the whole opt-in. A scope that
// doesn't want Ramda simply doesn't list it, and (sideEffects:false) tree-shakes the dep away.
export default new EnvCapability("scheme/ramda", {
  symbols: RAMDA,
});
