/**
 * The lowering walk: scheme `Node` forest → naive JS expression/statement strings.
 * Structure-preserving and total over the forms the example chains use; anything
 * outside that set throws an explicit "unsupported in read-view" error (a door,
 * not a silent miss). Faithful to the parse tree it is GIVEN — a malformed source
 * projects to malformed-but-isomorphic JS; the projection never invents structure.
 */
import { reachesAsync } from "./async-analysis.js";
import { cleanName, destructureTuple } from "./names.js";
import {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "./nodes.js";
import { type Emit, STDLIB, accessorJs } from "./stdlib.js";

export interface LowerCtx {
  /** Inline `(require "p")` (nested in an expression) → its hoisted import local. */
  requireSubst: Map<string, string>;
  /** "read" (sync, legible) or "run" (async, ax-wired). */
  target: "read" | "run";
  /** Cleaned `define` names that must be `async` (run-view). */
  asyncNames: Set<string>;
  /** Cleaned `.prompt`-require locals — the async inference primitives (run-view). */
  inferReqs: Set<string>;
  /** Scope-resolved JS name per BOUND identifier occurrence (binding and ref), from the
   *  lexical namer (#76). Absent for free refs / stdlib → fall back to `cleanName`.
   *  Both EMIT and the PARAM-scope await machinery (`inParams`) use this resolved name, so
   *  a call's await decision matches what's emitted; the GLOBAL `asyncNames`/`inferReqs`
   *  sets stay `cleanName`-keyed (async-analysis builds them on cleanNames). For a
   *  collision-free program `nameOf === cleanName`, so output is unchanged. */
  nameOf: Map<Atom, string>;
}

export interface Lowerer extends Emit {
  /** Lower a top-level form: a `define` → `const`, anything else → an expression statement. */
  lowerTop(form: Node): string;
}

export function makeLowerer(ctx: LowerCtx): Lowerer {
  // Stack of scheme→js name overrides, used to inline a unary lambda's body in
  // place (e.g., inside `max-by`). Empty in the common case; resolution then falls
  // through to the pure `cleanName`.
  const substStack: Map<string, string>[] = [];

  /** The EMITTED JS name for a bound identifier occurrence: the namer's assignment, or
   *  `cleanName` for a free ref / global / stdlib (absent from `nameOf`). */
  const emitName = (a: Atom): string => ctx.nameOf.get(a) ?? cleanName(a.atom);

  /** Resolve an identifier atom to its emitted name. An inline-lambda substitution
   *  (max-by) wins; then the scope-resolved name; then `cleanName`. */
  const resolveRef = (a: Atom): string => {
    for (let i = substStack.length - 1; i >= 0; i--) {
      const hit = substStack[i]!.get(a.atom);
      if (hit !== undefined) return hit;
    }
    return emitName(a);
  };
  /** Param-list form: the scope-resolved name (`emitName`). Both the emitted arrow AND the
   *  await machinery (`inParams`) use this same resolved name — so a call's await decision
   *  matches what's emitted. (Using `cleanName` for the await side instead would conflate a
   *  global predicate `picked?` with an in-scope param `picked`: both clean to `picked`, so
   *  the predicate call would be spuriously awaited. They agree only for collision-free names.) */
  const emitParam = (p: { atom: Atom; rest: boolean }): string =>
    p.rest ? `...${emitName(p.atom)}` : emitName(p.atom);

  const lower = (n: Node): string => (isAtom(n) ? lowerAtom(n) : isList(n) ? lowerList(n) : "undefined");

  const lowerWith = (bindings: Record<string, string>, body: Node): string => {
    substStack.push(new Map(Object.entries(bindings)));
    try {
      return lower(body);
    } finally {
      substStack.pop();
    }
  };

  // Lexical params in scope. A call to a function-valued param is conservatively
  // awaited in the run-view (it might be an async fn passed in; await on a
  // non-Promise is a no-op, so over-awaiting is safe).
  const paramStack: Set<string>[] = [];
  const inParams = (name: string): boolean => paramStack.some((s) => s.has(name));
  const withParams = (params: string[], body: () => string): string => {
    paramStack.push(new Set(params));
    try {
      return body();
    } finally {
      paramStack.pop();
    }
  };

  // Is this function node async (run-view)? An async-named fn / infer primitive, or a
  // lambda whose body reaches one.
  const isAsyncFn = (node: Node): boolean => {
    if (ctx.target !== "run") return false;
    if (isAtom(node) && !node.str) {
      const c = cleanName(node.atom);
      return ctx.asyncNames.has(c) || ctx.inferReqs.has(c);
    }
    if (isList(node) && head(node) === "lambda") return reachesAsync(node, ctx.asyncNames, ctx.inferReqs);
    return false;
  };

  const E: Emit = { lower, lowerWith, target: ctx.target, isAsyncFn };

  function lowerAtom(a: Atom): string {
    if (a.str) return JSON.stringify(decodeString(a.atom));
    if (isBool(a)) return a.atom === "#t" ? "true" : "false";
    if (isNumber(a)) return a.atom;
    // A bare `:keyword` in value position is meaningless (it's only an accessor head
    // or a kwarg marker). Checked inline: `a` is already `Atom`, so the `isKeyword`
    // guard would narrow the else-branch to `never`.
    if (!a.str && a.atom.length > 1 && a.atom.startsWith(":")) {
      throw new Error(`bare keyword in expression position: ${a.atom}`);
    }
    return resolveRef(a);
  }

  function lowerList(n: ListNode): string {
    if (isNil(n)) return "[]";
    const h = n.list[0];

    // A :keyword in HEAD position is an ACCESSOR: (:field obj) → obj.field.
    // (A :keyword in ARGUMENT position is a kwarg — handled in lowerCall.)
    if (isKeyword(h)) {
      const obj = n.list[1];
      if (!obj) throw new Error(`accessor ${h.atom} with no operand`);
      return `${recv(lower(obj))}.${keywordName(h)}`;
    }

    const hName = isAtom(h) && !h.str ? h.atom : undefined;
    if (hName !== undefined) {
      switch (hName) {
        case "quote":
          return lowerQuote(n.list[1]);
        case "lambda":
          return lowerLambda(n);
        case "if":
          return lowerIf(n);
        case "let":
        case "let*":
          return lowerLet(n);
        case "begin":
          return iife(lowerSequence(n.list.slice(1), "{", "}"));
        case "require": {
          const path = pathOf(n.list[1]);
          const local = ctx.requireSubst.get(path);
          if (local === undefined) throw new Error(`unresolved inline require: ${path}`);
          return local;
        }
        case "define":
          throw new Error("internal `define` is unsupported in read-view (run-view concern)");
        // cond / when / unless are expanded to `if` in the desugar pre-pass; `case` doors there.
      }
      const emit = STDLIB[hName];
      if (emit) return emit(n.list.slice(1), E);
      // pair-accessor catchall (car/cdr/cadr/caddr AND mixed caar/cdar/caadr/…).
      if (n.list.length === 2) {
        const acc = accessorJs(hName, lower(n.list[1]!));
        if (acc !== null) return acc;
      }
    }

    return lowerCall(h!, n.list.slice(1));
  }

  function lowerCall(fn: Node, args: Node[]): string {
    const positional: Node[] = [];
    const kwargs: [string, Node][] = [];
    let i = 0;
    while (i < args.length && !isKeyword(args[i])) positional.push(args[i++]!);
    while (i < args.length) {
      const k = args[i]!;
      if (!isKeyword(k)) throw new Error(`positional argument after keyword: ${describe(k)}`);
      const v = args[i + 1];
      if (v === undefined) throw new Error(`keyword ${k.atom} has no value`);
      kwargs.push([keywordName(k), v]);
      i += 2;
    }
    // `headName` (cleanName) keys the GLOBAL sets (`inferReqs`/`asyncNames`, built by
    // async-analysis on cleanNames); `headEmit` (scope-resolved) keys the PARAM scope so a
    // call's await decision matches what's emitted — a predicate `picked?` is `isPicked`
    // here, never confused with an in-scope param `picked` (both clean to `picked`).
    const headName = isAtom(fn) && !fn.str ? cleanName(fn.atom) : undefined;
    const headEmit = isAtom(fn) && !fn.str ? emitName(fn) : undefined;
    // Keyword → a valid JS identifier key (`:max-words` → `maxWords`), same cleaning
    // as every other identifier (a hyphen would be an invalid unquoted object key).
    const kwObj = `{ ${kwargs.map(([k, v]) => `${cleanName(k)}: ${lower(v)}`).join(", ")} }`;
    // run-view inference call: await, and take ONLY the inputs object — the content
    // cache-key the read-view keeps is the runtime's concern, not ax's.
    if (ctx.target === "run" && headName !== undefined && ctx.inferReqs.has(headName)) {
      return `await ${lower(fn)}(${kwargs.length > 0 ? kwObj : ""})`;
    }
    const argStrs = positional.map((p) => lower(p));
    if (kwargs.length > 0) argStrs.push(kwObj);
    const call = `${lower(fn)}(${argStrs.join(", ")})`;
    if (
      ctx.target === "run" &&
      headName !== undefined &&
      (ctx.asyncNames.has(headName) || (headEmit !== undefined && inParams(headEmit)))
    ) {
      return `await ${call}`;
    }
    return call;
  }

  function lowerLambda(n: ListNode): string {
    const ps = paramAtoms(n.list[1]);
    const body = withParams(ps.map(emitParam), () => lowerBody(n.list.slice(2)));
    const asyncKw = ctx.target === "run" && body.includes("await") ? "async " : "";
    const emit = ps.map(emitParam);
    // A single tuple param consumed only by index destructures: (pair) => pair[1] === 0
    // becomes ([first, second]) => second === 0.
    if (ps.length === 1) {
      const d = destructureTuple(emit[0]!, body);
      if (d) return `${asyncKw}(${d.pattern}) => ${d.body}`;
    }
    return `${asyncKw}(${emit.join(", ")}) => ${body}`;
  }

  function lowerIf(n: ListNode): string {
    const [, c, a, b] = n.list;
    const els = b === undefined ? "undefined" : lower(b);
    return `(${lower(c!)} ? ${lower(a!)} : ${els})`;
  }

  /**
   * SRFI-26 `cut` — `(cut proc arg…)` with `<>` slots is a terse lambda: one param
   * per slot, filled left-to-right (the proc position may itself be a slot). Desugar
   * to a synthetic `(lambda (slots…) (proc args…))` and lower THAT, so `apply`,
   * operators, and async detection all flow through the normal call path.
   *   (cut apply max <>)     → (it) => Math.max(...it)
   *   (cut dominates? <> c)  → (it) => dominates(it, c)
   */
  /** The arrow-BLOCK interior of a plain (non-named) let/let*: `{ const x = …; return last; }`. */
  function letBlock(n: ListNode): string {
    const bindings = n.list[1];
    const decls: string[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0])) decls.push(`const ${emitName(b.list[0])} = ${lower(b.list[1]!)};`);
      }
    }
    return lowerSequence(n.list.slice(2), `{ ${decls.join(" ")}`, "}");
  }

  /** A let binding would collide with a param in scope → keep the IIFE's fresh scope
   *  (unwrapping into the arrow block would be a `const`-redeclares-param error). */
  function letShadowsParam(n: ListNode): boolean {
    const bindings = n.list[1];
    return (
      isList(bindings) && bindings.list.some((b) => isList(b) && isAtom(b.list[0]) && inParams(emitName(b.list[0])))
    );
  }

  /** Wrap a `{ … }` block as an immediately-invoked arrow for EXPRESSION position. When the
   *  block awaits (run-view), the arrow is async AND the call is awaited inline — legal
   *  because any function reaching this point is itself async (it transitively calls infer),
   *  so the value flows correctly in ANY context. A bare `(async () => …)()` would instead
   *  leak a Promise into `1 + …`, `f(…)`, a ternary arm, etc. — the run-view footgun. */
  const iife = (block: string): string =>
    ctx.target === "run" && block.includes("await") ? `(await (async () => ${block})())` : `(() => ${block})()`;

  function lowerLet(n: ListNode): string {
    if (isAtom(n.list[1])) return lowerNamedLet(n);
    return iife(letBlock(n));
  }

  /**
   * The arrow-BLOCK interior of a named `let`: `{ const loop = (…) => body; return loop(inits); }`.
   * Shared by {@link lowerNamedLet} (wraps it in an IIFE for expression position) and the
   * body-unwrap in {@link lowerBody} (where the enclosing arrow already IS the wrapper, so
   * the IIFE is pure ceremony). The init values are lowered in the OUTER scope, the body in
   * the loop's. Run-view: if the body reaches an inference call it goes async, and a second
   * pass re-lowers with the loop name in scope so its recursive calls await.
   */
  function namedLetBlock(n: ListNode): { block: string; isAsync: boolean } {
    const nameAtom = n.list[1] as Atom;
    const name = emitName(nameAtom);
    const bindings = n.list[2];
    const varAtoms: Atom[] = [];
    const inits: string[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0])) {
          varAtoms.push(b.list[0]);
          inits.push(b.list[1] === undefined ? "undefined" : lower(b.list[1]));
        }
      }
    }
    const emitParams = varAtoms.map(emitName); // scope-resolved names (emit + await machinery)
    const bodyForms = n.list.slice(3);
    let body = withParams(emitParams, () => lowerBody(bodyForms));
    const isAsync = ctx.target === "run" && body.includes("await");
    if (isAsync) body = withParams([...emitParams, emitName(nameAtom)], () => lowerBody(bodyForms)); // recursive calls await
    const a = isAsync ? "async " : "";
    const call = `${name}(${inits.join(", ")})`;
    return {
      block: `{ const ${name} = ${a}(${emitParams.join(", ")}) => ${body}; return ${isAsync ? `await ${call}` : call}; }`,
      isAsync,
    };
  }

  /**
   * Named `let` — Scheme's loop primitive — in EXPRESSION position: the block wrapped in
   * an immediately-invoked arrow so it's an expression. At a function's sole-body position
   * {@link lowerBody} unwraps it (the enclosing arrow is the wrapper).
   */
  function lowerNamedLet(n: ListNode): string {
    return iife(namedLetBlock(n).block);
  }

  /** A named let unwrapped at body position declares `const <loopName>` in the arrow block;
   *  keep the IIFE if that name shadows a param (same-scope const redeclare). */
  function namedLetShadowsParam(n: ListNode): boolean {
    return isAtom(n.list[1]) && inParams(emitName(n.list[1]));
  }

  /** A body statement: an internal `(define …)` → a block-local `const` (Scheme allows
   *  defines at the head of any body); anything else → an expression statement. */
  function lowerStmt(form: Node): string {
    return isList(form) && head(form) === "define" ? lowerDefine(form) : `${lower(form)};`;
  }

  function lowerSequence(forms: Node[], open: string, close: string): string {
    const last = lower(forms.at(-1)!);
    const lead = forms.slice(0, -1).map(lowerStmt);
    return `${open} ${[...lead, `return ${last};`].join(" ")} ${close}`;
  }

  function lowerBody(forms: Node[]): string {
    if (forms.length === 1) {
      const only = forms[0]!;
      // A let/let*/named-let/begin as the SOLE body IS the arrow's own block — drop the
      // IIFE `lowerLet`/`begin` add for expression position (it's pure ceremony here, and
      // unwrapping lets an `await` inside sit in the now-async function, not a nested sync
      // IIFE). Skip one that would shadow a param (same-scope const redeclare).
      if (isList(only)) {
        const h = head(only);
        if ((h === "let" || h === "let*") && !isAtom(only.list[1]) && !letShadowsParam(only)) return letBlock(only);
        if (h === "let" && isAtom(only.list[1]) && !namedLetShadowsParam(only)) return namedLetBlock(only).block;
        if (h === "begin") return lowerSequence(only.list.slice(1), "{", "}");
      }
      // A single object-literal body must be parenthesized so the arrow doesn't
      // read `=> { … }` as a block: `(x) => ({ a: 1 })`, not `(x) => { a: 1 }`.
      const e = lower(only);
      return e.startsWith("{") ? `(${e})` : e;
    }
    return lowerSequence(forms, "{", "}");
  }

  function lowerQuote(datum: Node | undefined): string {
    if (datum === undefined) return "undefined";
    if (isAtom(datum)) {
      if (datum.str) return JSON.stringify(decodeString(datum.atom));
      if (isNumber(datum) || isBool(datum)) return lowerAtom(datum);
      return JSON.stringify(datum.atom); // quoted symbol → string
    }
    if (isList(datum)) return `[${datum.list.map(lowerQuote).join(", ")}]`;
    return "undefined";
  }

  function lowerTop(form: Node): string {
    const lead = leadComments(form);
    let code: string;
    if (isList(form) && head(form) === "define") {
      code = lowerDefine(form);
    } else {
      const expr = lower(form); // a top-level expression statement: parenthesize an object
      code = `${expr.startsWith("{") ? `(${expr})` : expr};`; // literal so `{…}` isn't a block
    }
    return lead ? `${lead}\n${code}` : code;
  }

  function lowerDefine(n: ListNode): string {
    const sig = n.list[1];
    if (isList(sig)) {
      const nameAtom = isAtom(sig.list[0]) ? sig.list[0] : undefined;
      const name = nameAtom ? emitName(nameAtom) : "_";
      const ps = paramAtoms({ list: sig.list.slice(1) });
      // async-ness keyed by cleanName — matches `asyncNames` (from async-analysis).
      const asyncKw = ctx.target === "run" && nameAtom && ctx.asyncNames.has(cleanName(nameAtom.atom)) ? "async " : "";
      const body = withParams(ps.map(emitParam), () => lowerBody(n.list.slice(2)));
      return `const ${name} = ${asyncKw}(${ps.map(emitParam).join(", ")}) => ${body};`;
    }
    const name = isAtom(sig) ? emitName(sig) : "_";
    return `const ${name} = ${lower(n.list[2]!)};`;
  }

  return { ...E, lowerTop };
}

