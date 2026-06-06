/**
 * Scope-aware identifier naming via `@here.build/lexical-namer` (the system Mercury's
 * var-namer uses; #76). `cleanName` is position-independent, so two bindings that clean
 * to the same JS name in overlapping scopes collide — the gepa-full bug where a named-let
 * loop var `picked` shadows the `picked?` predicate (both → `picked`, emitting the broken
 * `picked(ex, picked)`).
 *
 * This walks the parse forest into a `ScopeSpec` tree — top-level `define`s are root
 * entities; each `lambda` / `let` / `let*` / named-`let` / define-with-params body is a
 * child scope (so sibling scopes reuse names freely: `c` in three lambdas stays `c`) —
 * feeds each binding the `nameCandidates` ladder, and resolves. Returns `nameOf`: every
 * BOUND identifier occurrence (binding site + reference) → its assigned JS name. Free
 * refs / stdlib / globals are absent; the caller falls back to `cleanName`.
 *
 * Collision-free programs resolve every binding to tier-1 (`cleanName`), so output is
 * unchanged. The named-let `picked` resolves under root's `picked` claim (cross-scope,
 * parent-first) to `picked2` — the standard compiler disambiguation; the `isFoo` ladder
 * rung fires for SAME-scope ties.
 */
import { type Candidate, resolveLexicalNames, type ScopedEntity, type ScopeSpec } from "@here.build/lexical-namer";
import { nameCandidates } from "./names.js";
import { type Atom, head, isAtom, isKeyword, isList, type ListNode, type Node } from "./nodes.js";

/**
 * `nameCandidates` ladder → priority-keyed candidates. A PREDICATE bids its bare name
 * at a LOWER base than a plain binding (90 vs 100), so a same-scope clash resolves by
 * non-overlapping PRECEDENCE — the plain binding wins the bare name and the predicate
 * falls to its `isFoo` rung — rather than a tie (which would `_postfix` both). With no
 * clash the predicate still claims its bare name (drops `?`). Cross-scope clashes
 * (a top-level predicate vs a local of the same clean-name) still resolve to the
 * standard numeric suffix, since parent scopes are named first.
 *   plain `picked`   → {100:"picked"}
 *   pred  `picked?`  → {90:"picked", 80:"isPicked"}
 */
function ladder(scheme: string): Record<number, Candidate> {
  const rec: Record<number, Candidate> = {};
  const base = scheme.endsWith("?") ? 90 : 100;
  nameCandidates(scheme).forEach((name, i) => {
    rec[base - i * 10] = name;
  });
  return rec;
}

/** Binding atoms of a param list `(a b . rest)` or let-bindings `((x i) (y j))`. */
function bindingAtoms(node: Node | undefined): Atom[] {
  if (!isList(node)) return [];
  const out: Atom[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push(rest);
      break;
    }
    if (isAtom(p)) out.push(p); // param atom
    else if (isList(p) && isAtom(p.list[0])) out.push(p.list[0]); // (x init) → x
  }
  return out;
}

