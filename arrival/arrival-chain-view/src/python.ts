/**
 * The Python emitter — the second language backend. Idiomatic Python: list
 * comprehensions for map/filter/every/some (no lambda-limit dance), `max(key=)` /
 * `sum` / `zip` for the folds + arity-bridge, dict subscript for records, `a if c
 * else b` ternaries, snake_case names. Shares the parser with the JS backend; the
 * prompt library (dspy / langchain) is hidden behind the emitted `infer_<name>`.
 *
 * Both views are sync (no asyncio): the read-view shows infer calls with their
 * content-derived cache key, the run-view drops it to call the real
 * `infer_<name>(**fields)`. No external formatter (black is out-of-process) — the
 * emitter prints well-formed Python directly, leaning on single-`return` `def`s and
 * expression comprehensions so the gepa-class chain stays one statement per binding.
 */
import { parseSexprs } from "@here.build/arrival-chain/sweet";
import pluralize from "pluralize";
import { desugar } from "./desugar.js";
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

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case",
]);

/** Scheme identifier → snake_case Python identifier. `run-predict`→`run_predict`, `dominates?`→`dominates`. */
export function pyName(scheme: string): string {
  let s = scheme.replace(/->/g, "_to_").replace(/[?!]/g, "").replace(/\*/g, "");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1_$2"); // camel → snake
  s = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/-/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  s = s.toLowerCase();
  if (s === "") s = "_";
  if (/^[0-9]/.test(s)) s = `_${s}`;
  if (PY_KEYWORDS.has(s)) s = `${s}_`;
  return s;
}

/** A singular snake loop-variable for a collection node, or null. `examples`→`example`,
 *  `(:scores c)`→`score`, `(scores a)`→`score` (a getter call whose name is plural). */
function pyElement(list: Node): string | null {
  let base: string | undefined;
  if (isAtom(list) && !list.str) base = list.atom;
  else if (isList(list) && isKeyword(list.list[0])) base = keywordName(list.list[0] as Atom);
  else if (isList(list) && isAtom(list.list[0]) && !list.list[0].str) base = (list.list[0] as Atom).atom;
  if (!base) return null;
  const singular = pluralize.singular(pyName(base));
  return singular && singular !== pyName(base) ? singular : null;
}

const PY_BINOP: Record<string, (a: string, b: string) => string> = {
  "+": (a, b) => `${a} + ${b}`,
  "-": (a, b) => `${a} - ${b}`,
  "*": (a, b) => `${a} * ${b}`,
  "/": (a, b) => `${a} / ${b}`,
  "=": (a, b) => `${a} == ${b}`,
  "<": (a, b) => `${a} < ${b}`,
  ">": (a, b) => `${a} > ${b}`,
  "<=": (a, b) => `${a} <= ${b}`,
  ">=": (a, b) => `${a} >= ${b}`,
  "string=?": (a, b) => `${a} == ${b}`,
  "string-ci=?": (a, b) => `${a}.lower() == ${b}.lower()`,
};
const PY_UNOP: Record<string, (a: string) => string> = {
  car: (a) => `${a}[0]`,
  cdr: (a) => `${a}[1:]`, // list TAIL (cadr accesses the 2nd element of a pair)
  cadr: (a) => `${a}[1]`,
  caddr: (a) => `${a}[2]`,
  first: (a) => `${a}[0]`,
  "zero?": (a) => `${a} == 0`,
  "even?": (a) => `${a} % 2 == 0`,
  "odd?": (a) => `${a} % 2 != 0`,
  not: (a) => `not ${a}`,
};

export interface PyOptions {
  /** Source of a `.scm` required file, for spill name extraction. */
  requireSource?: (path: string) => string | undefined;
  /** "read" (default, the legible cache-keyed projection) or "run" (calls the real
   *  `infer_<name>(**kwargs)` — drops the read-view's content-derived cache key). */
  target?: "read" | "run";
}

