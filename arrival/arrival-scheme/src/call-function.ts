// ----------------------------------------------------------------------
// Function application chokepoint — extracted from lips.ts (keystone K1a).
//
// `call_function` applies a Scheme function value (a native builtin OR a
// generator-lambda) with a fresh call frame. Crucially it does NOT touch the
// legacy evaluator: a generator-lambda, when applied here via `fn.apply`,
// returns `run(evalBegin(body))` itself (evaluator.ts — the `_canBounce`
// === false branch), so the generator drives the body. This is why the HOFs
// (map/filter/fold) work through `call_function` today.
//
// `resolve_promises` collapses a tree of promises into a single promise (or
// returns the argument untouched when there are none).
//
// Both are self-contained (Environment frame + LambdaContext + value kernel),
// so the stdlib (K1b) and the reader can import the applier without importing
// lips.ts.
// ----------------------------------------------------------------------
import { is_promise } from "./guards.js";
import { LambdaContext } from "./LambdaContext.js";
import { Pair } from "./values/Pair.js";
import { __data__ } from "./values/primitives.js";
import type { SchemeValue } from "./values/types.js";
import { promise_all } from "./utils/promises.js";
import { is_pair } from "./values/value-guards.js";

type SchemeFunction = (...args: any[]) => any;

export function call_function(
  fn: SchemeFunction,
  args: SchemeValue[],
  { env, dynamic_env, use_dynamic }: SchemeValue = {},
) {
  const scope = env?.new_frame(fn, args);
  const dynamic_scope = dynamic_env?.new_frame(fn, args);
  const context = new LambdaContext({
    env: scope,
    use_dynamic,
    dynamic_env: dynamic_scope,
  });
  return resolve_promises(fn.apply(context, args));
}

// Collapse a tree that may contain Promises into a single Promise; if the tree
// holds none, return the argument untouched (the common no-await fast path).
export function resolve_promises(arg: SchemeValue): SchemeValue {
  const promises: Promise<unknown>[] = [];
  traverse(arg);
  if (promises.length > 0) {
    return resolve(arg);
  }
  return arg;

  function traverse(node) {
    if (is_promise(node)) {
      promises.push(node);
    } else if (is_pair(node)) {
      if (!node.have_cycles("car")) {
        traverse(node.car);
      }
      if (!node.have_cycles("cdr")) {
        traverse(node.cdr);
      }
    } else if (Array.isArray(node)) {
      node.forEach(traverse);
    }
  }

  async function promise(node) {
    const pair = new Pair(
      node.have_cycles("car") ? node.car : await resolve(node.car),
      node.have_cycles("cdr") ? node.cdr : await resolve(node.cdr),
    );
    if (node[__data__]) {
      pair[__data__] = true;
    }
    return pair;
  }

  function resolve(node) {
    if (Array.isArray(node)) {
      return promise_all(node.map(resolve));
    }
    if (is_pair(node) && promises.length > 0) {
      return promise(node);
    }
    return node;
  }
}
