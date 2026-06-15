import "@here.build/arrival-env";

const isNil = (element: any) => element?.constructor?.name === "Nil";

/**
 * S-Expression Serializer
 *
 * Provides a systematic way to convert JavaScript objects to arrival
 * using Symbol.toSExpr for custom representations
 */

export const SEXPR_TAG = Symbol.for("expression");

// Unique symbols for serialization markers
const QUOTED_MARKER = Symbol.for("arrival:quoted");
const FORCE_QUOTED_STRING_MARKER = Symbol.for("arrival:force_quoted_string");
const EXPR_MARKER = Symbol.for("arrival:expr");
const TAGGED_MARKER = Symbol.for("arrival:tagged");
const TRUNCATED_MARKER = Symbol.for("arrival:truncated");

/**
 * Per-render truncation budget. Serialization is SYNCHRONOUS, so a module-level
 * "active caps" is safe (no re-entrancy within a single `toSExprString` call) and
 * spares threading caps through every recursive `toSExpr`. The caps are applied
 * STREAMING — at each collection/string we stop emitting at the cap and never
 * serialize the tail (a 10k-element array costs `maxItems`, not 10k).
 */
type Caps = { maxItems: number; maxStringChars: number };
const NO_CAPS: Caps = { maxItems: Infinity, maxStringChars: Infinity };
let activeCaps: Caps = NO_CAPS;

/** A `#| … |#` block-comment marker the formatter renders verbatim, so a truncated
 *  list still PARSES (the comment is ignored) — it round-trips to the shown sample. */
const truncatedMarker = (note: string): SExpr => ({ [TRUNCATED_MARKER]: note });

/** Render the first `maxItems` of an array, appending a `+N more of TOTAL` marker when
 *  truncated. STREAMING — `slice` then map, so the dropped tail is never rendered. */
const capItems = <T>(arr: readonly T[], render: (item: T) => SExpr): SExpr[] => {
  if (arr.length <= activeCaps.maxItems) return arr.map(render);
  const shown: SExpr[] = arr.slice(0, activeCaps.maxItems).map(render);
  shown.push(truncatedMarker(`+${arr.length - activeCaps.maxItems} more of ${arr.length}`));
  return shown;
};

/** Cap a string to `maxStringChars`, annotating the elision inline. O(maxStringChars) —
 *  `slice` never walks the dropped tail. */
const capString = (full: string): string =>
  full.length > activeCaps.maxStringChars
    ? `${full.slice(0, activeCaps.maxStringChars)}…(+${full.length - activeCaps.maxStringChars} chars)`
    : full;

/** Options for the public serializer. When any cap is set, truncation is ON for this
 *  call; with none set (or a bare indent number) behaviour is unchanged (no caps). */
export type SerializeOpts = {
  /** Max elements rendered per collection before a `+N more of TOTAL` marker. */
  maxItems?: number;
  /** Max characters rendered per string before an inline `…(+N chars)` marker. */
  maxStringChars?: number;
  /** Total output budget. If the capped render still exceeds it, the per-element caps
   *  SHRINK and re-render (fair across siblings) — not a tail-cut. */
  maxTotalChars?: number;
  indent?: number;
};

export type SExprSerializable =
  | string
  | number
  | bigint
  | boolean
  | null
  | symbol
  | SExprSerializable[]
  | { [key: string | symbol]: any };

export type SExpr = string | number | bigint | boolean | null | SExpr[] | { [key: symbol]: any };
export type SExprDefinition = [typeof SEXPR_TAG, string, ...any[]];

// Context object for Symbol.toSExpr implementations
const serializationContext = {
  symbol: (value: string): SExprSerializable => {
    // Return a special marker that won't be quoted
    return Symbol(value);
  },
  keyword: (value: string): string => `:${value}`,
  quote: (value: string): SExprSerializable => {
    // Return a special marker that will always be quoted
    return { [QUOTED_MARKER]: value };
  },
  string: (value: string): SExprSerializable => {
    // Return a special marker that will always be quoted
    return { [FORCE_QUOTED_STRING_MARKER]: value };
  },
  expr: (head: string | SExprSerializable, ...args: SExprSerializable[]): SExprSerializable => {
    // Return a structure that will be serialized as an expression
    return { [EXPR_MARKER]: true, head, args };
  },
  tagged: (tag: string, value: string): SExprSerializable => {
    // Clojure-style tagged literal: #tag "value"
    return { [TAGGED_MARKER]: tag, value };
  },
};

