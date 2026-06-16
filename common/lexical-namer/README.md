# @here.build/lexical-namer

Priority-based name assignment, flat and lexically-scoped. One resolution
algorithm exposed through two public APIs over the same core:

```
assignNames          : flat pool, one resolution pass
resolveLexicalNames  : tree of pools, one pass per scope,
                       with parent-chain reservations folded in
```

`assignNames` is a thin adapter over the scope resolver — it builds a single
childless root scope and delegates, so there is exactly ONE algorithm to reason
about. Use it for CSS classes or any single-namespace pool. Use
`resolveLexicalNames` for JS identifiers and other lexically-scoped namespaces.

## Concepts

- **Scope tree** — input is a `ScopeSpec<E>` whose `children` recursively form
  the tree. Each scope has its own reservations and entities.
- **Parent-chain visibility** — a name claimed in scope `S` is visible
  (reserved) in any descendant of `S`, but NOT in siblings.
- **Sibling independence** — two siblings can independently assign the same
  name; their resolutions don't see each other.
- **Priority ladders** — each entity offers a `Record<priority, candidate>`
  ladder; higher priority wins, collisions fall to the next rung.
- **Per-scope tie semantics** — `onTie: "burn" | "free" | "postfix"` controls
  what happens to a bare name contested at one tier: burn it for lower tiers,
  leave it claimable, or postfix all tied entities immediately.

## API

```ts
import { resolveLexicalNames, type ScopeSpec } from "@here.build/lexical-namer";

const root: ScopeSpec<string> = {
  id: "root",
  entities: [
    { key: "a", candidates: { 100: "open", 80: "openState" } },
    { key: "b", candidates: { 100: "open", 80: "openFlag" } },
  ],
};

const result = resolveLexicalNames(root, {
  postfixFor: (key) => key, // must be injective across the entity set
  resolveTie: (name, postfix) => `${name}_${postfix}`, // JS-friendly
  onTie: "burn",
});

result.assignments.get("a"); // → assigned name (e.g. "openState")
```

For a single flat namespace (CSS classes, etc.), reach for `assignNames`
instead — same candidate ladders, one pool, `onTie: "postfix"` by default.

See `src/index.ts` for the full type surface and `src/__tests__/resolver.test.ts`
for the contract.

## Status

Shipped and tested. The resolver (`resolveLexicalNames` plus the `assignNames`
adapter) is fully implemented; 170 tests across 5 files pass
(`pnpm -F @here.build/lexical-namer test`).

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build
