/**
 * Lexical-scope-aware name assignment.
 *
 * Generalizes {@link @here.build/priority-namer} from "one flat pool" to
 * "tree of nested scopes." Each scope runs its own priority-resolution pass
 * with reservations propagated down the parent chain. Sibling scopes don't
 * see each other's claims — same name can occupy two disjoint scopes.
 *
 * Domain-agnostic: usable for JS identifiers, CSS custom properties, or any
 * lexically-scoped namespace. The caller maps domain entities to opaque
 * keys and supplies prioritized candidate ladders; this module owns the
 * tree resolution algorithm.
 *
 * Composition with priority-namer:
 *   priority-namer  : flat pool, one resolution pass
 *   lexical-namer   : tree of pools, one priority-namer pass per scope,
 *                     with parent-chain reservations folded in
 */

import invariant from "tiny-invariant";

/**
 * One node in the lexical scope tree.
 *
 * Reservations and assigned names propagate to descendants but not to
 * siblings. A descendant cannot reuse an ancestor's name; two siblings can
 * independently assign the same name.
 */
export interface ScopeSpec<E> {
  /**
   * Optional identifier — used for per-scope result lookup
   * ({@link ResolveResult.claimsByScope}, {@link ResolveResult.burnedByScope})
   * and as a debugging aid in error messages. When omitted, the scope is
   * still processed but results aren't keyed by it.
   */
  readonly id?: string;

  /**
   * Names that cannot be claimed at this scope or any descendant. Propagates
   * DOWN to children. Use for pre-known external names: framework imports,
   * language keywords, user-referenced free vars from embedded user code,
   * sigil-private prefixes.
   */
  readonly reservations?: readonly string[];

  /**
   * Names DECLARED by user code at this scope. Distinct from `reservations`
   * because user-declarations propagate UPWARD: any ancestor of this scope
   * also treats these names as blocked. This prevents our codegen at outer
   * scopes from allocating a name that user code declares below — which
   * would be a slot-injection hazard if any of our refs flow into the user-
   * declared scope and get shadowed.
   *
   * Strategy populates this by AST-scanning user CustomCode for declarations
   * (const, let, var, function params, class methods, etc.) at the scope
   * where the user code lands.
   *
   * Free *references* (vars used but not declared) belong in `reservations`
   * at the scope where the user code lands — they don't propagate upward.
   */
  readonly userDeclarations?: readonly string[];

  /**
   * Entities competing for names at this scope level.
   * Iteration order does NOT affect output (uses caller-supplied
   * `compareEntities` / `postfixFor` for stability).
   */
  readonly entities?: readonly ScopedEntity<E>[];

  /**
   * Child scopes — each child sees this scope's claims as reservations,
   * but children are independent of each other.
   */
  readonly children?: readonly ScopeSpec<E>[];
}

/**
 * One entity competing for naming. Two forms:
 *
 * - **Simple**: one binding, one default facet. Use `candidates`.
 *   Result expression = the resolved binding name.
 *
 * - **Rich**: multiple realizations (shapes), each with its own bindings
 *   and per-facet access expressions. Use `shapes`. Each shape is a
 *   complete way to realize this entity in code; the resolver picks the
 *   highest-priority shape whose bindings all fit the scope.
 *
 * Exactly one of `candidates` or `shapes` must be present.
 */
export interface ScopedEntity<E> {
  readonly key: E;

  /**
   * Simple form. Priority-keyed name preferences. Higher key = higher priority.
   *
   * Each value is a {@link Candidate}: either a string (fresh binding under
   * that name) or a {@link ViaPath} (access expression through an in-scope
   * name without allocating).
   *
   * Use for genuinely single-name entities (handlers, refs, imports, fetchers).
   * For state/query/mutation/anything that has read+setter or destructure
   * tradeoffs, use `shapes`.
   */
  readonly candidates?: Readonly<Record<number, Candidate>>;

  /**
   * Rich form. Each shape is a full realization of the entity, with its own
   * fresh bindings and per-facet access expressions. The resolver picks the
   * highest-priority shape whose bindings all allocate without collision and
   * whose external `viaName`s are in scope.
   *
   * Use when the entity has multiple physical realizations:
   *   - destructure (`[open, setOpen] = useState(...)`) vs non-destructure tuple
   *   - mobx box (`.get()` / `.set`) vs React tuple
   *   - passthrough (`props.open` / `props.onOpenChange`) vs local allocation
   *   - query result destructure vs single-binding member access
   */
  readonly shapes?: readonly Shape<E>[];
}

