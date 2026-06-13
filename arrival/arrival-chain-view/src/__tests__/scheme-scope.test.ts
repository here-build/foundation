/**
 * The scope-aware namer (#76): `resolveNames` walks the parse forest, resolves every
 * bound identifier to a non-colliding JS name via `@here.build/lexical-namer`. Free
 * refs are absent (caller falls back to cleanName). Collision-free → every binding is
 * its cleanName; a cross-scope shadow gets the standard numeric suffix.
 */
import { parseSexprs } from "@here.build/arrival-sweet";
import { describe, expect, it } from "vitest";
import { resolveNames } from "../scheme-scope.js";

/** Map each scheme atom text → the distinct JS names it resolved to. */
function namesByScheme(src: string): Map<string, string[]> {
  const nameOf = resolveNames(parseSexprs(src), []);
  const out = new Map<string, string[]>();
  for (const [atom, name] of nameOf) {
    const list = out.get(atom.atom) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(atom.atom, list);
  }
  return out;
}

describe("scheme-scope — lexical name resolution", () => {
  it("collision-free: every binding keeps its cleanName", () => {
    const m = namesByScheme("(define (f a b) (+ a b))");
    expect(m.get("f")).toEqual(["f"]);
    expect(m.get("a")).toEqual(["a"]);
    expect(m.get("b")).toEqual(["b"]);
  });

  it("sibling scopes reuse a name independently (no spurious suffix)", () => {
    const m = namesByScheme("(define (f xs) (map (lambda (c) (:id c)) xs))\n(define (g ys) (map (lambda (c) (:k c)) ys))");
    expect(m.get("c")).toEqual(["c"]); // both lambdas' `c` resolve to `c`
  });

  it("cross-scope shadow: predicate yields the bare name to the data binding, taking isFoo", () => {
    const src = `(define (picked? x ys) #t)
(define (f set)
  (let loop ((picked (list)))
    (if (picked? 1 picked) picked (loop picked))))`;
    const m = namesByScheme(src);
    // A plain binding (the loop var) wants "picked", so the predicate yields it cross-scope.
    expect(m.get("picked?")).toEqual(["isPicked"]); // predicate → isFoo rung
    expect(m.get("picked")).toEqual(["picked"]); // data binding keeps the clean name
  });

  it("an internal (body-local) define is a binding the namer sees", () => {
    // Before W1.0 the scope walk had no `define` case, so an internal `loop` was absent from
    // `nameOf` entirely (its refs fell back to cleanName). Now it resolves like any binding.
    const m = namesByScheme(
      "(define (index-map f xs) (define (loop i ys acc) (loop (+ i 1) (cdr ys) (cons (f i (car ys)) acc))) (loop 0 xs '()))",
    );
    expect(m.get("loop")).toEqual(["loop"]); // the binding + both call refs all resolve to `loop`
  });

  it("an internal define shadowing a top-level name is disambiguated (cross-scope)", () => {
    const m = namesByScheme("(define (helper x) (rp x))\n(define (caller xs) (define (helper y) (+ y 1)) (map helper xs))");
    // top-level keeps `helper`; the inner one (a descendant) takes `helper2`.
    expect(new Set(m.get("helper"))).toEqual(new Set(["helper", "helper2"]));
  });

  it("a predicate whose bare name no plain binding wants keeps it (drops the `?`)", () => {
    // No plain `dominates` exists → the predicate is free to claim the bare name.
    const m = namesByScheme("(define (dominates? a b) (> a b))\n(define (f xs) (filter (lambda (x) (dominates? x 0)) xs))");
    expect(m.get("dominates?")).toEqual(["dominates"]);
  });

  it("same-scope predicate vs plain binding: the isFoo rung fires", () => {
    // Two ROOT bindings that clean to the same name, one a predicate → it takes isX.
    const m = namesByScheme("(define ready 1)\n(define (ready? x) x)");
    const ready = m.get("ready") ?? [];
    const readyPred = m.get("ready?") ?? [];
    // one keeps "ready", the predicate takes "isReady" (its ladder rung), never "ready2"
    expect(new Set([...ready, ...readyPred])).toEqual(new Set(["ready", "isReady"]));
  });
});