/** Project an arrival-chain scheme source to idiomatic Python.
 *
 * The read-view and run-view differ in exactly ONE place: the read-view shows an
 * infer call with its content-derived cache key (`run_predict([k], a=a, b=b)`,
 * legible — this is what replays in the trace); the run-view drops that key and
 * calls the dspy/langchain module's real `infer_<name>(a=a, b=b)`. No async: unlike
 * JS, the Python read-view is already sync-sequential, so there's nothing else to
 * change — `.invoke`/`dspy.Predict` are synchronous. */
export function projectToPy(source: string, opts: PyOptions = {}): string {
  const forest = desugar(parseSexprs(source));
  const { importLines, requireSubst, skipForms, inferLocals } = collectPyImports(forest, opts);
  const lower = makePyLower(requireSubst, inferLocals, opts.target ?? "read");
  const body = forest.filter((f) => !skipForms.has(f)).map((f) => lower.top(f));
  return [importLines.join("\n"), body.join("\n\n")].filter((s) => s.length > 0).join("\n\n") + "\n";
}

function makePyLower(requireSubst: Map<string, string>, inferLocals: Set<string>, target: "read" | "run") {
  const subst: Map<string, string>[] = [];
  const resolve = (s: string): string => {
    for (let i = subst.length - 1; i >= 0; i--) {
      const hit = subst[i]!.get(s);
      if (hit !== undefined) return hit;
    }
    return pyName(s);
  };

  const lower = (n: Node): string => (isAtom(n) ? atom(n) : isList(n) ? list(n) : "None");

  function atom(a: Atom): string {
    if (a.str) return JSON.stringify(a.atom);
    if (isBool(a)) return a.atom === "#t" ? "True" : "False";
    if (isNumber(a)) return a.atom;
    if (!a.str && a.atom.length > 1 && a.atom.startsWith(":")) throw new Error(`bare keyword: ${a.atom}`);
    return resolve(a.atom);
  }

  /** Apply a function node to a loop-var string (comprehension element). */
  function applyTo(fn: Node, v: string): string {
    if (isList(fn) && head(fn) === "lambda") {
      const params = (fn.list[1] as ListNode).list;
      if (params.length === 1 && isAtom(params[0])) {
        subst.push(new Map([[params[0].atom, v]]));
        try {
          return lower(fn.list[2]!);
        } finally {
          subst.pop();
        }
      }
    }
    if (isKeyword(fn)) return `${v}[${JSON.stringify(keywordName(fn))}]`; // `:score` as a fn → x["score"]
    if (isAtom(fn) && !fn.str) {
      const u = PY_UNOP[fn.atom];
      if (u) return u(v);
    }
    return `${lower(fn)}(${v})`;
  }

  /** map/filter/every/some → comprehensions. */
  function comp(method: string, args: Node[]): string {
    const [fn, ...lists] = args;
    if (!fn || lists.length === 0) return "[]";
    if (lists.length === 1) {
      const src = lower(lists[0]!);
      const v = (isList(fn) && head(fn) === "lambda" && isAtom((fn.list[1] as ListNode).list[0])
        ? pyName(((fn.list[1] as ListNode).list[0] as Atom).atom)
        : (pyElement(lists[0]!) ?? "x"));
      const e = applyTo(fn, v);
      if (method === "map") return `[${e} for ${v} in ${src}]`;
      if (method === "filter") return `[${v} for ${v} in ${src} if ${e}]`;
      if (method === "every") return `all(${e} for ${v} in ${src})`;
      return `any(${e} for ${v} in ${src})`; // some
    }
    // multi-list → zip
    const srcs = lists.map((l) => lower(l));
    const vars = lists.map((_l, i) => `_${"abcdefgh"[i] ?? `v${i}`}`);
    const zipped = `zip(${srcs.join(", ")})`;
    if (isAtom(fn) && fn.atom === "list" && lists.length === 2) return `list(${zipped})`; // (map list a b) → pairs
    const applied =
      isAtom(fn) && fn.atom === "cons"
        ? `[${vars[0]}, *${vars[1]}]` // cons = prepend
        : isAtom(fn) && PY_BINOP[fn.atom]
          ? PY_BINOP[fn.atom]!(vars[0]!, vars[1]!)
          : `${lower(fn)}(${vars.join(", ")})`;
    const head2 = method === "map" ? `[${applied}` : method === "every" ? `all(${applied}` : method === "some" ? `any(${applied}` : `[${applied}`;
    const tail = method === "map" ? "]" : method === "filter" ? "]" : ")";
    return `${head2} for ${vars.join(", ")} in ${zipped}${tail}`;
  }

  const STDLIB: Record<string, (args: Node[]) => string> = {
    map: (a) => comp("map", a),
    filter: (a) => comp("filter", a),
    every: (a) => comp("every", a),
    some: (a) => comp("some", a),
    list: (a) => `[${a.map(lower).join(", ")}]`,
    cons: (a) => {
      // prepend (pairs use `list` + car/cadr). A `(list …)` tail splices its elements
      // inline (`[x, a, b]`) rather than the machine-tell `[x, *[a, b]]`.
      const tail = a[1]!;
      const t = isList(tail) && head(tail) === "list" ? tail.list.slice(1).map(lower).join(", ") : `*${lower(tail)}`;
      return `[${lower(a[0]!)}${t ? `, ${t}` : ""}]`;
    },
    car: (a) => `${lower(a[0]!)}[0]`,
    cdr: (a) => `${lower(a[0]!)}[1:]`, // list TAIL; cadr/caddr access the 2nd/3rd element
    cadr: (a) => `${lower(a[0]!)}[1]`,
    caddr: (a) => `${lower(a[0]!)}[2]`,
    "list-ref": (a) => `${lower(a[0]!)}[${lower(a[1]!)}]`,
    length: (a) => `len(${lower(a[0]!)})`,
    reverse: (a) => `list(reversed(${lower(a[0]!)}))`,
    append: (a) => a.map(lower).join(" + "),
    "max-by": (a) => {
      const [fn, xs] = a;
      if (isList(fn) && head(fn) === "lambda" && isAtom((fn.list[1] as ListNode).list[0])) {
        const p = pyName(((fn.list[1] as ListNode).list[0] as Atom).atom);
        subst.push(new Map());
        const keyBody = lower(fn.list[2]!);
        subst.pop();
        return `max(${lower(xs!)}, key=lambda ${p}: ${keyBody})`;
      }
      return `max(${lower(xs!)}, key=${lower(fn!)})`;
    },
    apply: (a) => {
      const [fn, xs] = a;
      if (isAtom(fn) && !fn.str && fn.atom === "map") {
        const combiner = a[1];
        if (isAtom(combiner) && !combiner.str && combiner.atom === "list" && a[2]) {
          return `[list(col) for col in zip(*${lower(a[2])})]`; // (apply map list rows) → transpose
        }
        throw new Error("`apply map` is supported only as the transpose `(apply map list rows)`");
      }
      if (isAtom(fn) && fn.atom === "+") return `sum(${lower(xs!)})`;
      if (isAtom(fn) && fn.atom === "*") return `math.prod(${lower(xs!)})`;
      return `${lower(fn!)}(*${lower(xs!)})`;
    },
    "+": (a) => `(${a.map(lower).join(" + ")})`,
    "-": (a) => (a.length === 1 ? `-${lower(a[0]!)}` : `(${a.map(lower).join(" - ")})`),
    "*": (a) => `(${a.map(lower).join(" * ")})`,
    "/": (a) => `(${a.map(lower).join(" / ")})`,
    "=": (a) => `${lower(a[0]!)} == ${lower(a[1]!)}`,
    "<": (a) => `${lower(a[0]!)} < ${lower(a[1]!)}`,
    ">": (a) => `${lower(a[0]!)} > ${lower(a[1]!)}`,
    "<=": (a) => `${lower(a[0]!)} <= ${lower(a[1]!)}`,
    ">=": (a) => `${lower(a[0]!)} >= ${lower(a[1]!)}`,
    "zero?": (a) => `${lower(a[0]!)} == 0`,
    "even?": (a) => `${lower(a[0]!)} % 2 == 0`,
    "odd?": (a) => `${lower(a[0]!)} % 2 != 0`,
    not: (a) => `not ${lower(a[0]!)}`,
    and: (a) => `(${a.map(lower).join(" and ")})`,
    or: (a) => `(${a.map(lower).join(" or ")})`,
    "string=?": (a) => `${lower(a[0]!)} == ${lower(a[1]!)}`,
    "string-ci=?": (a) => `${lower(a[0]!)}.lower() == ${lower(a[1]!)}.lower()`,
    dict: (a) => {
      const parts: string[] = [];
      for (let i = 0; i + 1 < a.length; i += 2) {
        const k = a[i]!;
        const key = isKeyword(k) ? JSON.stringify(keywordName(k)) : lower(k);
        parts.push(`${key}: ${lower(a[i + 1]!)}`);
      }
      return `{${parts.join(", ")}}`;
    },
  };

  function list(n: ListNode): string {
    if (isNil(n)) return "[]";
    const h = n.list[0];
    if (isKeyword(h)) {
      const obj = n.list[1];
      if (!obj) throw new Error(`accessor ${h.atom} with no operand`);
      return `${lower(obj)}[${JSON.stringify(keywordName(h))}]`; // dict subscript
    }
    const hName = isAtom(h) && !h.str ? h.atom : undefined;
    if (hName !== undefined) {
      if (hName === "if") {
        const [, c, t, e] = n.list;
        return `(${lower(t!)} if ${lower(c!)} else ${e !== undefined ? lower(e) : "None"})`;
      }
      if (hName === "lambda") {
        const params = (n.list[1] as ListNode).list.filter(isAtom).map((p) => pyName(p.atom));
        return `lambda ${params.join(", ")}: ${lower(n.list[2]!)}`;
      }
      if (hName === "require") {
        const local = requireSubst.get(pathOf(n.list[1]));
        if (local === undefined) throw new Error(`unresolved inline require`);
        return local;
      }
      const emit = STDLIB[hName];
      if (emit) return emit(n.list.slice(1));
    }
    return call(h!, n.list.slice(1));
  }

  function call(fn: Node, args: Node[]): string {
    // Run-view: an infer primitive is called as `infer_<name>(**fields)` — drop the
    // read-view's leading content-derived cache-key positional (`(list a b)`).
    const headName = isAtom(fn) && !fn.str ? resolve(fn.atom) : undefined;
    if (target === "run" && headName !== undefined && inferLocals.has(headName) && args.length > 0 && !isKeyword(args[0])) {
      args = args.slice(1);
    }
    const pos: Node[] = [];
    const kw: [string, Node][] = [];
    let i = 0;
    while (i < args.length && !isKeyword(args[i])) pos.push(args[i++]!);
    while (i < args.length) {
      kw.push([keywordName(args[i] as Atom), args[i + 1]!]);
      i += 2;
    }
    const a = pos.map(lower);
    for (const [k, v] of kw) a.push(`${pyName(k)}=${lower(v)}`);
    return `${lower(fn)}(${a.join(", ")})`;
  }

  function top(form: Node): string {
    const lead = leadComments(form);
    let code: string;
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      if (isList(sig)) {
        const name = isAtom(sig.list[0]) ? pyName(sig.list[0].atom) : "_";
        const params = sig.list.slice(1).filter(isAtom).map((p) => pyName((p as Atom).atom));
        code = `def ${name}(${params.join(", ")}):\n    return ${lower(form.list[2]!)}`;
      } else {
        code = `${isAtom(sig) ? pyName(sig.atom) : "_"} = ${lower(form.list[2]!)}`;
      }
    } else {
      code = lower(form);
    }
    return lead ? `${lead}\n${code}` : code;
  }

  return { top };
}