/**
 * Convert any value to an s-expression representation
 */
export function toSExpr(obj: any, visited: Set<any> = new Set()): SExpr {
  // null/undefined
  if (obj === null || isNil(obj)) return "nil";
  if (obj === undefined) return "undefined";

  // Cycle detection is a DFS path-set: add on enter, delete on exit (the `finally`),
  // so a value legitimately reused across SIBLING branches isn't a false cycle, while a
  // genuine back-edge (an ancestor still on the stack) is. This walks the tree in O(n) —
  // the previous `new Set(visited_)` clone-per-node was O(n²) on deep/wide structures.
  const track = typeof obj === "object" && obj !== null && !isNil(obj);
  if (track) {
    if (visited.has(obj)) {
      if (typeof obj[Symbol.SExpr] === "function" && "uuid" in obj) {
        return ["circular-reference-to", [obj[Symbol.SExpr], toSExpr(obj.uuid)]];
      } else {
        console.error("circular reference found while serializing", obj);
        throw new Error("Circular reference detected");
      }
    }
    visited.add(obj);
  }

  try {
    return toSExprDispatch(obj, visited);
  } finally {
    if (track) visited.delete(obj);
  }
}

/**
 * Dispatch a value to its s-expression form. Always called by toSExpr with `obj`
 * already registered in `visited` (the cycle path-set), so recursive calls share
 * one set rather than cloning it at every node.
 */
