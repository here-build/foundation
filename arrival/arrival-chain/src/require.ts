import invariant from "tiny-invariant";

import type { Project } from "./project.js";

const REQUIRE_RE = /\(require\s+"([^"]+)"\)/g;

/** `_lib.scm` → `_lib`, `data.json` → `data`. */
function pathToIdent(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function readFile(project: Project, path: string): string {
  const file = project.files.get(path);
  invariant(file, `require: file not found in project: ${path}`);
  const latest = file.versions.at(-1);
  invariant(latest, `require: file has no versions: ${path}`);
  return latest.source;
}

/**
 * Walk the require graph from `source` and produce a preamble + transformed body:
 *
 *   .scm  → file's source is spliced in (its own requires expanded first);
 *           top-level `define`s spill into the calling env; the (require …)
 *           call is stripped from the body.
 *   .txt  → `(define <name> "<content>")` binding; call stripped.
 *   .json → `(define <name> (json/parse "<content>"))` binding; call stripped.
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
export function resolveRequires(project: Project, source: string): { preamble: string; body: string } {
  const included = new Set<string>();
  const segments: string[] = [];

  const rewrite = (text: string, stack: ReadonlySet<string>): string =>
    text.replace(REQUIRE_RE, (_match, path: string) => {
      if (path.endsWith(".hbs")) {
        // Inline-callable: rewrite the call site to a lambda literal. No
        // preamble binding — the user names it (or invokes inline).
        const content = readFile(project, path);
        return `(lambda args (template/handlebars ${JSON.stringify(content)} args))`;
      }
      if (!included.has(path)) {
        invariant(!stack.has(path), `require: cyclic dependency: ${[...stack, path].join(" → ")}`);
        const content = readFile(project, path);
        const next = new Set(stack).add(path);
        if (path.endsWith(".scm")) {
          const expanded = rewrite(content, next);
          included.add(path);
          segments.push(expanded);
        } else if (path.endsWith(".json")) {
          included.add(path);
          segments.push(`(define ${pathToIdent(path)} (json/parse ${JSON.stringify(content)}))`);
        } else {
          included.add(path);
          segments.push(`(define ${pathToIdent(path)} ${JSON.stringify(content)})`);
        }
      }
      return ""; // strip the require call from the body
    });

  const body = rewrite(source, new Set());
  return { preamble: segments.join("\n") + (segments.length ? "\n" : ""), body };
}