// ── imports ───────────────────────────────────────────────────────────

function pathOf(node: Node | undefined): string {
  if (isAtom(node) && node.str) return node.atom;
  throw new Error("`require` expects a string path");
}
const stemOf = (p: string): string => pyName((p.split("/").pop() ?? p).replace(/\.[^.]+$/, ""));
const extOf = (p: string): string => /\.([^.]+)$/.exec(p)?.[1] ?? "";

function collectPyImports(
  forest: Node[],
  opts: PyOptions,
): { importLines: string[]; requireSubst: Map<string, string>; skipForms: Set<Node>; inferLocals: Set<string> } {
  const importLines: string[] = [];
  const requireSubst = new Map<string, string>();
  const skipForms = new Set<Node>();
  const consumed = new Set<Node>();
  const inferLocals = new Set<string>(); // locals bound to a `.prompt` — the infer primitives
  let needsJson = false;

  const asRequire = (n: Node | undefined): string | null => {
    if (isList(n) && head(n) === "require") {
      const p = n.list[1];
      if (isAtom(p) && p.str) return p.atom;
    }
    return null;
  };

  const loadOf = (name: string, path: string): string => {
    const ext = extOf(path);
    if (ext === "scm") return `from ${stemOf(path)} import ${name}`;
    if (ext === "prompt") return `from ${stemOf(path)}_prompt import infer_${stemOf(path)} as ${name}`;
    if (ext === "json") {
      needsJson = true;
      return `${name} = json.load(open(${JSON.stringify(path)}))`;
    }
    return `${name} = open(${JSON.stringify(path)}).read()`; // .txt and friends
  };

  for (const form of forest) {
    const bare = asRequire(form);
    if (bare !== null) {
      consumed.add(form);
      skipForms.add(form);
      const src = extOf(bare) === "scm" ? opts.requireSource?.(bare) : undefined;
      const names = src ? topLevelDefineNames(src) : [];
      importLines.push(`from ${stemOf(bare)} import ${names.join(", ") || "*"}`);
      continue;
    }
    if (isList(form) && head(form) === "define" && isAtom(form.list[1])) {
      const rhs = form.list[2];
      const path = asRequire(rhs);
      if (path !== null && rhs) {
        consumed.add(rhs);
        skipForms.add(form);
        const local = pyName(form.list[1].atom);
        if (extOf(path) === "prompt") inferLocals.add(local);
        importLines.push(loadOf(local, path));
        continue;
      }
    }
  }
  const walk = (n: Node): void => {
    if (!isList(n)) return;
    const p = asRequire(n);
    if (p !== null && !consumed.has(n)) {
      if (!requireSubst.has(p)) {
        const local = stemOf(p);
        requireSubst.set(p, local);
        if (extOf(p) === "prompt") inferLocals.add(local);
        importLines.push(loadOf(local, p));
      }
      return;
    }
    for (const c of n.list) walk(c);
  };
  for (const form of forest) if (!skipForms.has(form)) walk(form);

  if (needsJson) importLines.unshift("import json");
  return { importLines, requireSubst, skipForms, inferLocals };
}

function topLevelDefineNames(src: string): string[] {
  const out: string[] = [];
  for (const form of parseSexprs(src)) {
    if (isList(form) && head(form) === "define") {
      const sig = form.list[1];
      if (isList(sig) && isAtom(sig.list[0])) out.push(pyName(sig.list[0].atom));
      else if (isAtom(sig)) out.push(pyName(sig.atom));
    }
  }
  return out;
}

function leadComments(form: Node): string {
  const lead = (form as { lead?: string[] }).lead;
  if (!lead || lead.length === 0) return "";
  return lead.map((c) => c.replace(/^;+\s?/, "# ")).join("\n");
}
