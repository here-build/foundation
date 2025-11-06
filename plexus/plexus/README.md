# @here.build/plexus

**Collaborative state management where wrong states become structurally impossible**

## Core Concept

Plexus makes collaborative applications work like local ones through contagious materialization: anything accessible from the root automatically syncs. Orphaned entities and invalid states become architecturally impossible.

Built on Yjs for conflict-free collaboration and MobX for React reactivity, Plexus adds type-level constraints that prevent entire classes of bugs, along with convenient developer experience.

## The World State Tree

Traditional architectures force a choice:
- **Global state**: Hard to control granularity, everything reactive to everything
- **Local state**: Prop drilling, inversion of control, state hoisting

Plexus provides the middle ground: a hierarchical tree with ontological cross-links representing "world state" with a focal point.

**Key properties:**
- More scoped than global state (control granularity through tree structure)
- Less restrictive than local state (no drilling, access through tree)
- Everything reachable from root is synced
- Everything unreachable is local and ephemeral

The "rule of thumb": **if something is accessible from Plexus root, it's syncing. Otherwise, it's local.**

This isn't a guideline - it's how the system works. You can't accidentally create orphaned synced entities because materialization is contagious.

## Quick Start

Plexus requires `@here.build/plexus` and `yjs` peer dependency. You'll also need a Yjs syncing provider for syncing environments - but not for test and local setups (configuration varies - follow provider docs).

For reactivity, use `@here.build/plexus-mobx`.

Plexus uses **stage-3 decorators** (available by default in TypeScript, or via Babel transpilation). TypeScript is recommended - many checks exist only at type level for performance.

### Define Schema

```typescript
import { PlexusModel, syncing } from '@here.build/plexus';

@syncing
class User extends PlexusModel {
    @syncing accessor name!: string;
}

@syncing
class Team extends PlexusModel {
    @syncing.list accessor users!: User[];
}
```

**Allowed types:**
- Primitives: `string`, `number`, `boolean`, `null`
- Models: any `PlexusModel` subclass
- Collections: `Array`, `Set`, `Record` (explicit decorator variant usages needed)

**Collection decorators:**
- `@syncing.list` - Array of primitives or models
- `@syncing.set` - Set of primitives or models
- `@syncing.map` - Record<string, primitive | model>

### Define Root

```typescript
@syncing
class Root extends PlexusModel {
    @syncing.child.list accessor teams!: Team[];

    get users(): User[] {
        return this.teams.flatMap(team => team.users);
    }
}

class ProjectPlexus extends Plexus {
    createDefaultRoot() {
        return new Root();
    }
}
```

**Important**: `createDefaultRoot()` must be pure (no external state/values). This solves "parallelized setup" when multiple users initialize simultaneously. Keep it deterministic.

### Connect

```typescript
import * as Y from 'yjs';
import { YWebSocketProvider } from 'y-websocket'; // or your provider

const doc = new Y.Doc();
const syncProvider = new YWebSocketProvider(doc);
await syncProvider.whenSynced; // Wait for initial sync before spawning Plexus
const plexus = new ProjectPlexus(doc);
const root = await plexus.rootPromise;
```

### Use

```typescript
// Create models - omit optional/nullable/empty structure fields - structures default to empty, others default to null
root.teams.push(new Team({
    users: [new User({name: "admin"})]
}));
```

Changes automatically sync to all connected clients. If using reactivity, components rerender when relevant data changes.

## Model Definition

Plexus schema uses decorators to create type-safe, syncable models:

```typescript
@syncing  // Informs Plexus this class represents syncable entity
class User extends PlexusModel {  // Inheritance required for types
    @syncing accessor name!: string | null;
    // `undefined` is illegal - only `null` allowed (Yjs compatibility)
    // `!:` declares field exists (will be initialized from constructor or defaults)

    @syncing.list accessor tags!: string[];
    // Default values auto-convert: undefined → null, missing list → []

    @syncing.set accessor invites!: Set<`invite_${string}`>;
    // Type narrowing works within allowed types

    @syncing.map accessor featureFlags!: {
        darkMode?: boolean,
        earlyAccess?: "alpha" | "beta"
    }

    constructor(props: PlexusInit<User>) {
        super(props);
    }
}
```

**Why these constraints:**

