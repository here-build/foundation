# @here.build/arrival-sweet

The sweet-expression lens over Arrival scheme source. A bidirectional view that
renders stored canonical s-expressions as a readable "sweet" form and folds an
edited sweet view back to canonical scheme.

The sweet form trades parentheses for surface familiar to JS/Lisp readers:

- **curly-infix** — `{ it * 2 }` for `(* it 2)`
- **method-dot chains** — `xs.map{ it * 2 }` for `(map (lambda (it) (* it 2)) xs)`
- **`=>` lambda** — `(y) => y` for `(lambda (y) y)`
- **colon kwargs** — `:key value` keyword arguments
- **`??` coalesce** — null-coalescing surface
- **accessor subscripts** — `it[:verdict][0]` for `(car (:verdict it))`

It is a **zero-dependency leaf**: it carries its own s-expression parser and
the `.` entry point pulls in only `tiny-invariant`. The `./names` subpath adds
`@here.build/lexical-namer` and `pluralize` for bound-name recovery, and is
tree-shaken away from `.` consumers that don't use it. It does NOT depend on the
Arrival eval engine. It is consumed by the studio editor
toggle, the CodeMirror integration, the chain-view compiler, sift's lowering,
and provenance region-label rendering — none of which need to evaluate scheme.

## Install

```bash
pnpm add @here.build/arrival-sweet
```

## Usage

```ts
import { schemeToSweet, sweetToScheme } from "@here.build/arrival-sweet";

const classic = "(map (lambda (it) (* it 2)) xs)";

const sweet = schemeToSweet(classic);
// → "xs.map{ it * 2 }"

// Fold an edited sweet buffer back to canonical scheme. The previous classic
// source is passed so unchanged forms round-trip byte-for-byte.
const back = sweetToScheme(sweet, classic);
// → "(map (lambda (it) (* it 2)) xs)"
```

The classic↔sweet mapping round-trips: rendering a form and reading it back
yields the original (`sweetToScheme(schemeToSweet(x), x) ≡ x`).

## Surface

The `.` entry point exports the lens:

- `schemeToSweet(src, opts?)` — render canonical scheme source as sweet text.
- `sweetToScheme(sweetText, prevClassic, opts?)` / `readSweet` — fold an edited
  sweet view back to canonical scheme.
- `parseSexprs` / `printScheme` — the bundled s-expr parser and the canonical
  pretty-printer (`parseSexprs(printScheme(f)) ≡ f`).
- `alignSweetClassic` — span-pair alignment between the two views (cursor /
  selection mapping for editors).
- `paramHints` / `paramHintsSweet` — positional argument-name inlay hints.
- `inlineSweet` / `formatSweet`, kwarg (de)sugaring, `nodeEq`, `DEFAULT_OPTS` —
  lower-level render primitives some tools reach for directly.
- `decodeAccessor` / `encodeAccessor` — the single decomposition of a `c[ad]+r`
  accessor word, shared by the renderer, reader, and chain-view compiler.

The `./names` subpath exports bound-name recovery (`tidyBoundNames`,
`boundNameHints`) and is tree-shaken away from `.` consumers that don't need it.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build
