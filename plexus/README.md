# @here.build/plexus

![i-cant-believe-its-not-local.png](i-cant-believe-its-not-local.png)

Reactive state management with automatic replication in familiar style.
Just make TypeScript classes sync across clients via most popular JS CRDT protocol.

```bash
npm install @here.build/plexus
```

## Who this is for

You're building a real-time collaborative app, you've found Yjs (or Automerge, or Liveblocks), and you're trying to figure out how to keep your domain model and your CRDT state in sync without writing 500 lines of glue code per entity. **Plexus is the layer that makes your TypeScript classes the CRDT.** Decorate fields with `@syncing`, get reactive replication, MobX integration, parents-of/children-of traversal, and append-only entity shells with native undo/redo. Yjs-compatible underneath; works with any Yjs provider you already trust.

If you'd rather build collaboration with classes than with `Y.Map.set("key", value)`, this is for you.

## Quick Start

> You will need to use **TypeScript** with **stage-3 decorators** specifically.
> Make sure that `experimentalDecorators` in `tsconfig.json` is **disabled**.

```typescript
import * as Y from "yjs";
import { Plexus, PlexusModel, syncing } from "@here.build/plexus";

@syncing
class Counter extends PlexusModel {
  @syncing accessor count = 0;
}

const plexus = Plexus.bootstrap(new Counter());
plexus.root.count++; // Synced to all connected clients
```