// ── pure helpers ──────────────────────────────────────────────────────

/** Parenthesize an `await …` before a member access: `(await x).f`. No-op in read-view. */
function recv(s: string): string {
  return /^await\b/.test(s) ? `(${s})` : s;
}

/** Parameter atoms, with a dotted rest `(a b . rest)` flagged. The caller derives the
 *  cleanName form (await machinery) and the scope-resolved emit form. */
function paramAtoms(node: Node | undefined): { atom: Atom; rest: boolean }[] {
  if (!isList(node)) return [];
  const out: { atom: Atom; rest: boolean }[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push({ atom: rest, rest: true });
      break;
    }
    if (isAtom(p)) out.push({ atom: p, rest: false });
  }
  return out;
}

function pathOf(node: Node | undefined): string {
  if (isAtom(node) && node.str) return node.atom;
  throw new Error("`require` expects a string path");
}

/** A form's leading `;;` comments (captured by the parser) → `//` lines, preserved for the read-view. */
function leadComments(form: Node): string {
  const lead = (form as { lead?: string[] }).lead;
  if (!lead || lead.length === 0) return "";
  return lead.map((c) => c.replace(/^;+\s?/, "// ")).join("\n");
}

function describe(n: Node): string {
  return isAtom(n) ? n.atom : "(…)";
}

/** Decode a scheme string literal's escapes to runtime chars — the parser stores
 *  them raw (`\n` as backslash+n), so emitting `JSON.stringify(raw)` would double-escape. */
function decodeString(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c; // \\ \" and any other escaped char → the char itself
    }
  });
}
