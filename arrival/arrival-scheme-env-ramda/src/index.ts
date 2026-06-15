// @here.build/arrival-scheme-env-ramda — Ramda verbs as a palette pack.
//
// A JS-WIRING pack (no scheme source): its `apply` sets raw JS functions as env
// bindings, exactly how the original sandbox spreads `RAMDA_FUNCTIONS`. Scoped to
// the PURE-Ramda subset — the accessor moat + collection/logic/string ops that map
// straight to `R.*` with no arrival-scheme-internal coupling. The polymorphic
// `map`/`filter`/`reduce` (which need LIPS `Pair`/`Nil` internals) are deliberately
// OUT — the sandbox owns those. Names mirror arrival-scheme/src/ramda-functions.ts
// (originals untouched).

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import * as R from "ramda";

const RAMDA: Record<string, (...args: never[]) => unknown> = {
  // property access — multiple mental models, all R.prop
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

/** The wired verb names — for tests / introspection. */
export const ramdaVerbs: readonly string[] = Object.keys(RAMDA);

/** The Ramda verbs as a module-singleton capability (methods-only). The full
 *  RAMDA_FUNCTIONS (incl. polymorphic map/filter/reduce) is a mechanical extension
 *  once the LIPS-Pair-aware wrappers are exported from arrival-scheme. */
export default new EnvCapability("scheme/ramda", {
  symbols: RAMDA,
});