function toSExprDispatch(obj: any, visited: Set<any>): SExpr {
  // Handle special marker objects from context helpers
  if (obj && typeof obj === "object") {
    if (EXPR_MARKER in obj) {
      // Expression created by context.expr
      const expr = obj as any;
      return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
    }
    if (QUOTED_MARKER in obj) {
      // Quoted string created by context.quote - wrap to force quoting
      return { [QUOTED_MARKER]: obj[QUOTED_MARKER] };
    }
    if (FORCE_QUOTED_STRING_MARKER in obj) {
      // Quoted string created by context.quote - wrap to force quoting
      return { [FORCE_QUOTED_STRING_MARKER]: obj[FORCE_QUOTED_STRING_MARKER] };
    }
    if (TAGGED_MARKER in obj) {
      // Tagged literal — pass through
      return obj;
    }
  }

  // Handle LIPS-specific types before generic Symbol.toSExpr
  if (obj && typeof obj === "object") {
    // SchemeExact (exact integers/rationals)
    if (obj.constructor?.name === "SchemeExact" && "num" in obj && "denom" in obj) {
      if (obj.denom === 1n) {
        const value = obj.num as bigint;
        if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
          return `${value.toString()}`;
        }
        return Number(value);
      }
      // Rational: num/denom
      return `${obj.num}/${obj.denom}`;
    }

    // SchemeInexact (floats/complex)
    if (obj.constructor?.name === "SchemeInexact" && "real" in obj) {
      if ("imag" in obj && obj.imag !== 0) {
        return `${obj.real}+${obj.imag}i`;
      }
      return obj.real;
    }

    // SchemeSymbol
    if (obj.constructor?.name === "SchemeSymbol" && "__name__" in obj) {
      return obj.__name__; // Return symbol name as-is (includes : for keywords)
    }

    // SchemeString
    if (obj.constructor?.name === "SchemeString" && "__string__" in obj) {
      const str = capString(obj.__string__);
      // Use template strings for complex strings (multi-line, quotes, etc.)
      if (str.includes(String.raw`\n`) || str.includes(String.raw`\t`) || str.includes('"') || str.includes("'")) {
        return `\`${str}\``;
      }
      // Use single quotes for simple strings
      return `'${str}'`;
    }

    // SchemeCharacter
    if (obj.constructor?.name === "SchemeCharacter" && "__char__" in obj) {
      return `#\\${obj.__char__}`; // Return character with #\ prefix
    }

    // LIPS Values (multiple return values)
    if (obj.constructor?.name === "Values" && "__values__" in obj) {
      // Convert to array of values
      return ["values", ...capItems(obj.__values__, (v: any) => toSExpr(v, visited))];
    }

    // LIPS Pair (linked list structure)
    if (obj.constructor?.name === "Pair" && "car" in obj && "cdr" in obj) {
      return ["list", ...convertLipsPairToArray(obj, visited)];
    }

    // LIPS Nil (empty list) - be more specific to avoid catching plain objects
    if (obj.constructor?.name === "Nil") {
      return []; // Return empty list
    }

    // LIPS EOF (end of file marker)
    if (obj.constructor?.name === "EOF") {
      return "#<eof>";
    }

    // LIPS Macro (macro objects)
    if (obj.constructor?.name === "Macro") {
      return ["macro", obj.name || "<anonymous>"];
    }

    // LIPS Syntax (special syntax objects)
    if (obj.constructor?.name === "Syntax") {
      return ["syntax", obj.name || "<syntax>"];
    }

    // LIPS Input/Output Ports
    if (obj.constructor?.name === "InputPort" || obj.constructor?.name === "OutputPort") {
      return `#<${obj.constructor.name.toLowerCase()}>`;
    }
  }

  // Has custom serialization with Symbol.toSExpr
  if (obj && typeof obj === "object" && (obj as any)[Symbol.toSExpr]) {
    const displayName =
      obj[Symbol.SExpr]?.() ?? obj.displayName ?? obj.constructor.displayName ?? obj.name ?? obj.constructor.name;
    const contents = obj[Symbol.toSExpr](serializationContext);

    // Convert contents to arrival
    const processedContents = contents.map((item: any) => processItem(item, visited));

    return [displayName, ...processedContents];
  }

  // Already an s-expression (tagged array)
  if (Array.isArray(obj) && obj[0] === SEXPR_TAG) {
    const [_, head, ...args] = obj;
    return [toSExpr(head, visited), ...args.map((arg) => toSExpr(arg, visited))];
  }

  // Symbol → :keyword
  if (typeof obj === "symbol") {
    const name = obj.description || obj.toString().slice(7, -1);
    return `:${name}`;
  }

  // Array → (list ...)
  if (Array.isArray(obj)) {
    return ["list", ...capItems(obj, (item) => toSExpr(item, visited))];
  }

  // Function → skip or placeholder
  if (typeof obj === "function") {
    return "<function>";
  }

  // Date → ISO string
  if (obj instanceof Date) {
    return obj.toISOString();
  }

  // Map → convert to object-like representation
  if (obj instanceof Map) {
    const all = [...obj];
    const entries: SExpr[] = [];
    for (const [key, value] of all.slice(0, activeCaps.maxItems)) {
      entries.push(`:${String(key)}`, toSExpr(value, visited));
    }
    if (all.length > activeCaps.maxItems) entries.push(truncatedMarker(`+${all.length - activeCaps.maxItems} more of ${all.length}`));
    return ["map", ...entries];
  }

  // Set → convert to list
  if (obj instanceof Set) {
    return ["set", ...capItems([...obj], (item) => toSExpr(item, visited))];
  }

  // AValue with empty provenance carries no lineage to show — serialize its
  // plain value (`toJs()`), not the internal {provenance, kind, source}
  // envelope. (A non-empty provenance keeps the envelope, by design.)
  if (
    typeof obj === "object" &&
    obj !== null &&
    obj.provenance instanceof Set &&
    obj.provenance.size === 0 &&
    typeof obj.toJs === "function" &&
    typeof obj.kind === "string"
  ) {
    return toSExpr(obj.toJs(), visited);
  }

  // Plain object → dict literal `(dict :k v …)`
  if (typeof obj === "object" && obj !== null) {
    const all = Object.entries(obj).filter(([, value]) => typeof value !== "function");
    const entries: SExpr[] = [];
    for (const [key, value] of all.slice(0, activeCaps.maxItems)) {
      entries.push(`:${key}`, toSExpr(value, visited));
    }
    if (all.length > activeCaps.maxItems) entries.push(truncatedMarker(`+${all.length - activeCaps.maxItems} more of ${all.length}`));
    return ["dict", ...entries];
  }

  // Primitives (string, number, boolean) — a long string primitive is capped too.
  if (typeof obj === "string") return capString(obj);
  return obj;
}

/**
 * Format s-expression to string with proper formatting
 */