- **`@syncing` decorator**: Associates class with underlying state, enables proper tracking
- **`extends PlexusModel`**: Required for types (decorators can't modify inheritance)
- **Per-field `@syncing`**: Granular tracking, allows mixing with other decorators (e.g., MobX `@observable`)
- **`accessor` keyword**: ES requirement for decorator tracking
- **`!:` syntax**: Type-level assertion that field will exist (initialized via constructor or defaults)
- **No `undefined`**: Only `null` allowed for Yjs compatibility

After declaring a class, **do not rename it**, or explicitly define `static name`. Class name is used internally for model identity.

## Structural Guarantees

### Contagious Materialization

Models automatically materialize in Yjs state when referenced from the main tree.

Think of syncing as a contagious property that spreads from synced to local models. Everything accessible from root is synced. Everything else is (mostly - garbage-collection of removed entity is nuanced) local and ephemeral.

**Why this matters:**

By moving the decision framework from explicit intent to data structure layer, and making both synced and local models first-class entities, we eliminate "forgot to add to sync", "non-accessible", "need whole setup ceremony to use" and many other problems. Single "rule of thumb" provides the level of protocol abstraction allowing to simply not care on entity status.

Also: Testing doesn't require Yjs setup. Run test suites with local models (identical behavior). Materialization happens automatically in production when models connect to tree.

### Parent-Child Tracking

```typescript
@syncing
class Element extends PlexusModel {
    get parent() {
        return super.parent as Root | null;
    }

    @syncing accessor tag!: string;
    @syncing.child.list accessor children!: Element[];
    @syncing.child.map accessor attributes!: Record<string, Attribute>;
}

const root = new Element({
    tag: "div",
    children: [new Element({tag: "img"}), new Element({tag: "section"})]
});

// Tree state:
// - div
//   - img
//   - section

root.children[1].children.push(root.children[0]);

// `img` automatically removed from root during addition to section
// Tree state:
// - div
//   - section
//     - img
```

**Key property**: Moving a child automatically removes it from old parent. Orphaned entities simply can't exist in child-tracked collections.

Use `@syncing.child.*` variants where appropriate - this integrates with advanced Plexus features.

## Reactivity

Reactivity requires one of two approaches:

**Direct MobX integration:**

```typescript
import { enableMobXIntegration } from "@here.build/plexus-mobx";

enableMobXIntegration();
```

This integrates Plexus tracking into MobX. Use MobX's `observer` components and `computed` values normally. It just works.

**Advanced (custom reactivity frameworks):**

```typescript
import { createTrackedFunction, trackingHook } from "@here.build/plexus";

// Granular reactivity for specific functions
createTrackedFunction(callback, fn);

// Global tracking hooks
trackingHook.access = (entity, field) => { /* ... */ };
trackingHook.modification = (entity, field) => { /* ... */ };
```

See [plexus-mobx documentation](https://npmjs.com/package/@here.build/plexus-mobx) for details.

## UUIDs

Every Plexus model gets automatic UUID (technically [nanoid](https://github.com/ai/nanoid)):

```typescript
new Team().uuid // random unique string

// Load entity by UUID
const team = plexus.loadEntity<Team>(uuid);
```

Useful for references, lookups, and as natural identifiers.

## When to Use Plexus

**Use Plexus when:**
- Building collaborative applications (multiplayer, real-time sync)
- Want type-safe state management with minimal boilerplate
- Need granular reactivity (only changed data triggers effects)
- Want tests that run without infrastructure setup

**Don't use Plexus when:**
- No collaboration needed (use plain MobX or Zustand)
- Extremely simple apps (useState is fine)
- Real-time games requiring 60+ fps sync (CRDT overhead too high)
- No TypeScript (loses most safety guarantees)
- for Slate, Prism or other rich text editor integration - Plexus do not support them currently (yet Plexus and another yjs states can live together in single doc)

## Performance Characteristics

**Overhead:**
- Yjs-backed models slower on write than local (CRDT operations)
- Reactivity adds tracking overhead (small)
- Granular tracking reduces unnecessary effects

**Benefits:**
- Only changed fields trigger reactions (not entire objects)
- Test suites run without Yjs (orders of magnitude faster)
- Type-level checks prevent runtime errors

**Not yet benchmarked:** Sync latency, memory overhead, large tree performance. We use Plexus in production (here.build) but haven't published detailed metrics.

## Migration

**From Redux:**
- Follow any migration guide for "Redux to MobX" (e.g.: [1](https://thecodest.co/en/blog/going-from-redux-to-mobx/), [2](https://www.robinwieruch.de/mobx-react/), [3](https://www.mikeborozdin.com/post/redux-to-mobx))
- state structures should explicitly be defined as `@syncing class ... extends PlexusModel`
- when reading, replace `@observable` with `@syncing`
  - for set/object/array structures, use proper variant of `@syncing`
- Replace selectors with getters and mobx `computed`

**From MobX:**
- Replace `@observable` with `@syncing` at fields you want to sync
  - don't forget to also annotate those classes with `@syncing` and add `extends PlexusModel` (deep inheritance allowed)
- keep `@observable` for local-only fields
  - yes, you can mix local state and synced state. Plexus models are singletons - Plexus.loadEntity will always return same object you edited, unless garbage-collected 
- Add Yjs provider for sync
- Restructure around world-state tree
- you now need to wrap in two transactions - `plexus.transact(() => {...})` (ensures yjs atomicity) and `mobx.transact` (mobx atomicity)

**From Replicache:**
- Similar CRDT foundation, different API surface
- No function - just update state in transactions
- No subscriptions - use MobX reactivity
- Sync - follow yjs docs for provider of choice

Detailed migration guides needed - contributions welcome.

## Contributing

Early-stage open source. We're interested in:

- Performance benchmarks
- Migration guides from existing state management
- Failure mode documentation
- Examples and tutorials
- Garbage collection optimizations
- Better DX for initial setup ceremony and empty-doc sync

## License

Future MIT (irrevocable, effective starting January 1, 2027).

Until then: MIT terms except for three specific commercial uses. See [LICENSE.md](../../LICENSE.md) for complete terms.