/**
 * A name candidate.
 *
 * - **string**: request a fresh binding allocated under this name. Valid iff
 *   the name doesn't collide with any reservation or claim in the scope chain.
 * - **{@link ViaPath}**: produce an access expression through an in-scope name.
 *   No fresh binding is allocated; the entity's resolution is the expression
 *   `${viaName}${access}`. Valid iff `viaName` is reserved or claimed in this
 *   scope or any ancestor.
 *
 * The two forms are interleavable in a single ladder. A common pattern for
 * global references with optional shorthand:
 *
 *   {
 *     100: { viaName: "navigator", access: "" },        // direct, if `navigator` is reserved
 *     80:  { viaName: "window", access: ".navigator" }, // window-prefixed fallback
 *   }
 */
export type Candidate = string | ViaPath;

/**
 * Access expression through an in-scope name. The resolved string is the
 * literal concatenation `${viaName}${access}` — there's no parsing.
 *
 * - `access` of "" is the direct-reference case (just `viaName`).
 * - `access` should include the connector token (`.`, `[`, `?.`).
 *
 * Examples:
 *   { viaName: "window", access: ".location" }   → "window.location"
 *   { viaName: "navigator", access: "" }         → "navigator"
 *   { viaName: "props", access: ".className" }   → "props.className"
 */
export interface ViaPath {
  readonly viaName: string;
  readonly access: string;
}

// ── Rich shape ───────────────────────────────────────────────────────

/**
 * One realization of a rich entity. The resolver evaluates shapes in
 * priority-descending order; picks the first whose `bindings` all allocate
 * and whose external `viaName`s in `facets` are in scope.
 *
 * All-or-nothing: a shape is selected as a whole or rejected entirely. The
 * resolver does not "half-select" — for example, it doesn't claim one of
 * a destructure shape's two bindings and skip the other.
 */
export interface Shape<E> {
  /** Higher = preferred. Same scale as candidate priorities. */
  readonly priority: number;

  /**
   * Fresh bindings allocated when this shape is selected. Each binding has
   * its own candidate ladder. Empty for path-only shapes (passthrough,
   * external-only globals) — those allocate nothing.
   */
  readonly bindings: readonly ShapeBinding<E>[];

  /**
   * Access expressions for each named facet of this entity. Facets are
   * domain-defined string keys: e.g., a state has "read" + "setter"; a query
   * has "data" + "status" + "error"; a single-name entity has just "default".
   */
  readonly facets: Readonly<Record<string, FacetExpr<E>>>;
}

/**
 * A fresh binding declared by a shape. Allocated like a simple-form entity
 * but scoped to the parent shape's selection — if the shape isn't selected,
 * the binding doesn't exist.
 */
export interface ShapeBinding<E> {
  /** Sub-entity identity. Must be unique across the resolution. */
  readonly subKey: E;
  /** Name candidates (same Record<priority, Candidate> form as simple entities). */
  readonly candidates: Readonly<Record<number, Candidate>>;
  /**
   * Reference count of this binding's emitted name in the resulting code.
   *
   * **Currently for forward-compat — not exercised by any v0 fixture or
   * algorithm path.** When cost-weighted cross-scope resolution lands
   * (future work), this becomes the weight: `cost = usageCount × tierGap`.
   *
   * Strategy computes from IR walk before resolution (count of bare-name
   * references in JSX, handler bodies, deps lists, member-access chains).
   *
   * Default treatment: 1 (equal weight). Provided values are ignored by the
   * v0 simple-greedy algorithm but accepted for schema stability.
   */
  readonly usageCount?: number;
}

/**
 * How a facet's access expression is constructed.
 *
 * - **binding**: path through one of THIS shape's own bindings. The resolver
 *   substitutes the binding's resolved name; expression = `${name}${access}`.
 * - **external**: path through an in-scope name (reservation or claim from
 *   this scope or any ancestor). Expression = `${viaName}${access}`.
 * - **literal**: a constant expression with no scope dependency.
 */