/** Resolve every bound identifier occurrence (binding + reference) to its JS name. */
export function resolveNames(forest: Node[], reserved: readonly string[]): Map<Atom, string> {
  const postfix = new Map<Atom, string>();
  let counter = 0;
  const entity = (atom: Atom): ScopedEntity<Atom> => {
    postfix.set(atom, String(counter++));
    return { key: atom, candidates: ladder(atom.atom) };
  };

  const refToBinding = new Map<Atom, Atom>();
  const stack: Map<string, Atom>[] = [];
  const lookup = (name: string): Atom | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i]!.get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  // Walk an expression, recording references and collecting nested binding scopes.
  function scanInto(n: Node, children: ScopeSpec<Atom>[]): void {
    if (isAtom(n)) {
      // a plain identifier ref (not a string, `:keyword`, or `<>` slot)
      if (!n.str && !(n.atom.length > 1 && n.atom.startsWith(":")) && n.atom !== "<>") {
        const b = lookup(n.atom);
        if (b) refToBinding.set(n, b);
      }
      return;
    }
    if (!isList(n) || n.list.length === 0) return;
    const h = n.list[0];
    if (isKeyword(h)) {
      if (n.list[1]) scanInto(n.list[1], children); // accessor (:field obj)
      return;
    }
    const hn = isAtom(h) && !h.str ? h.atom : undefined;
    if (hn === "lambda") return void children.push(lambdaScope(n));
    if (hn === "let" || hn === "let*") return void children.push(letScope(n));
    for (const c of n.list) scanInto(c, children); // call / special form — walk all parts
  }

  /** A child scope from binding atoms + body forms (lambda / define-with-params). */
  function fnScope(params: Atom[], bodyForms: Node[]): ScopeSpec<Atom> {
    const entities = params.map(entity);
    const children: ScopeSpec<Atom>[] = [];
    stack.push(new Map(params.map((a) => [a.atom, a])));
    for (const f of bodyForms) scanInto(f, children);
    stack.pop();
    return { entities, children };
  }

  function lambdaScope(n: ListNode): ScopeSpec<Atom> {
    return fnScope(bindingAtoms(n.list[1]), n.list.slice(2));
  }

  /** `(let ((x i)…) body)` / `let*` and named `(let loop ((x i)…) body)`. Inits are scanned
   *  in the PARENT (their child scopes over-reserve against the let vars — safe). */
  function letScope(n: ListNode): ScopeSpec<Atom> {
    const named = isAtom(n.list[1]);
    const loopAtom = named ? (n.list[1] as Atom) : undefined;
    const bindings = named ? n.list[2] : n.list[1];
    const bodyForms = n.list.slice(named ? 3 : 2);
    const vars = bindingAtoms(bindings);
    const children: ScopeSpec<Atom>[] = [];
    // init expressions live in the enclosing scope (vars not yet bound).
    if (isList(bindings)) for (const b of bindings.list) if (isList(b) && b.list[1]) scanInto(b.list[1], children);
    const entities = [...(loopAtom ? [entity(loopAtom)] : []), ...vars.map(entity)];
    const frame = new Map(vars.map((a) => [a.atom, a]));
    if (loopAtom) frame.set(loopAtom.atom, loopAtom);
    stack.push(frame);
    for (const f of bodyForms) scanInto(f, children);
    stack.pop();
    return { entities, children };
  }

  // ── root scope: top-level defines are entities; their bodies are child scopes ──
  const rootEntities: ScopedEntity<Atom>[] = [];
  const rootChildren: ScopeSpec<Atom>[] = [];
  const rootBindings = new Map<string, Atom>();
  const defineNameAtom = (form: ListNode): Atom | undefined => {
    const sig = form.list[1];
    if (isList(sig) && isAtom(sig.list[0])) return sig.list[0];
    if (isAtom(sig)) return sig;
    return undefined;
  };
  // Pre-register all top-level names so forward references resolve.
  for (const form of forest) {
    if (isList(form) && head(form) === "define") {
      const a = defineNameAtom(form);
      if (a) rootBindings.set(a.atom, a);
    }
  }
  stack.push(rootBindings);
  for (const form of forest) {
    if (isList(form) && head(form) === "define") {
      const a = defineNameAtom(form);
      if (a) rootEntities.push(entity(a));
      const sig = form.list[1];
      if (isList(sig)) rootChildren.push(fnScope(bindingAtoms({ list: sig.list.slice(1) }), form.list.slice(2)));
      else if (form.list[2]) scanInto(form.list[2], rootChildren); // (define x val)
    } else {
      scanInto(form, rootChildren); // a top-level expression
    }
  }
  stack.pop();

  const root: ScopeSpec<Atom> = { id: "root", reservations: [...reserved], entities: rootEntities, children: rootChildren };
  const { assignments } = resolveLexicalNames(root, {
    postfixFor: (atom) => postfix.get(atom) ?? "0",
    resolveTie: (name, p) => `${name}_${p}`, // JS idents: no hyphens
    onTie: "free",
  });

  // nameOf: binding atoms (direct) + reference atoms (via their binding).
  const nameOf = new Map<Atom, string>(assignments);
  for (const [ref, binding] of refToBinding) {
    const name = assignments.get(binding);
    if (name !== undefined) nameOf.set(ref, name);
  }
  return nameOf;
}