export function formatSExpr(sexpr: SExpr, indent = 0): string {
  if (Array.isArray(sexpr)) {
    if (sexpr.length === 0) return "()";

    const [head, ...tail] = sexpr;

    // Special handling for dict literals — the canonical open-key map form
    // `(dict :k v …)` (homoiconic, round-trips via the `dict` constructor).
    if (head === "dict") {
      if (tail.length === 0) return "(dict)";

      const pairs: string[] = [];
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);
          pairs.push(`${key} ${value}`);
        }
      }

      return `(dict ${pairs.join(" ")})`;
    }

    // First element (operator) is never quoted, even if it's a string
    const strHead =
      typeof head === "string" && !head.startsWith(":")
        ? head // Operators are unquoted
        : formatSExpr(head, 0);

    // Special formatting for maps
    if (head === "map") {
      const spaces = " ".repeat(indent);
      const pairs: string[] = [];

      // Process key-value pairs
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);

          // Check if value needs to be on new line
          const valueItem = tail[i + 1];
          const isComplexValue = Array.isArray(valueItem) || (typeof valueItem === "string" && valueItem.length > 40);

          if (isComplexValue) {
            const formattedValue = formatSExpr(tail[i + 1], indent + 2 + key.length + 1);
            pairs.push(`${key} ${formattedValue}`);
          } else {
            pairs.push(`${key} ${value}`);
          }
        }
      }

      // Keep simple maps on one line
      const totalLength = pairs.reduce((sum, p) => sum + p.length, 0) + pairs.length * 2;
      if (pairs.length <= 2 && totalLength < 60) {
        return `(${strHead} ${pairs.join(" ")})`;
      }

      // Multi-line for complex maps
      return `(${strHead}\n${pairs.map((p) => `${spaces}  ${p}`).join("\n")})`;
    }

    // Special handling for special values
    if (strHead === "<function>") {
      return "<function>";
    }

    // Handle unquoted symbols (from context.symbol)
    if (typeof head === "string" && !head.startsWith(":") && !head.startsWith('"')) {
      // Check if this looks like a symbol that shouldn't be quoted
      const isSymbol = tail.some((item) => typeof item === "string" && !item.startsWith(":") && !item.includes(" "));
      if (isSymbol && (head === "Stateful" || head === "Calculator")) {
        // These are known to use symbols
        const formattedTail = tail
          .map((item) => {
            if (typeof item === "string" && !item.startsWith(":") && !item.includes(" ")) {
              return item; // Don't quote symbols
            }
            return formatSExpr(item, 0);
          })
          .join(" ");
        return `(${strHead} ${formattedTail})`;
      }
    }

    // Special formatting for specific operators
    if (
      head === "reference" ||
      head === "definition" ||
      head === "diagnostic" ||
      head === "symbol" ||
      head === "type" ||
      head === "list"
    ) {
      // Keep these on one line unless they have very long string values
      const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));

      const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);

      if (!hasLongString && !hasComplexStructure) {
        const strTail = tail.map((item) => formatSExpr(item, 0)).join(" ");
        return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
      }
    }

    // Check if it's simple enough for one line
    const isSimple =
      tail.length <= 3 && tail.every((item) => !Array.isArray(item) || (Array.isArray(item) && item.length <= 2));

    if (isSimple) {
      // Single line for simple expressions
      const strTail = tail.map((item) => formatSExpr(item, 0)).join(" ");
      return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
    } else {
      // Multi-line for complex expressions.
      const spaces = " ".repeat(indent);
      const isKey = (x: unknown): boolean => typeof x === "string" && (x as string).startsWith(":");
      const strTail = tail
        .map((item, index) => {
          const formatted = formatSExpr(item, indent + 2);

          // A `:key` groups with the NEXT item only when that item is a real VALUE
          // (not another keyword). Consecutive keywords are standalone flags — e.g.
          // ParamView's `:text :writable :property` — and must NOT be skipped, or the
          // leading flags get silently dropped (the value-pairing never fires for them).
          if (isKey(item) && index + 1 < tail.length) {
            const nextItem = tail[index + 1];
            const nextFormatted = formatSExpr(nextItem, 0);
            if (!isKey(nextItem) && !Array.isArray(nextItem) && nextFormatted.length < 40) {
              return null; // the value (next item) carries this key on its own line, below
            }
          }

          // Emit a `:key value` pair: the preceding key was skipped above, so the
          // value carries it — but only when THIS item is a value (not itself a keyword).
          if (index > 0 && isKey(tail[index - 1]) && !isKey(item) && !Array.isArray(item) && formatted.length < 40) {
            return `${spaces}  ${formatSExpr(tail[index - 1], 0)} ${formatted}`;
          }

          // A list that starts on the same line: no extra indent.
          if (Array.isArray(item) && formatted.startsWith("(")) {
            return `${spaces}  ${formatted}`;
          }

          return `${spaces}  ${formatted}`;
        })
        .filter((line) => line !== null)
        .join("\n");

      return strTail ? `(${strHead}\n${strTail})` : `(${strHead})`;
    }
  }

  // Truncation marker → a `#| … |#` block comment, so the surrounding form still PARSES
  // (the comment is ignored, the form round-trips to the shown sample).
  if (sexpr && typeof sexpr === "object" && TRUNCATED_MARKER in sexpr) {
    return `#| ${(sexpr as Record<symbol, string>)[TRUNCATED_MARKER]} |#`;
  }

  // Handle force-quoted marker (must be checked before typeof === "string")
  if (sexpr && typeof sexpr === "object" && QUOTED_MARKER in sexpr) {
    const value = (sexpr as any)[QUOTED_MARKER];
    return /^[a-z_>?!][\w>?!-]*$/i.test(value) ? `'${value}` : `'|${value}|`;
  }

  // Handle force-quoted marker (must be checked before typeof === "string")
  if (sexpr && typeof sexpr === "object" && FORCE_QUOTED_STRING_MARKER in sexpr) {
    const value = (sexpr as any)[FORCE_QUOTED_STRING_MARKER];
    return `"${value.replaceAll('"', String.raw`\"`)}"`;
  }

  // Handle tagged literal: #tag "value" (Clojure-style)
  if (sexpr && typeof sexpr === "object" && TAGGED_MARKER in sexpr) {
    const { value } = sexpr as any;
    const tag = (sexpr as any)[TAGGED_MARKER];
    return `#${tag} "${value.replaceAll('"', String.raw`\"`)}"`;
  }

  // Format primitives
  if (typeof sexpr === "string") {
    // Keywords (starting with :) don't need quotes
    if (sexpr.startsWith(":")) return sexpr;
    // nil and undefined are special
    if (sexpr === "nil" || sexpr === "undefined") return sexpr;
    // Special values
    if (sexpr === "<function>") return sexpr;
    // BigInt notation (ends with n) - don't quote
    if (sexpr.endsWith("n") && /^\d+n$/.test(sexpr)) return sexpr;
    // Template strings (wrapped in backticks) - don't quote
    if (sexpr.startsWith("`") && sexpr.endsWith("`")) return sexpr;
    // Single-quoted strings - don't quote (already quoted)
    if (sexpr.startsWith("'") && sexpr.endsWith("'")) return sexpr;
    // Character literals (start with #\) - don't quote
    if (sexpr.startsWith("#\\")) return sexpr;
    // Bare symbols (no quotes, no special chars) - don't quote
    if (/^[a-z][\w-]*$/i.test(sexpr)) return sexpr;
    // All other strings are quoted
    return `"${sexpr.replaceAll('"', String.raw`\"`)}"`;
  }

  if (typeof sexpr === "number" || typeof sexpr === "bigint") {
    return String(sexpr);
  }

  if (typeof sexpr === "boolean") {
    return sexpr ? "true" : "false";
  }

  if (sexpr === null) {
    return "nil";
  }

  throw new Error(`Unknown s-expression type: ${typeof sexpr}`);
}

// Convert LIPS Pair linked list to JavaScript array
function convertLipsPairToArray(pair: any, visited: Set<any>): SExpr[] {
  const result: SExpr[] = [];
  let current = pair;
  let shown = 0;

  while (current && current.constructor?.name === "Pair") {
    // Cap hit: cheap-count the rest (cdr walk, NO serialize) for the marker, then stop —
    // the tail of a thousand-element list is never serialized.
    if (shown >= activeCaps.maxItems) {
      let rest = 0;
      let c: any = current;
      while (c && c.constructor?.name === "Pair") {
        rest++;
        c = c.cdr;
      }
      result.push(truncatedMarker(`+${rest} more of ${shown + rest}`));
      current = c;
      break;
    }

    // Add car (current element) to result
    result.push(toSExpr(current.car, visited));
    shown++;

    // Move to cdr (next element)
    current = current.cdr;

    // Handle circular references
    if (current && typeof current === "object" && visited.has(current)) {
      throw new Error("Circular reference in LIPS Pair");
    }
  }

  // If cdr is not null/empty, it's an improper list (rare in practice)
  if (current && !isNil(current) && !(current.constructor?.name === "Object" && Object.keys(current).length === 0)) {
    // This would be a dotted pair notation in Scheme, but we'll just add it to the array
    result.push(toSExpr(current, visited));
  }

  return result;
}

// Helper to process items from Symbol.toSExpr
function processItem(item: any, visited: Set<any>): SExpr {
  // Handle special serializable values from context helpers
  if (item && typeof item === "object" && EXPR_MARKER in item) {
    // Expression created by context.expr
    const expr = item as any;
    return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
  }
  if (item && typeof item === "object" && QUOTED_MARKER in item) {
    // Quoted string created by context.quote - wrap to force quoting
    return { [QUOTED_MARKER]: (item as any)[QUOTED_MARKER] };
  }
  if (item && typeof item === "object" && TAGGED_MARKER in item) {
    return item; // Tagged literal — pass through
  }
  if (Array.isArray(item) && item[0] === SEXPR_TAG) {
    const [_, head, ...args] = item;
    return toSExpr([head, ...args], visited);
  }
  return toSExpr(item, visited);
}

/**
 * Convert to s-expression and format as string
 */
const DEFAULT_TOTAL = 40_000;
const FLOOR_ITEMS = 3;
const FLOOR_STRING = 80;

/**
 * Serialize a value to a formatted s-expression string.
 *
 * Truncation is OPT-IN: pass `SerializeOpts` to bound the output (the MCP path does,
 * via `maxTotalChars`); a bare indent number (or no second arg) renders uncapped, as
 * before — studio views and existing callers are unaffected. With caps set, per-element
 * limits apply STREAMING (the tail of a huge collection is never serialized), and if the
 * result still exceeds `maxTotalChars` the limits SHRINK fairly and re-render — never a
 * tail-cut that would gut a sibling (e.g. PSSCAN in a `(list PSLIST PSSCAN)` diff).
 */
export const toSExprString = (obj: any, optsOrIndent: number | SerializeOpts = 0): string => {
  const opts: SerializeOpts = typeof optsOrIndent === "number" ? { indent: optsOrIndent } : optsOrIndent;
  const indent = opts.indent ?? 0;

  // No caps requested → unchanged behaviour.
  if (opts.maxItems == null && opts.maxStringChars == null && opts.maxTotalChars == null) {
    return formatSExpr(toSExpr(obj), indent);
  }

  const maxTotalChars = opts.maxTotalChars ?? DEFAULT_TOTAL;
  let maxItems = opts.maxItems ?? 100;
  let maxStringChars = opts.maxStringChars ?? 2_000;

  const render = (): string => {
    activeCaps = { maxItems, maxStringChars };
    try {
      return formatSExpr(toSExpr(obj), indent);
    } finally {
      activeCaps = NO_CAPS;
    }
  };

  let out = render();
  let squeezed = false;
  // Shrink-to-fit: tighten BOTH caps toward the floor and re-render. Each pass is itself
  // capped, so a re-run never re-walks a huge tail. Fair across siblings — no tail-cut.
  while (out.length > maxTotalChars && (maxItems > FLOOR_ITEMS || maxStringChars > FLOOR_STRING)) {
    const factor = Math.min(0.9, maxTotalChars / out.length);
    maxItems = Math.max(FLOOR_ITEMS, Math.floor(maxItems * factor));
    maxStringChars = Math.max(FLOOR_STRING, Math.floor(maxStringChars * factor));
    out = render();
    squeezed = true;
  }

  // Floor still over budget (pathological nesting) → hard-cut the CONTENT as the genuine
  // last resort, before the note (so a successful squeeze isn't chopped by the note's length).
  if (out.length > maxTotalChars) {
    out = `${out.slice(0, maxTotalChars)}\n#| … output hard-truncated at ${maxTotalChars} chars |#`;
  }
  if (squeezed) {
    out = `#| ⚠ output reduced to fit response budget (request too large): showing ≤${maxItems} items per collection, ≤${maxStringChars} chars per string |#\n${out}`;
  }
  return out;
};

/**
 * Helper to create s-expression definitions
 */
export const sexpr = (tag: string, ...args: any[]): SExprDefinition => [SEXPR_TAG, tag, ...args];

/**
 * Helper to create a map from object
 */
export const smap = (obj: Record<string, any>): SExprDefinition => [SEXPR_TAG, "dict", ...Object.entries(obj).flatMap(([k, v]) => [`:${k}`, v])];

/**
 * Helper to create a list
 */
export const slist = (...items: any[]): SExprDefinition => [SEXPR_TAG, "list", ...items];
