import { parse as parseToml } from "smol-toml";
import invariant from "tiny-invariant";
import { parse as parseYaml } from "yaml";

import type { Project } from "./project.js";

/**
 * Data-format parsers — each takes the file's text and returns a JSON-
 * shaped value the scheme runtime can consume via `json/parse`. New
 * formats slot in here without touching the scheme runtime, because the
 * eventual call is always `(json/parse "<canonicalised JSON>")`.
 */
const DATA_PARSERS: Record<string, (text: string) => unknown> = {
  ".json": (text) => JSON.parse(text),
  ".yaml": (text) => parseYaml(text),
  ".yml": (text) => parseYaml(text),
  ".toml": (text) => parseToml(text),
  ".ndjson": (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)),
};

function dataExt(path: string): string | null {
  for (const ext of Object.keys(DATA_PARSERS)) {
    if (path.endsWith(ext)) return ext;
  }
  return null;
}

/**
 * Resolver function: take a `(require "<path>")` literal and return the
 * file's source. Used to override the default Project VFS lookup —
 * e.g. the CLI's `--file` mode resolves against the disk relative to
 * the entry file's directory, so the entry program can `(require
 * "./helpers.scm")` without polluting any synced project doc.
 */
export type RequireResolver = (path: string) => string;

const REQUIRE_RE = /\(require\s+"([^"]+)"\)/g;

/** `_lib.scm` → `_lib`, `data.json` → `data`. */
function pathToIdent(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function makeProjectResolver(project: Project): RequireResolver {
  return (path) => {
    const file = project.files.get(path);
    invariant(file, `require: file not found in project: ${path}`);
    const latest = file.versions.at(-1);
    invariant(latest, `require: file has no versions: ${path}`);
    return latest.source;
  };
}

/**
 * Walk the require graph from `source` and produce a preamble + transformed body:
 *
 *   .scm  → file's source is spliced in (its own requires expanded first);
 *           top-level `define`s spill into the calling env; the (require …)
 *           call is stripped from the body.
 *   .txt  → `(define <name> "<content>")` binding; call stripped.
 *   .json/.yaml/.yml/.toml/.ndjson →
 *           parsed at resolve-time and re-emitted as canonical JSON, so
 *           the scheme runtime sees a uniform `(define <name>
 *           (json/parse "<canonicalised>"))`. New data formats slot in
 *           via `DATA_PARSERS` above without touching the runtime.
 *   .hbs  → the (require …) CALL ITSELF is rewritten in place to a lambda
 *           literal: `(lambda args (template/handlebars "<src>" args))`.
 *           Users wrap it with their own name:
 *             (define en-to-fr (require "en-to-fr.hbs"))
 *             (en-to-fr phrase)
 *           or invoke inline:
 *             ((require "en-to-fr.hbs") phrase)
 *
 * Each unique non-hbs path is included once. Cycles throw.
 */
export function resolveRequires(
  project: Project,
  source: string,
  resolver?: RequireResolver,
): { preamble: string; body: string } {
  const read = resolver ?? makeProjectResolver(project);
  const included = new Set<string>();
  const segments: string[] = [];

  const rewrite = (text: string, stack: ReadonlySet<string>): string =>
    text.replaceAll(REQUIRE_RE, (_match, path: string) => {
      if (path.endsWith(".hbs")) {
        // Inline-callable: rewrite the call site to a lambda literal. No
        // preamble binding — the user names it (or invokes inline).
        const content = read(path);
        return `(lambda args (template/handlebars ${JSON.stringify(content)} args))`;
      }
      if (!included.has(path)) {
        invariant(!stack.has(path), `require: cyclic dependency: ${[...stack, path].join(" → ")}`);
        const content = read(path);
        const next = new Set(stack).add(path);
        if (path.endsWith(".scm")) {
          const expanded = rewrite(content, next);
          included.add(path);
          segments.push(expanded);
        } else {
          const ext = dataExt(path);
          if (ext) {
            // Parse with the format-specific parser, then re-serialise to
            // canonical JSON. The scheme runtime always sees `json/parse`.
            const parsed = DATA_PARSERS[ext]!(content);
            const canonical = JSON.stringify(parsed);
            included.add(path);
            segments.push(`(define ${pathToIdent(path)} (json/parse ${JSON.stringify(canonical)}))`);
          } else {
            included.add(path);
            segments.push(`(define ${pathToIdent(path)} ${JSON.stringify(content)})`);
          }
        }
      }
      return ""; // strip the require call from the body
    });

  const body = rewrite(source, new Set());
  return { preamble: segments.join("\n") + (segments.length > 0 ? "\n" : ""), body };
}