Connect any Yjs
provider — [y-websocket](https://github.com/yjs/y-websocket), [y-webrtc](https://github.com/yjs/y-webrtc), [Hocuspocus](https://hocuspocus.dev), [PartyKit](https://partykit.io), [Liveblocks](https://liveblocks.io), [y-sweet](https://github.com/jamsocket/y-sweet) —
for real-time sync:

```typescript
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();
const provider = new WebsocketProvider("wss://your-server", "room", doc);
await provider.synced;
Plexus.connect(doc);
```

## Defining Models

### Primitive Fields

```typescript

@syncing
class Project extends PlexusModel {
  @syncing accessor title: string = "";
  @syncing accessor owner: User | null = null;
  @syncing accessor createdAt: Date = new Date();

  // Computed properties work as expected. It's just JS.
  get titleUpperCase() {
    return this.title.toUpperCase();
  }
}
```

**Supported types:** `string`, `number` (including `Infinity`, `-Infinity`, `NaN`), `boolean`, `null`, `bigint`, `Date`,
`Uint8Array`, `Blob` (experimental), and `PlexusModel` references.

Note that `undefined` is not supported and will be coerced to `null`.

> Why? It is impossible to properly track the constructor finishing its job without breaking lots of things. It means that we cannot track the default value assignment. 
> 
> As a consequence, it means that we cannot differ default value assignment in constructor and post-constructor assignment; saying "undefined means absence of value, null means empty value" lets us solve several edge cases around default value vs value intentionally passed in constructor. 

### Collection Fields

```typescript

@syncing
class Project extends PlexusModel {
  @syncing.list accessor members: User[]; // you may skip struct declarations
  @syncing.set accessor tags: Set<string> = new Set(["default-tag"]); // or declare defaults explicitly 
  @syncing.record accessor metadata: Record<string, string>;
  @syncing.map accessor scores: Map<User, number>;
}
```

**In-place Mutative Diffing**: Plexus performs diffing under the hood when you overwrite a collection. Reassigning a collection field (e.g. `project.tags = new Set(["a", "b"])`) does not create a new CRDT node and destroy the old one. Instead, it intelligently performs a granular diff (`add`/`delete` operations) against the existing `Y.Set`/`Y.Array`, maintaining the underlying CRDT identity and preserving observers flawlessly.

### Child Fields (Ownership)

Use `.child` decorators for parent-child relationships with automatic reparenting.
Child fields confer ownership — a child can only have one parent at a time.

```typescript

@syncing
class Project extends PlexusModel<null> {
  @syncing.child.list accessor pages: Page[];
  @syncing.child.set accessor components: Set<Component>;
  @syncing.child.record accessor configs: Record<string, Config>;
  @syncing.child.map accessor assignments: Map<string, Task>;
  @syncing.child accessor activePage: Page | null = null;
}

// PlexusModel<Parent> types the .parent accessor
@syncing
class Page extends PlexusModel<Project> {
  @syncing accessor name: string = "";
}
```

Moving a child to a new parent **automatically removes it from the old one**:

```typescript
const page = new Page({ name: "homepage" });
project1.pages.push(page);    // page.parent === project1
project2.pages.push(page);    // page.parent === project2, project1.pages is empty
```

### Virtual Maps

> ⚠️ **Advanced.** Virtual deterministic genesis entities are solving a very niche problem.
> Unless you encounter that kind of CRDT conflicts explicitly, you likely do not need it.  
> Use only when you specifically need conflict-free concurrent spawn of equivalent entities.
>
> It is **NOT** intended to be a general lazy-load solution.

`@syncing.virtual(factory)` is a conflict-on-spawn resolution mechanism. The entity pretends all children exist
simultaneously
and spawns them on-demand via a factory:

```typescript
@syncing.virtual((key: string) => new Config({ key }))
accessor configs!: VirtualMap<string, Config>;

// Accessing a key spawns the entity deterministically.
// It appears on first access in a conflict-free, deterministic manner.
const cfg = root.configs.get("theme");
```

When multiple users create identical nodes, they are still considered as different entities by CRDT runtime.
If there is a certainty on fully deterministic state at initialization time - for example,
just "empty pointer" node – it may be defined in virtual genesis flow.

It means that the special virtual "user" appears in CRDT for everyone accessing this field,
generates this entity in a way that will be identical for every user out there,
and during the CRDT merge, it will not overwrite itself, but merge safely.

> **Constraints:**
>
> - **Document-bound:** `.get()` requires the owner to be connected to a `Y.Doc`. Ephemeral (doc-less) models must not access virtual fields — it will throw. Use eager construction (`constructor` + `@syncing.child.map`) for fields that must work in both ephemeral and connected contexts.
> - **Factory isolation:** Factory runs in a sandbox with no access to external models. Only entities created within the factory are accessible.
> - **Mutations blocked:** `.set()`, `.delete()`, `.clear()`, `.assign()` all throw at runtime. Virtual children are created by the factory, not by callers.
> - **Keys:** Primitives, primitive arrays, and `PlexusModel` instances (when connected to a doc) are valid keys. Sets are rejected. Disconnected PlexusModel keys throw.
> - **Clone:** Virtual children are skipped during clone — they auto-materialize on access in the clone.
> - **Undo:** Genesis operations use `GENESIS_ORIGIN` — invisible to UndoManager.
> - This is **not** a general-purpose lazy loader.

### Map Keys

Maps use structural equality for keys — Sets, Arrays, Dates, tuples, and PlexusModel references all work:

```typescript
@syncing.map accessor byDimensions: Map<Set<string>, number> = new Map();

// Order doesn't matter for Set keys
map.set(new Set(["a", "b"]), 42);
map.get(new Set(["b", "a"])); // 42

// Arrays/tuples are order-sensitive
@syncing.map accessor events: Map<[Date, string], Event> = new Map();

// Models as keys
@syncing.map accessor scores: Map<User, number> = new Map();
```

This **differs** from native JS `Map` behavior intentionally.
Pointer-reference maps are meaningless in collaborative environments.
Structural equality, however, enables powerful many-to-one relations (hyperedges) like `Map<Set<User>, Group>`.

> Why objects are not supported as keys?
> 
> Objects are somewhat indeterministic; it's hard to say - does keys order matter? What about getters? What about non-enumerables? Do empty fields matter? It's hard to make those behaviors expected for everyone. Array and Set, however, are explicit: one is saying "order matters", another "order do not matter".

Note that only Map class is supported, not its descendants. Classes that extend Map will be serialized into key-value pairs and re-materialized as Map field. TypeScript cannot detect that, sadly.

## Constructor Patterns

### PlexusInit & Constructor Shape

Models accept a props object, used as an initialization structure. You have to declare them manually:

> Why? TS is not capable to make constructor depend on instance fields.

```typescript

@syncing
class MyModel extends PlexusModel {
  @syncing accessor name!: string;

  constructor(props: { name: string }) {
    super(props); // PlexusInit<this> | undefined
  }
}
```

### Omittable Fields

Nullable fields and collections can be omitted from constructors:

```typescript

@syncing
class Project extends PlexusModel {
  @syncing accessor title!: string;                // Required
  @syncing accessor description!: string | null;   // Omittable (nullable)
  @syncing.list accessor tags!: string[];           // Omittable (spawns empty)
}

new Project({ title: "Hello" }); // Only title is required
```

### Accessor Syntax

Use `!: Type | null` for nullable fields. The `= null` initializer is equivalent:

```typescript
class {
  // Both are equivalent:
  @syncing accessor owner!: User | null;
  @syncing accessor owner: User | null = null;
}
```

## Inheritance

`@syncing` is required on every level of the class hierarchy. Pass a string to set the model name (used for CRDT type maps and cross-peer resolution):

```typescript

@syncing("SuperProject")
class SuperProject extends Project {
  // field types can be redefined in subclasses
  // @ts-expect-error - it IS typescript error, but we allow overwriting child to non-child vice-versa.
  @syncing.child accessor title: string | RichName = "";
}
```

The `declare` keyword provides type narrowing without adding syncing behavior:

```typescript

@syncing
class ConcreteGroup extends AbstractGroup {
  declare items: SpecificItem[]; // Narrows type, no decorator needed
}
```

### `syncing.declare<Out, In>()`

A void decorator extension exists solely to declare generic type parameters for TypeScript variance narrowing.
Needed when a generic model like `ExprSequence<A, B>` must interact with `ExprSequence<NarrowerA, any>`
but not `ExprSequence<NarrowerA, NarrowerB>` — without it, TypeScript infers overly strict variance and blocks valid assignments:

```typescript

@syncing
class ExprSequence<A extends Expr, B extends Expr> extends PlexusModel {
  @syncing.declare<A, Expr>() accessor head!: A;
  @syncing.declare<B, Expr>() accessor tail!: B;
}
```

## Entity Lifecycle

### Doc-Free Usage

Models can be used without a Y.Doc. Field access, mutation, parent tracking, and all collection operations
work identically — backing storage runs independently; Yjs sync is skipped via null-guards.

```typescript
const page = new Page({ name: "draft" });
page.name = "updated";        // works
project.pages.push(page);     // works, parent tracking works
page.parent;                  // project
```

What does require a doc:

- **Materialization** — writing to the CRDT layer for sync
- **`.uuid`** in default CRDT-native mode (throws without doc; see [Identity & UUIDs](#identity--uuids))

Some introspection behaves differently without a doc:

- `.rootAncestor` → `null` (correct: there is no Plexus root to reach)
- `.isDetached` → `false` (ephemeral entities are not considered detached — detachment is a materialized-entity concept)

### Identity & UUIDs

Every model instance has a stable `.uuid`. By default, UUIDs are **CRDT-native** — they encode the doc guid, client ID,
and
logical clock into a single string, enabling **O(1) entity resolution**.

Because they're derived from CRDT state, accessing `.uuid` **throws without a doc**. This is fine in production (models
are materialized), but tests that inspect UUIDs on ephemeral models will crash.

**Arbitrary mode** (`PLEXUS_UUID_MODE=arbitrary`) switches to a random UUID generator (nanoid by default), removing the
doc constraint. Behavior is identical — only entity resolution becomes O(n) instead of O(1), which is irrelevant for
test-sized datasets:

```bash
PLEXUS_UUID_MODE=arbitrary vitest run
```

`Plexus.getArbitraryUUID` can be overridden for deterministic test UUIDs. It's only effective in arbitrary mode —
intentionally, to avoid implicit behavior differences in production:

```typescript
let counter = 0;
Plexus.getArbitraryUUID = () => `test-${counter++}`;
```

`.documentId` returns the Y.Doc guid (`undefined` for unmaterialized or dependency entities).

### Navigation

```typescript
entity.parent;          // parent model instance, or null
entity.parentField;     // field name on parent (e.g. "pages"), or null
entity.parentFieldKey;  // key within field: string for records, deserialized
                        // ReadonlySet/readonly array for map keys, or null
entity.rootAncestor;    // walks up parent chain to find Plexus root, or null
```

### Status

```typescript
entity.isRoot;      // true if this is the document root entity
entity.isDetached;  // true if materialized but not reachable from root
```

### Operations

```typescript
entity.detach();                             // remove from parent, returns true if was attached
entity.clone({ title: "Copy" });             // deep clone of child subtree with optional overrides
entity.toJSON();                             // plain object of all schema fields
```

**Deep Sub-Tree Cloning**: The `.clone()` method provides deep cloning of your models. It recursively clones all child (owned) arrays, sets, maps, and objects, automatically creating fresh UUIDs and CRDT nodes for the copy while perfectly preserving the nested structure. Peer (reference) fields are smartly pointed to the existing identical instances rather than erroneously cloning external dependencies.

**Native Snapshotting**: Because Plexus cleanly manages JavaScript object internals without hiding them behind opaque wrappers, native JS utilities work flawlessly straight out of the box. You don't need a special "snapshot protocol" for UI serialization — spread syntax (`{...entity}`), `structuredClone(entity)`, and `JSON.stringify(entity)` natively extract everything you expect without crashing on CRDT symbols.

## Reactivity

### MobX Integration

```typescript
// Automatic register — recommended
import "@here.build/plexus/mobx/register";

// Or manual initialization
import { enableMobXIntegration } from "@here.build/plexus/mobx";

import { autorun } from "mobx";

autorun(() => {
  console.log(`${project.title}: ${project.members.length} members`);
});

project.title = "Updated"; // Triggers reaction
```

Plexus applies **highly granular Map and Set tracking**. It tracks structural access dynamically — calling `map.has("key")` or checking `set.size` binds observers exactly to those specific structural traits rather than the whole collection. An update to the value of `'another-key'` will not trigger a re-render for a component purely observing `.has('key')` or `.size`.

### MobX Reaction Tracking

With MobX integration enabled, use `reaction` for fine-grained tracking:

```typescript
import { reaction } from "mobx";

const dispose = reaction(
  () => [project.title, project.members.length],
  () => console.log("Changed!")
);
// dispose() when no longer needed
```

## Transactions

Batch changes into a single sync + reactivity event:

```typescript
plexus.transact(() => {
  project.title = "New Title";
  project.members.push(user1, user2);
  project.metadata.status = "active";
});
```

Transactions form **safe shadow sub-transactions**. If function A initiates a `plexus.transact()` and inside it invokes function B (which also wraps itself in `plexus.transact()`), Plexus handles it flawlessly by no-oping the inner boundary. You can wrap any granular helper mutation in a transaction without worrying about breaking batching when composing functions together.

> MobX `action()` and `plexus.transact()` are separate — if mixing reactive systems, use both.

## Undo / Redo

```typescript
plexus.undo();
plexus.redo();
```

Always use these wrappers — not the raw Yjs `UndoManager`. The wrappers set internal tracking state so that
operations triggered during undo/redo (observation re-bootstrap, parent pointer fixup) are not themselves recorded
as undoable actions. Built on `UndoManager` internally with a 500ms capture window.

Structural operations (entity creation, container materialization) are automatically excluded from the undo history — only content changes are reversible.

## Liminality (Ephemeral Gestures)

Liminality holds operations on a shadow document — invisible to peers and undo history — until explicitly committed as a single atomic delta. A 10-second slider drag becomes one undo step instead of 600.

```typescript
// Enter liminal state (operations are now ephemeral)
plexus.enterLiminality();

// User drags a slider — hundreds of writes, all held on shadow
for (const value of sliderFrames) {
  entity.opacity = value;
}

// Commit: all writes become one atomic delta, one undo step
plexus.commitLiminality();

// Or revert: all writes discarded, zero trace in history
plexus.revertLiminality();
```

### What Liminality Solves

- **Gesture coalescing:** 600 slider ticks → 1 committed delta, 1 undo step
- **Write amplification:** only the final value enters the permanent operation log
- **Undo granularity:** commit boundary IS the undo boundary — not a 500ms timer
- **Array operations:** insert/delete/splice during gestures handled correctly, including ghost Item cleanup

### Peer Preview

In-progress gestures are broadcast to peers via the awareness protocol — zero permanent operations:

```typescript
// Peers see the drag in real-time via awareness, not via CRDT sync
plexus.enterLiminality();
entity.x = 100; // peers see this as a preview
entity.x = 200; // peers see this update
plexus.commitLiminality(); // peers receive the final value via CRDT sync
```

Broadcast frequency adapts to CPU pressure via PressureObserver:
- Low pressure → smooth 60fps previews
- High pressure → throttled (preserve responsiveness)
- Tab hidden → broadcast stops entirely

Previews auto-expire after 5 minutes (collective TTL) or on disconnect (30s awareness timeout).

### Structural Liminality (Arrays)

Array operations during liminal sessions are handled via three-case dispatch:

- **Insert-only:** UndoManager undo removes liminal Items; committed delta carries them under committed namespace
- **Delete-only:** Skip UndoManager undo (would create ghost Items); committed delta is a delete-set-only update
- **Mixed:** UndoManager undo + ghost Item detection via clock range + targeted delete set cleanup

### API

```typescript
plexus.enterLiminality();          // start ephemeral session
plexus.commitLiminality();         // atomic commit → one undo step
plexus.revertLiminality();         // discard all liminal writes
plexus.isLiminal;                  // true if in a liminal session
```

> **Constraints:**
> - One active liminal session at a time per Plexus instance
> - Shadow document uses `gc: false` (tombstones accumulate over sessions)
> - State vector grows by one entry per committed session
> - Ghost cleanup depends on Yjs UndoManager creating new Items for array deletion undo

## Querying

```typescript
// Load entity by UUID (singleton — always same instance guarantee)
const project = plexus.loadEntity<Project>(uuid);

// Get all materialized instances of a model type
const allProjects = plexus.getAllOfType(Project);

// Reverse lookup: find all parents of a node through a specific field
for (const project of plexus.parentsOf(page, Project, "pages")) {
  // yields Project instances whose .pages contains page
}
```

**Lazy Containers**: Empty collection fields (lists, sets, records, maps) cost zero in the CRDT log until first write. The container is materialized on demand with a deterministic identity that converges across independent peers.

**Singleton Guarantee & `O(1)` Entity Caching**: Plexus maintains an internal `WeakRef` cache of all materialized entities. When querying nested models or resolving dependencies, you receive **the exact same TypeScript class instance in memory**. Navigating to a model or calling `plexus.loadEntity(uuid)` performs an `O(1)` memory lookup rather than a binary search traversing the `Y.StructStore` for entities you have already encountered. This ensures that `entityA === entityB` strict equality checks function correctly across your application while drastically minimizing overhead.

`parentsOf` is a generator. For child fields it yields at most one result (ownership is exclusive);
for reference fields it yields all matches.

## Tree Walking

Schema-aware child traversal inspired by [zimmerframe](https://github.com/Rich-Harris/zimmerframe):

```typescript
import { walk, buildVisitor } from "@here.build/plexus";

walk(root, initialState, {
  Project(node, ctx) {
    // visit Project nodes
    ctx.next(); // continue to children
  },
  Page(node, ctx) {
    ctx.stop(); // halt traversal
  }
});
```

`walkChildren(node, state, visitors)` walks only direct children. `buildVisitor(visitors)` creates a type-safe visitor
for reuse.

## Cross-Document Dependencies

Link data from other Y.Docs into the current document:

```typescript
const depRoot = plexus.addDependency(otherDocId, stateVector);
```

Entity pointers remain stable after linking — dependencies are potentially upgradable (a dependency can later
become a full peer or receive updates).

## Error Types

Plexus throws specific error types with detailed console logging for ownership violations:

| Error                       | When                                                |
|-----------------------------|-----------------------------------------------------|
| `PlexusSelfAdoptionError`   | Entity tries to adopt itself                        |
| `PlexusCycleError`          | Adoption would create a cycle in the ownership tree |
| `PlexusDependencyError`     | Attempting to modify a dependency entity            |
| `PlexusRootParentError`     | Attempting to set a parent on the root entity       |
| `PlexusDocMismatchError`    | Entities from different docs used in same operation |
| `PlexusDuplicateChildError` | Same child appears twice in a child array/set       |

## API Reference

```typescript
// Bootstrap a new document with root entity
const plexus = Plexus.bootstrap(root, documentId ?, doc ?);

// Connect to existing synced Y.Doc
const plexus = Plexus.connect(existingDoc);

// Core accessors
plexus.root;                              // root model instance
plexus.doc;                               // underlying Y.Doc

// Querying
plexus.loadEntity<T>(uuid);               // entity by UUID
plexus.getAllOfType(Constructor);          // all instances of type
plexus.parentsOf(node, ParentClass, field); // reverse lookup

// State management
plexus.transact(fn);                      // batched transaction
plexus.undo();                            // undo last change
plexus.redo();                            // redo last undo

// Liminality (ephemeral gestures)
plexus.enterLiminality();                 // start ephemeral session
plexus.commitLiminality();                // atomic commit → one undo step
plexus.revertLiminality();                // discard all liminal writes
plexus.isLiminal;                         // true if in liminal session

// Cross-document
plexus.addDependency(docId, stateVector); // link external doc
```