export type FacetExpr<E> =
  | { readonly kind: "binding"; readonly ref: E; readonly access: string }
  | { readonly kind: "external"; readonly viaName: string; readonly access: string }
  | { readonly kind: "literal"; readonly value: string };

export interface ResolveOptions<E> {
  /**
   * Deterministic per-entity postfix used for tie resolution. MUST be
   * injective across the entity set: two distinct entities must never
   * produce the same postfix. The resolver validates this on tied groups
   * and throws if violated.
   *
   * Typical: `(entity) => entity.uuid.slice(-8)` for entities with stable UUIDs.
   */
  postfixFor: (entity: E) => string;

  /**
   * Tie-resolution form when two entities want the same name at the same
   * importance. Default: `(name, postfix) => `${name}-${postfix}`` (CSS-friendly).
   * For JS use: `(name, postfix) => `${name}_${postfix}`` (no hyphens in JS idents).
   */
  resolveTie?: (name: string, postfix: string) => string;

  /**
   * Numeric-fallback form when an entity's last candidate collides with an
   * existing claim. Default: `(name, n) => `${name}${n}`` (n starts at 2).
   */
  fallbackSuffix?: (name: string, n: number) => string;

  /**
   * What happens to the bare name after a tie is resolved:
   *
   * - `"burn"` (default): the bare name is off-limits to all lower-importance
   *   claimers in this scope. The tied entities DEFER — if every tied entity
   *   still has a lower-priority candidate, they descend to it instead of
   *   postfixing immediately (the bare name is burned either way). Use when a
   *   lower candidate carries real identity worth descending to (JS variable
   *   ladders: try `openState` before `open_uuid`).
   * - `"free"`: like `"burn"` but the bare name remains claimable by lower-
   *   importance claimers. Same defer-if-all-have-lower behavior. Use when
   *   names are display-preference only.
   * - `"postfix"`: burn the bare name AND symmetric-postfix all tied entities
   *   IMMEDIATELY at the tied tier — never defer, even when lower candidates
   *   exist. Use when the tied name IS the identity to keep (CSS classes: two
   *   `<div name="card">` both become `card-<postfix>`, preserving the user's
   *   "card" intent rather than descending to `div-<uuid>`).
   *
   * Note: burn semantics are scoped — a name burned in scope S is burned
   * for descendants of S, but NOT for siblings of S.
   */
  onTie?: "burn" | "free" | "postfix";

  /**
   * Stable comparator for tied entities. Default: lexical compare on
   * `postfixFor(entity)`. Provide for deterministic output across runs.
   */
  compareEntities?: (a: E, b: E) => number;

  /**
   * Human-readable description for error messages. Default: best-effort
   * inspection of common shapes (`uuid`, `id`, `name` properties).
   */
  describeEntity?: (entity: E) => string;
}

export interface ResolveResult<E> {
  /**
   * Convenience: entity → its primary name/expression.
   *
   * - Simple entities: the binding's resolved name.
   * - Rich entities with one facet: that facet's expression.
   * - Rich entities with multiple facets: ABSENT (use `resolutions`).
   *
   * Multi-facet entities don't have a single name — consumers MUST use
   * `resolutions` to access per-facet expressions.
   */
  assignments: ReadonlyMap<E, string>;

  /**
   * Full per-entity resolution: which shape was selected, the resolved name
   * for each binding the shape claimed, the resolved expression for each
   * facet. Always present for every entity in the input.
   */
  resolutions: ReadonlyMap<E, EntityResolution<E>>;

  /**
   * Per-scope view of names claimed at that scope. Keyed by `ScopeSpec.id`;
   * scopes without an id are absent.
   */
  claimsByScope: ReadonlyMap<string, ReadonlySet<string>>;

