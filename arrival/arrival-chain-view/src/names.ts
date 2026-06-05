/**
 * Identifier naming. v1 is the `cleanName` base of the ladder defined in
 * `docs/proposals/in-flight/lexical-js-naming.md` — kebab→camel, drop predicate
 * `?` / mutate `!`, lower `->`, escape reserved words. It is a PURE function of
 * the scheme name, position-independent, so for a collision-free program (every
 * example chain so far) it is exactly the name the full namer would assign at
 * T100.
 *
 * The collision-resolution upgrade — running `@here.build/lexical-namer` over a
 * scope tree so two bindings that clean to the same JS name in overlapping scopes
 * get a deterministic `${name}_${postfix}` — slots in here without touching the
 * lowering pass (it only changes what `cleanName` returns per binding). See the
 * package SPEC §7. Tracked as its own task.
 */

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "enum", "await", "async", "implements", "interface", "package",
  "private", "protected", "public", "arguments", "eval",
]);

/**
 * Scheme identifier → JS identifier. Pure, total, deterministic.
 *   run-predict  → runPredict
 *   dominates?   → dominates
 *   string->list → stringToList
 *   set-x!       → setX
 */
export function cleanName(scheme: string): string {
  let s = scheme;
  s = s.replace(/->/g, "-to-"); // string->list → string-to-list
  s = s.replace(/[?!]/g, ""); // predicate? / mutate! markers carry no JS meaning
  s = s.replace(/\*/g, ""); // earmuffed *globals*
  s = s.replace(/[^a-zA-Z0-9_-]/g, "-"); // any other punctuation → separator
  s = s.replace(/[-_]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase()); // kebab/snake → camel
  s = s.replace(/[-_]+$/g, ""); // trailing separators
  if (s === "") s = "_";
  if (/^[0-9]/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}
