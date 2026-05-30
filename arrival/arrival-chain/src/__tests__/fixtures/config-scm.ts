/**
 * Test helper: build a `config.scm` source from a flat key→value map.
 *
 * Config-as-code replaces the old `project/<key>` env mechanism: instead of
 * injecting values host-side via `runPipeline({ env: {...} })`, a program
 * `(require "config.scm")`s a file of `(define config/<name> <literal>)`
 * forms, which spill the bindings into the run env. The `/` in `config/<name>`
 * is an ordinary symbol char (LIPS allows it, like `infer/chat`), so a program
 * references `config/<name>` like any other binding.
 *
 * Each entry of `values` becomes one `(define config/<key> <literal>)` line.
 * Scheme literals: strings → `"..."` (JSON-escaped), numbers → bare,
 * booleans → `#t`/`#f`. This is the inverse of what the env-injection path
 * used to do; the key (formerly the env path's single segment) becomes the
 * trailing name of the `config/<key>` symbol.
 */
export function configScm(values: Record<string, string | number | boolean>): string {
  return Object.entries(values)
    .map(([key, value]) => `(define config/${key} ${schemeLiteral(value)})`)
    .join("\n");
}

/** A single JS primitive rendered as its scheme literal form. */
export function schemeLiteral(value: string | number | boolean): string {
  switch (typeof value) {
    case "string":
      // JSON.stringify gives a correctly-escaped double-quoted string, which
      // is also a valid scheme string literal (same escape rules for the
      // characters we use: quotes, backslashes, newlines).
      return JSON.stringify(value);
    case "number":
      return String(value);
    case "boolean":
      return value ? "#t" : "#f";
  }
}
