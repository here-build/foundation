/**
 * Enumerate top-level `(define …)` forms in a Scheme source — the
 * substrate primitive behind the studio's Functions panel.
 *
 * Recognises three shapes:
 *   (define name value)                       → constant
 *   (define (name args…) body…)               → function
 *   (define name (lambda (args…) body…))      → function (synonym)
 *
 * Quietly ignores anything that isn't a top-level define — including
 * `(define-syntax …)`, nested defines, and forms inside `(begin …)`.
 * Returns `[]` if the source fails to parse; the caller (e.g. an
 * editor) renders the parse error through its own channel.
 *
 * Pair / SchemeSymbol are duck-typed because the concrete classes are
 * not in arrival-scheme's public surface — same approach as
 * `trace-view.tsx`. The `__location__` symbol is a registry symbol
 * (`Symbol.for("__location__")`) so we can read it without importing
 * `arrival-scheme/primitives.js`.
 */
import { parseGenerator } from "@here.build/arrival";

/**
 * Source location of a parsed form. Mirrors arrival-scheme's internal
 * `SourceLocation` (not re-exported from its index today). Read from
 * `Symbol.for("__location__")` on the Pair.
 */
export interface SourceLocation {
  /** 1-indexed line number. */
  line: number;
  /** 0-indexed column number. */
  col: number;
  /** 0-indexed byte offset from start of source. */
  offset: number;
  /** Optional source identifier (filename, module, etc.). */
  source?: string;
}

export interface DefineInfo {
  /** Symbol name being defined. */
  name: string;
  /** `function` for `(define (f …) …)` or `(define f (lambda …))`; `constant` otherwise. */
  kind: "function" | "constant";
  /** Number of positional args. Omitted for constants and for parses we can't determine. */
  arity?: number;
  /** True when the parameter list ends with a rest arg (`. rest`). */
  variadic?: boolean;
  /** Source location of the `(define …)` form. */
  location?: SourceLocation;
}

const LOCATION_KEY = Symbol.for("__location__");

const isPair = (v: unknown): v is { car: unknown; cdr: unknown } =>
  v !== null && typeof v === "object" && "car" in v && "cdr" in v;

const isSymbol = (v: unknown): v is { __name__: string | symbol } =>
  v !== null && typeof v === "object" && "__name__" in v;

// Nil is arrival-scheme's empty-list sentinel — an object with no car or cdr.
// (SchemeSymbol is also a no-car/no-cdr object, so we check "is it a symbol?"
// to detect a dotted-tail variadic arg.)
const isNil = (v: unknown): boolean => v !== null && typeof v === "object" && !isPair(v) && !isSymbol(v);

const symName = (s: { __name__: string | symbol }): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Length of a Pair chain. Variadic when the tail is a bare symbol (`. rest`). */
function chainLength(p: unknown): { count: number; variadic: boolean } {
  let count = 0;
  let cur = p;
  while (isPair(cur)) {
    count++;
    cur = cur.cdr;
  }
  return { count, variadic: isSymbol(cur) };
}

const locationOf = (form: unknown): SourceLocation | undefined =>
  (form as Record<symbol, unknown>)[LOCATION_KEY] as SourceLocation | undefined;

export async function extractDefines(source: string): Promise<DefineInfo[]> {
  let forms: unknown[];
  try {
    forms = (await parseGenerator(source)) as unknown[];
  } catch {
    return [];
  }

  const out: DefineInfo[] = [];
  for (const form of forms) {
    if (!isPair(form)) continue;
    if (!isSymbol(form.car) || symName(form.car) !== "define") continue;

    const cdr1 = form.cdr;
    if (!isPair(cdr1)) continue;
    const head = cdr1.car;
    const tail = cdr1.cdr;
    const location = locationOf(form);

    if (isPair(head) && isSymbol(head.car)) {
      // (define (name args…) body…)
      const { count, variadic } = chainLength(head.cdr);
      out.push({ name: symName(head.car), kind: "function", arity: count, variadic, location });
      continue;
    }

    if (isSymbol(head)) {
      const name = symName(head);
      const rhs = isPair(tail) ? tail.car : undefined;
      if (
        isPair(rhs) &&
        isSymbol(rhs.car) &&
        symName(rhs.car) === "lambda" &&
        isPair(rhs.cdr) &&
        (isPair(rhs.cdr.car) || isNil(rhs.cdr.car))
      ) {
        // (define name (lambda (args…) body…))
        const { count, variadic } = chainLength(rhs.cdr.car);
        out.push({ name, kind: "function", arity: count, variadic, location });
      } else {
        out.push({ name, kind: "constant", location });
      }
    }
  }
  return out;
}
