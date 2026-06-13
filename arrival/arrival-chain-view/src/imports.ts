/**
 * `require` → `import` planning. Three shapes, dispatched on form position + file
 * extension; inline requires (nested in an expression) are HOISTED to a top-of-file
 * import + a substitution, so the read-view stays synchronous (no `await import`).
 *
 *   (require "metric.scm")                      → import { metric } from "./metric.scm"   (bare spill)
 *   (define examples (require "examples.json")) → import examples from "./examples.json"  (bound)
 *   (gepa (require "seed.txt") 4)               → import seed from "./seed.txt"; … gepa(seed, 4)  (inline, hoisted)
 *
 * `.scm` spill names are read from the required source with the same parser — no
 * dependency on the heavy arrival-chain runtime barrel; the projection stays a few KB.
 */
import { parseSexprs } from "@here.build/arrival-sweet";

import { cleanName } from "./names.js";
import { head, isAtom, isList, type Node } from "./nodes.js";

export interface ProjectOptions {
  /** Source of a required file, for `.scm` spill name extraction. Pure injection; no fs in the core. */
  requireSource?: (path: string) => string | undefined;
  /** "read" (default, sync + legible) or "run" (async + ax-wired, runnable). */
  target?: "read" | "run";
}

export interface ImportPlan {
  importLines: string[];
  /** Inline-require path → its hoisted import local (consumed by the lowerer). */
  requireSubst: Map<string, string>;
  /** Top-level forms consumed entirely as imports (skipped by the body emitter). */
  skipForms: Set<Node>;
}

const specOf = (path: string): string => (/^[./]/.test(path) ? path : `./${path}`);
const stem = (path: string): string => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
const extOf = (path: string): string => /\.([^.]+)$/.exec(path)?.[1] ?? "";

/** `(require "path")` → its path, else null. */
function asRequire(node: Node | undefined): string | null {
  if (isList(node) && head(node) === "require") {
    const p = node.list[1];
    if (isAtom(p) && p.str) return p.atom;
  }
  return null;
}

export function collectImports(forest: Node[], opts: ProjectOptions): ImportPlan {
  const importLines: string[] = [];
  const requireSubst = new Map<string, string>();
  const skipForms = new Set<Node>();
  const consumed = new Set<Node>(); // require-nodes already handled at top level
  const usedLocals = new Set<string>();

  // Reserve every top-level `define` name up front, so a hoisted inline-require local
  // (pass 2) can never shadow a real binding: `(define seed …)` + `(require "seed.txt")`
  // → the import becomes `seed_2`, not a duplicate `const seed`.
  for (const form of forest) {
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      const nm = isList(sig) && isAtom(sig.list[0]) ? sig.list[0].atom : isAtom(sig) ? sig.atom : undefined;
      if (nm !== undefined) usedLocals.add(cleanName(nm));
    }
  }

  const uniqueLocal = (base: string): string => {
    const clean = cleanName(base);
    let name = clean;
    let n = 2;
    while (usedLocals.has(name)) name = `${clean}_${n++}`;
    usedLocals.add(name);
    return name;
  };

  // Pass 1 — top-level forms (bare requires + define-bound requires).
  for (const form of forest) {
    const barePath = asRequire(form);
    if (barePath !== null) {
      consumed.add(form);
      skipForms.add(form);
      importLines.push(spillImport(barePath, opts, usedLocals));
      continue;
    }
    if (isList(form) && head(form) === "define" && isAtom(form.list[1])) {
      const rhs = form.list[2];
      const rhsPath = asRequire(rhs);
      if (rhsPath !== null && rhs) {
        // The define name IS the canonical binding (already reserved above) — use it directly.
        const local = cleanName(form.list[1].atom);
        consumed.add(rhs);
        skipForms.add(form);
        importLines.push(`import ${local} from "${specOf(rhsPath)}";`);
        continue;
      }
    }
  }

  // Pass 2 — inline requires anywhere else → hoist + substitute.
  const walk = (node: Node): void => {
    if (!isList(node)) return;
    const p = asRequire(node);
    if (p !== null) {
      if (!consumed.has(node) && !requireSubst.has(p)) {
        const local = uniqueLocal(stem(p));
        requireSubst.set(p, local);
        importLines.push(`import ${local} from "${specOf(p)}";`);
      }
      return;
    }
    for (const c of node.list) walk(c);
  };
  for (const form of forest) if (!skipForms.has(form)) walk(form);

  return { importLines, requireSubst, skipForms };
}

/** A bare `(require "x.scm")` spills the file's top-level defines → a named import. */
function spillImport(path: string, opts: ProjectOptions, usedLocals: Set<string>): string {
  if (extOf(path) === "scm") {
    const src = opts.requireSource?.(path);
    if (src) {
      const names = topLevelDefineNames(src);
      for (const n of names) usedLocals.add(n);
      if (names.length > 0) return `import { ${names.join(", ")} } from "${specOf(path)}";`;
    }
    return `import * as ${cleanName(stem(path))} from "${specOf(path)}";`; // names unknown → namespace
  }
  return `import "${specOf(path)}";`; // non-module side-effect (rare)
}

/** Top-level `(define …)` names of a scheme source, cleaned to JS — the spill set. */
function topLevelDefineNames(src: string): string[] {
  const out: string[] = [];
  for (const form of parseSexprs(src)) {
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      if (isList(sig) && isAtom(sig.list[0])) out.push(cleanName(sig.list[0].atom));
      else if (isAtom(sig)) out.push(cleanName(sig.atom));
    }
  }
  return out;
}
