/**
 * The lowering walk: scheme `Node` forest → naive JS expression/statement strings.
 * Structure-preserving and total over the forms the example chains use; anything
 * outside that set throws an explicit "unsupported in read-view" error (a door,
 * not a silent miss). Faithful to the parse tree it is GIVEN — a malformed source
 * projects to malformed-but-isomorphic JS; the projection never invents structure.
 */
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
import { type Emit, STDLIB } from "./stdlib.js";

export interface LowerCtx {
  /** Inline `(require "p")` (nested in an expression) → its hoisted import local. */
  requireSubst: Map<string, string>;
}

export interface Lowerer extends Emit {
  /** Lower a top-level form: a `define` → `const`, anything else → an expression statement. */
  lowerTop(form: Node): string;
}

export function makeLowerer(ctx: LowerCtx): Lowerer {
  // Stack of scheme→js name overrides, used to inline a unary lambda's body in
  // place (e.g. inside `max-by`). Empty in the common case; resolution then falls
  // through to the pure `cleanName`.
  const substStack: Map<string, string>[] = [];

  const resolveRef = (scheme: string): string => {
    for (let i = substStack.length - 1; i >= 0; i--) {
      const hit = substStack[i]!.get(scheme);
      if (hit !== undefined) return hit;
    }
    return cleanName(scheme);
  };

  const lower = (n: Node): string => (isAtom(n) ? lowerAtom(n) : isList(n) ? lowerList(n) : "undefined");

  const lowerWith = (bindings: Record<string, string>, body: Node): string => {
    substStack.push(new Map(Object.entries(bindings)));
    try {
      return lower(body);
    } finally {
      substStack.pop();
    }
  };

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
    return resolveRef(a.atom);
  }

  function lowerList(n: ListNode): string {
    if (isNil(n)) return "[]";
    const h = n.list[0];

    // A :keyword in HEAD position is an ACCESSOR: (:field obj) → obj.field.
    // (A :keyword in ARGUMENT position is a kwarg — handled in lowerCall.)
    if (isKeyword(h)) {
      const obj = n.list[1];
      if (!obj) throw new Error(`accessor ${h.atom} with no operand`);
      return `${lower(obj)}.${keywordName(h)}`;
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
          return lowerSequence(n.list.slice(1), "(() => {", "})()");
        case "require": {
          const path = pathOf(n.list[1]);
          const local = ctx.requireSubst.get(path);
          if (local === undefined) throw new Error(`unresolved inline require: ${path}`);
          return local;
        }
        case "define":
          throw new Error("internal `define` is unsupported in read-view (run-view concern)");
        case "cond":
        case "case":
        case "when":
        case "unless":
          throw new Error(`\`${hName}\` is unsupported in read-view (run-view concern)`);
      }
      const emit = STDLIB[hName];
      if (emit) return emit(n.list.slice(1), { lower, lowerWith });
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
    const argStrs = positional.map((p) => lower(p));
    // Keyword → a valid JS identifier key (`:max-words` → `maxWords`), same cleaning
    // as every other identifier (a hyphen would be an invalid unquoted object key).
    if (kwargs.length > 0) argStrs.push(`{ ${kwargs.map(([k, v]) => `${cleanName(k)}: ${lower(v)}`).join(", ")} }`);
    return `${lower(fn)}(${argStrs.join(", ")})`;
  }

  function lowerLambda(n: ListNode): string {
    const params = paramList(n.list[1]);
    const body = lowerBody(n.list.slice(2));
    // A single tuple param consumed only by index destructures: (pair) => pair[1] === 0
    // becomes ([first, second]) => second === 0.
    if (params.length === 1) {
      const d = destructureTuple(params[0]!, body);
      if (d) return `(${d.pattern}) => ${d.body}`;
    }
    return `(${params.join(", ")}) => ${body}`;
  }

  function lowerIf(n: ListNode): string {
    const [, c, a, b] = n.list;
    const els = b !== undefined ? lower(b) : "undefined";
    return `(${lower(c!)} ? ${lower(a!)} : ${els})`;
  }

  function lowerLet(n: ListNode): string {
    if (isAtom(n.list[1])) throw new Error("named `let` is unsupported in read-view (run-view concern)");
    const bindings = n.list[1];
    const decls: string[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0])) decls.push(`const ${cleanName(b.list[0].atom)} = ${lower(b.list[1]!)};`);
      }
    }
    return lowerSequence(n.list.slice(2), `(() => { ${decls.join(" ")}`, "})()");
  }

  function lowerSequence(forms: Node[], open: string, close: string): string {
    const last = lower(forms[forms.length - 1]!);
    const lead = forms.slice(0, -1).map((f) => `${lower(f)};`);
    return `${open} ${[...lead, `return ${last};`].join(" ")} ${close}`;
  }

  function lowerBody(forms: Node[]): string {
    if (forms.length === 1) {
      // A single object-literal body must be parenthesized so the arrow doesn't
      // read `=> { … }` as a block: `(x) => ({ a: 1 })`, not `(x) => { a: 1 }`.
      const e = lower(forms[0]!);
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
    const code = isList(form) && head(form) === "define" ? lowerDefine(form) : `${lower(form)};`;
    return lead ? `${lead}\n${code}` : code;
  }

  function lowerDefine(n: ListNode): string {
    const sig = n.list[1];
    if (isList(sig)) {
      const name = isAtom(sig.list[0]) ? cleanName(sig.list[0].atom) : "_";
      const params = paramList({ list: sig.list.slice(1) });
      return `const ${name} = (${params.join(", ")}) => ${lowerBody(n.list.slice(2))};`;
    }
    const name = isAtom(sig) ? cleanName(sig.atom) : "_";
    return `const ${name} = ${lower(n.list[2]!)};`;
  }

  return { lower, lowerWith, lowerTop };
}

// ── pure helpers ──────────────────────────────────────────────────────

/** Parameter list, with a dotted rest `(a b . rest)` → `["a", "b", "...rest"]`. */
function paramList(node: Node | undefined): string[] {
  if (!isList(node)) return [];
  const out: string[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push(`...${cleanName(rest.atom)}`);
      break;
    }
    if (isAtom(p)) out.push(cleanName(p.atom));
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
  return raw.replace(/\\(.)/g, (_m, c: string) => {
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