  /**
   * Per-scope view of names burned by tie-breaking at that scope (populated
   * when `onTie` is `"burn"` or `"postfix"` — not `"free"`). Keyed by
   * `ScopeSpec.id`.
   */
  burnedByScope: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface EntityResolution<E> {
  /**
   * Priority of the shape that was selected. For simple entities, always
   * the implicit single-shape priority (100 by convention).
   */
  readonly selectedShapePriority: number;

  /**
   * Names allocated for the selected shape's bindings. Map<subKey, name>.
   * For simple entities: one entry, keyed by the entity's own key.
   * For rich entities: one entry per binding in the selected shape.
   */
  readonly bindingNames: ReadonlyMap<E, string>;

  /**
   * Resolved access expression per facet. For simple entities: one entry
   * keyed `"default"` whose value is the binding's name. For rich entities:
   * one entry per facet declared in the selected shape.
   */
  readonly facetExpressions: ReadonlyMap<string, string>;
}

/**
 * Resolve all entities in a scope tree to non-colliding names.
 *
 * v0 implementation: simple form (`candidates`) only. Rich form (`shapes`)
 * throws an explicit error — that's a forward-compat schema with no v0
 * implementation.
 *
 * Algorithm:
 *
 * 1. **Pre-pass**: compute `subtreeUserDecls(scope)` per scope = union of
 *    its own `userDeclarations` plus all descendants'. Used at THIS scope's
 *    allocation only — not propagated to children (siblings stay independent).
 *
 * 2. **DFS allocation**: visit scopes pre-order. For each scope, build
 *    effective reservations = (ancestors' down-propagated reservations
 *    ∪ this.reservations ∪ subtreeUserDecls(this) ∪ ancestor claims).
 *
 * 3. **Per-scope resolution**: walk priorities descending. At each priority,
 *    handle ViaPath candidates first (resolve instantly if `viaName` is in
 *    scope), then string candidates with priority-namer-style symmetric
 *    tie-break (burn or free). Unresolved entities use last-candidate +
 *    numeric-suffix fallback.
 *
 * 4. **Sibling independence**: child scopes inherit DOWN-propagated
 *    reservations + ancestor claims, NOT the parent's `subtreeUserDecls`
 *    aggregation. C1's user declarations are visible to S (parent) but
 *    NOT to C2 (sibling).
 *
 * Pure function: same input produces same output. Entity processing is
 * sorted by `compareEntities` (default: lexical compare of `postfixFor`).
 */
export function resolveLexicalNames<E>(
  root: ScopeSpec<E>,
  options: ResolveOptions<E>,
): ResolveResult<E> {
  const allResolutions = new Map<E, EntityResolution<E>>();
  const claimsByScope = new Map<string, ReadonlySet<string>>();
  const burnedByScope = new Map<string, ReadonlySet<string>>();

  // Pre-pass: compute subtree user-decls per scope (referenced by scope identity).
  const subtreeUserDecls = new WeakMap<ScopeSpec<E>, Set<string>>();
  computeSubtreeUserDecls(root, subtreeUserDecls);

  visit(root, new Set(), new Set(), {
    options,
    subtreeUserDecls,
    allResolutions,
    claimsByScope,
    burnedByScope,
  });

  // Build the convenience `assignments` map: entity → primary expression.
  // Single-facet entities (the v0 default) include their default facet here.
  const assignments = new Map<E, string>();
  for (const [k, r] of allResolutions) {
    if (r.facetExpressions.size === 1) {
      const [first] = r.facetExpressions.values();
      if (first !== undefined) assignments.set(k, first);
    } else {
      const def = r.facetExpressions.get("default");
      if (def !== undefined) assignments.set(k, def);
    }
  }

  return { assignments, resolutions: allResolutions, claimsByScope, burnedByScope };
}

// ── Internal implementation ──────────────────────────────────────────

interface VisitContext<E> {
  options: ResolveOptions<E>;
  subtreeUserDecls: WeakMap<ScopeSpec<E>, Set<string>>;
  allResolutions: Map<E, EntityResolution<E>>;
  claimsByScope: Map<string, ReadonlySet<string>>;
  burnedByScope: Map<string, ReadonlySet<string>>;
}

function computeSubtreeUserDecls<E>(
  scope: ScopeSpec<E>,
  out: WeakMap<ScopeSpec<E>, Set<string>>,
): Set<string> {
  const set = new Set<string>(scope.userDeclarations ?? []);
  for (const child of scope.children ?? []) {
    const childDecls = computeSubtreeUserDecls(child, out);
    for (const d of childDecls) set.add(d);
  }
  out.set(scope, set);
  return set;
}

function visit<E>(
  scope: ScopeSpec<E>,
  ancestorDownReservations: ReadonlySet<string>,
  ancestorClaims: ReadonlySet<string>,
  ctx: VisitContext<E>,
): void {
  // Effective reservations at THIS scope's allocation:
  //   ancestor down-propagated ∪ scope's own reservations ∪ subtree user-decls
  // Note: subtree user-decls includes descendants — propagates up to ancestors
  // but is NOT passed down to siblings.
  const effectiveReservations = new Set<string>(ancestorDownReservations);
  for (const r of scope.reservations ?? []) effectiveReservations.add(r);
  const subtreeDecls = ctx.subtreeUserDecls.get(scope);
  if (subtreeDecls) for (const d of subtreeDecls) effectiveReservations.add(d);

  let claimsHere: Set<string> = new Set();
  let burnedHere: Set<string> = new Set();

  if (scope.entities && scope.entities.length > 0) {
    const result = resolveScope(scope.entities, effectiveReservations, ancestorClaims, ctx.options);
    claimsHere = result.claimsHere;
    burnedHere = result.burnedHere;
    for (const [k, r] of result.resolutions) {
      ctx.allResolutions.set(k, r);
    }
    if (scope.id !== undefined) {
      if (claimsHere.size > 0) ctx.claimsByScope.set(scope.id, claimsHere);
      if (burnedHere.size > 0) ctx.burnedByScope.set(scope.id, burnedHere);
    }
  }

  // Recurse into children with DOWN-propagated reservations only.
  // Children DON'T inherit our subtreeUserDecls aggregation (siblings stay
  // independent of each other's user decls).
  const childAncestorDownReservations = new Set<string>(ancestorDownReservations);
  for (const r of scope.reservations ?? []) childAncestorDownReservations.add(r);
  // Own user-decls DO propagate down (this scope's own decls are visible to its descendants
  // — the user code lives at this scope and any inner code references it).
  for (const d of scope.userDeclarations ?? []) childAncestorDownReservations.add(d);

  const childAncestorClaims = new Set<string>(ancestorClaims);
  for (const c of claimsHere) childAncestorClaims.add(c);

  for (const child of scope.children ?? []) {
    visit(child, childAncestorDownReservations, childAncestorClaims, ctx);
  }
}

interface ScopeResolveResult<E> {
  resolutions: Map<E, EntityResolution<E>>;
  claimsHere: Set<string>;
  burnedHere: Set<string>;
}

function resolveScope<E>(
  entities: readonly ScopedEntity<E>[],
  effectiveReservations: ReadonlySet<string>,
  ancestorClaims: ReadonlySet<string>,
  options: ResolveOptions<E>,
): ScopeResolveResult<E> {
  const resolutions = new Map<E, EntityResolution<E>>();
  const claimsHere = new Set<string>();
  const burnedHere = new Set<string>();
  const onTie = options.onTie ?? "burn";
  const resolveTie = options.resolveTie ?? defaultResolveTie;
  const fallbackSuffix = options.fallbackSuffix ?? defaultFallbackSuffix;
  const compareEntities = options.compareEntities ?? defaultCompareEntities(options.postfixFor);

  // Validate entity shape: exactly one of `candidates` or `shapes` must be present.
  for (const entity of entities) {
    const hasSimple = !!entity.candidates && Object.keys(entity.candidates).length > 0;
    const hasRich = !!entity.shapes && entity.shapes.length > 0;
    invariant(
      hasSimple || hasRich,
      `@here.build/lexical-namer: entity has no candidates and no shapes: ${describeEntity(entity.key, options)}`,
    );
    invariant(
      !(hasSimple && hasRich),
      `@here.build/lexical-namer: entity has both candidates and shapes; pick one: ${describeEntity(entity.key, options)}`,
    );
  }

  // Partition entities by form. Simple entities resolve first via the v0
  // algorithm (full priority walk with symmetric tie-break). Rich entities
  // resolve after, greedy per-entity, against the post-simple scope state.
  const simpleEntities: ScopedEntity<E>[] = [];
  const richEntities: ScopedEntity<E>[] = [];
  for (const entity of entities) {
    if (entity.shapes && entity.shapes.length > 0) {
      richEntities.push(entity);
    } else {
      simpleEntities.push(entity);
    }
  }

  // Sort entities by stable comparator (deterministic across runs).
  const sortedEntities = [...simpleEntities].sort((a, b) => compareEntities(a.key, b.key));
  const sortedRichEntities = [...richEntities].sort((a, b) => compareEntities(a.key, b.key));

  // Helper: is name reachable in scope (parent chain reservations or claims, or our own claims)?
  const isInScope = (name: string): boolean =>
    effectiveReservations.has(name) || ancestorClaims.has(name) || claimsHere.has(name);

  // Build flat priority-keyed entries across all entities.
  type Entry = { entity: ScopedEntity<E>; priority: number; candidate: Candidate };
  const allEntries: Entry[] = [];
  for (const entity of sortedEntities) {
    for (const [pStr, cand] of Object.entries(entity.candidates ?? {})) {
      const priority = Number(pStr);
      invariant(Number.isFinite(priority), `Invalid priority key (must be numeric): ${pStr}`);
      allEntries.push({ entity, priority, candidate: cand });
    }
  }

  // Group entries by priority, descending.
  const priorities = new Set<number>();
  for (const e of allEntries) priorities.add(e.priority);
  const sortedPriorities = [...priorities].sort((a, b) => b - a);

  // Walk priorities; resolve as we go.
  for (const P of sortedPriorities) {
    const groupAtP = allEntries.filter((e) => e.priority === P);

    // 1) Resolve ViaPath candidates first — they don't compete for allocation.
    for (const { entity, candidate } of groupAtP) {
      if (resolutions.has(entity.key)) continue;
      if (!isViaPath(candidate)) continue;
      if (isInScope(candidate.viaName)) {
        const expr = candidate.viaName + candidate.access;
        resolutions.set(entity.key, makeSimpleResolution(entity.key, expr, P));
      }
    }

    // 2) Collect string candidates from unresolved entities at this priority.
    type StringEntry = { entity: ScopedEntity<E>; name: string };
    const stringEntries: StringEntry[] = [];
    for (const { entity, candidate } of groupAtP) {
      if (resolutions.has(entity.key)) continue;
      if (typeof candidate === "string") {
        stringEntries.push({ entity, name: candidate });
      }
    }

    // Group by name.
    const byName = new Map<string, StringEntry[]>();
    for (const e of stringEntries) {
      const list = byName.get(e.name) ?? [];
      list.push(e);
      byName.set(e.name, list);
    }
    // Process names in deterministic order.
    const sortedNames = [...byName.keys()].sort();

    for (const name of sortedNames) {
      const entries = byName.get(name)!;
      // Skip if name is blocked.
      if (isInScope(name) || burnedHere.has(name)) continue;

      // Filter to entities that are still active (not yet resolved).
      const active = entries.filter((e) => !resolutions.has(e.entity.key));
      if (active.length === 0) continue;

      if (active.length === 1) {
        const entity = active[0]!.entity;
        resolutions.set(entity.key, makeSimpleResolution(entity.key, name, P));
        claimsHere.add(name);
      } else {
        // Tie. Two questions:
        //   1) Is the bare name burned? — yes iff onTie !== "free"
        //      ("burn" and "postfix" both burn; only "free" leaves it claimable)
        //   2) Do tied entities defer to next priority, or postfix here?
        //      - "postfix": never defer — symmetric-postfix immediately at this
        //        tier (the tied name is the identity to keep).
        //      - "burn"/"free": defer iff ALL tied entities have at least one
        //        lower-priority candidate; otherwise symmetric postfix.
        if (onTie !== "free") burnedHere.add(name);
        const allHaveLower =
          onTie !== "postfix" &&
          active.every(({ entity }) => {
            const cands = entity.candidates ?? {};
            return Object.keys(cands).some((k) => Number(k) < P);
          });
        if (allHaveLower) {
          // Defer — entities will be tried at lower priorities. (Bare name
          // already burned above if onTie === "burn".)
          continue;
        }
        // Exhausted — symmetric postfix across all tied entities.
        const seenPostfixes = new Set<string>();
        const sortedActive = [...active].sort((a, b) => compareEntities(a.entity.key, b.entity.key));
        for (const { entity } of sortedActive) {
          const postfix = options.postfixFor(entity.key);
          invariant(
            !seenPostfixes.has(postfix),
            `priority-namer: postfixFor must be injective on tied entities, but two entities ` +
              `produced the same postfix "${postfix}" for name "${name}".`,
          );
          seenPostfixes.add(postfix);
          const finalName = resolveTie(name, postfix);
          invariant(
            !claimsHere.has(finalName) && !isInScope(finalName),
            `priority-namer: tie-resolved name "${finalName}" collides with an existing claim or reservation.`,
          );
          resolutions.set(entity.key, makeSimpleResolution(entity.key, finalName, P));
          claimsHere.add(finalName);
        }
      }
    }
  }

  // Fallback for unresolved entities: numeric-suffix on last string candidate.
  for (const entity of sortedEntities) {
    if (resolutions.has(entity.key)) continue;
    const candidates = entity.candidates ?? {};
    const sortedKeys = Object.keys(candidates)
      .map(Number)
      .sort((a, b) => b - a);
    invariant(sortedKeys.length > 0, `entity has no candidates`);
    // Find lowest-priority STRING candidate (the last "fallback" string).
    let fallbackName: string | null = null;
    let fallbackPriority = sortedKeys[sortedKeys.length - 1]!;
    for (const k of sortedKeys.reverse()) {
      const c = candidates[k];
      if (typeof c === "string") {
        fallbackName = c;
        fallbackPriority = k;
        break;
      }
    }
    invariant(
      fallbackName !== null,
      `@here.build/lexical-namer: entity ${describeEntity(entity.key, options)} has only ViaPath candidates, ` +
        `none of which had viaName in scope. ` +
        `Strategy must include at least one string candidate as a guaranteed-unique fallback.`,
    );
    let attempt = fallbackName;
    let n = 2;
    while (isInScope(attempt) || burnedHere.has(attempt)) {
      attempt = fallbackSuffix(fallbackName, n++);
    }
    resolutions.set(entity.key, makeSimpleResolution(entity.key, attempt, fallbackPriority));
    claimsHere.add(attempt);
  }

  // Phase 2: rich-shape entities. Greedy per-entity in stable order, against
  // the post-simple scope state. For each entity, iterate shapes by priority
  // descending; for each shape, validate externals + tentatively allocate
  // bindings sequentially. First shape that fits wins.
  for (const entity of sortedRichEntities) {
    const resolution = resolveRichEntity(
      entity,
      effectiveReservations,
      ancestorClaims,
      claimsHere,
      burnedHere,
      options,
    );
    resolutions.set(entity.key, resolution);
  }

  return { resolutions, claimsHere, burnedHere };
}

function resolveRichEntity<E>(
  entity: ScopedEntity<E>,
  effectiveReservations: ReadonlySet<string>,
  ancestorClaims: ReadonlySet<string>,
  claimsHere: Set<string>,
  burnedHere: ReadonlySet<string>,
  options: ResolveOptions<E>,
): EntityResolution<E> {
  invariant(
    entity.shapes && entity.shapes.length > 0,
    `@here.build/lexical-namer: rich entity has no shapes: ${describeEntity(entity.key, options)}`,
  );
  const sortedShapes = [...entity.shapes].sort((a, b) => b.priority - a.priority);

  for (const shape of sortedShapes) {
    // 1. Validate externals: every kind:"external" facet's viaName must be in scope.
    let externalsOk = true;
    for (const facetExpr of Object.values(shape.facets)) {
      if (facetExpr.kind !== "external") continue;
      const inScope =
        effectiveReservations.has(facetExpr.viaName) ||
        ancestorClaims.has(facetExpr.viaName) ||
        claimsHere.has(facetExpr.viaName);
      if (!inScope) {
        externalsOk = false;
        break;
      }
    }
    if (!externalsOk) continue;

    // 2. Tentatively allocate bindings sequentially. Each binding sees
    //    earlier bindings' tentative claims as additional reservations.
    const tentativeClaims = new Set<string>();
    const bindingNames = new Map<E, string>();
    let bindingFailed = false;

    for (const binding of shape.bindings) {
      const isInScope = (n: string): boolean =>
        effectiveReservations.has(n) ||
        ancestorClaims.has(n) ||
        claimsHere.has(n) ||
        burnedHere.has(n) ||
        tentativeClaims.has(n);

      const sortedKeys = Object.keys(binding.candidates)
        .map(Number)
        .sort((a, b) => b - a);
      let allocated = false;
      for (const P of sortedKeys) {
        const candidate = binding.candidates[P];
        if (candidate === undefined) continue;
        if (typeof candidate === "string") {
          if (!isInScope(candidate)) {
            bindingNames.set(binding.subKey, candidate);
            tentativeClaims.add(candidate);
            allocated = true;
            break;
          }
        } else {
          // ViaPath inside a binding ladder — produces an expression rather
          // than a fresh binding name. Doesn't claim a name; just records
          // the path expression as the "binding name" for facet resolution.
          if (
            effectiveReservations.has(candidate.viaName) ||
            ancestorClaims.has(candidate.viaName) ||
            claimsHere.has(candidate.viaName) ||
            tentativeClaims.has(candidate.viaName)
          ) {
            bindingNames.set(binding.subKey, candidate.viaName + candidate.access);
            allocated = true;
            break;
          }
        }
      }
      if (!allocated) {
        bindingFailed = true;
        break;
      }
    }

    if (bindingFailed) continue;

    // 3. Commit. Add all tentative claims to claimsHere (they're now real claims
    //    visible to subsequent rich entities and child scopes).
    for (const c of tentativeClaims) claimsHere.add(c);

    // 4. Compute facet expressions by substituting binding names into templates.
    const facetExpressions = new Map<string, string>();
    for (const [facetName, facetExpr] of Object.entries(shape.facets)) {
      let expression: string;
      switch (facetExpr.kind) {
        case "binding": {
          const bindingExpr = bindingNames.get(facetExpr.ref);
          invariant(
            bindingExpr !== undefined,
            `@here.build/lexical-namer: facet "${facetName}" of entity ` +
              `${describeEntity(entity.key, options)} references unknown binding subKey.`,
          );
          expression = bindingExpr + facetExpr.access;
          break;
        }
        case "external":
          expression = facetExpr.viaName + facetExpr.access;
          break;
        case "literal":
          expression = facetExpr.value;
          break;
      }
      facetExpressions.set(facetName, expression);
    }

    return {
      selectedShapePriority: shape.priority,
      bindingNames,
      facetExpressions,
    };
  }

  invariant(
    false,
    `@here.build/lexical-namer: no shape fits for entity ${describeEntity(entity.key, options)}. ` +
      `Strategy must include at least one shape with a guaranteed-fit fallback ` +
      `(e.g., a UUID-suffixed candidate at the lowest priority).`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function isViaPath(c: Candidate): c is ViaPath {
  return typeof c === "object" && c !== null && "viaName" in c;
}

function makeSimpleResolution<E>(key: E, expression: string, priority: number): EntityResolution<E> {
  // For simple-form entities (and ViaPath resolutions which don't allocate):
  //   bindingNames: { [key] → expression } if it's a fresh binding, else empty
  //   facetExpressions: { "default" → expression }
  // We can't tell from here whether expression is a fresh binding or a path,
  // so we record it both places. Consumers using resolutions for rich-form
  // semantics should distinguish via shape lookup; v0 simple-form consumers
  // can rely on `assignments` (single-facet convenience).
  return {
    selectedShapePriority: priority,
    bindingNames: new Map([[key, expression]]),
    facetExpressions: new Map([["default", expression]]),
  };
}

const defaultResolveTie = (name: string, postfix: string): string => `${name}-${postfix}`;

const defaultFallbackSuffix = (name: string, n: number): string => `${name}${n}`;

function defaultCompareEntities<E>(postfixFor: (entity: E) => string): (a: E, b: E) => number {
  return (a, b) => {
    const pa = postfixFor(a);
    const pb = postfixFor(b);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  };
}

function describeEntity<E>(entity: E, options: ResolveOptions<E>): string {
  if (options.describeEntity) return options.describeEntity(entity);
  if (entity == null) return String(entity);
  if (typeof entity === "string") return entity;
  const e = entity as { uuid?: unknown; id?: unknown; name?: unknown };
  if (typeof e.uuid === "string") return `entity<uuid=${e.uuid}>`;
  if (typeof e.id === "string") return `entity<id=${e.id}>`;
  if (typeof e.name === "string") return `entity<name=${e.name}>`;
  return String(entity);
}
