# Here.build OSS Foundations

Constraint-based frameworks for collaborative applications and AI agent architecture.

This monorepo contains two main projects:

- **Plexus**: Collaborative state management where wrong states become structurally impossible
- **Arrival**: MCP framework and serialization preventing AI agent fragmentation through architecture

## Philosophy

Both frameworks embody the same principle: **wrong becomes impossible through structure, not guidelines**.

**Plexus** uses constraint mathematics:
- Can't have orphaned synced entities (contagious materialization)
- Can't create parent-child cycles (ownership tracking)
- Can't represent invalid types (type-level constraints)

**Arrival** prevents subprocess desync:
- Can't accidentally execute during exploration (sandbox boundaries)
- Can't have action context drift (batch-level immutability)
- Can't express compositional thought inefficiently (s-expressions match reasoning)

This isn't defensive programming. It's making entire classes of bugs architecturally impossible.

---

## Plexus: Collaborative State Management

**MobX reactivity + Yjs CRDTs + type-safe constraints**

Plexus makes collaborative applications work like local ones through contagious materialization: anything accessible from the root automatically syncs. Invalid states become structurally impossible.

```typescript jsx
@syncing
class Task extends PlexusModel {
    @syncing accessor name!: string;
    @syncing accessor priority!: number;
    @syncing.set accessor dependsOn!: Set<Task>;
}

@syncing
class Team extends PlexusModel {
    @syncing accessor name!: string;
    @syncing.child.list accessor tasks!: Task[];
}

// Automatically rerenders when anyone changes anything displayed
export const TodoList = observer(({team}: TodoListProps) => {
    return <div>
      <h1>{team.name}</h1>
      {team.tasks.map(task => <TaskPreview task={task}/>)}
    </div>
})
```

**Key insight**: The "world state tree" with focal points solves the middle ground between global state (hard to control granularity) and local state (inevitably leads to prop drilling). Everything reachable from root is synced. Everything else is local and ephemeral. Both materialized and ephemeral models are first-class entities.

### Why Plexus

- **Structural safety**: Moving a child element automatically removes it from old parent. Cycles are impossible. Orphaned entities are simply inexpressible.
- **Granular reactivity**: Only what changed triggers effects. Parent modification doesn't cascade to children.
- **Test without infrastructure**: Ephemeral (local) models behave identically to materialized (synced) ones. Run tests without Yjs or server setup.
- **Type-safe**: Full TypeScript support with decorators as schema.

**→ [Getting Started with Plexus](./plexus/plexus/README.md#getting-started)**

---

## Arrival: AI Agent Architecture

**S-expressions + Sandboxed Scheme + MCP framework preventing fragmentation**

AI agents fragment not from lack of capability but from tool architectures that cause subprocess desync. Arrival prevents this through structure.

### What Arrival Provides

**Token efficiency**: up to 30-60% reduction in tool definitions vs JSON while improving readability ([examples](./arrival/arrival-serializer/README.md#best-practices))

**Architectural safety**:
- Discovery tools execute in sandboxed Scheme - exploration can't accidentally trigger actions
- Action tools use batch-level context immutability - can't have mid-operation drift
- S-expressions match compositional reasoning instead of forcing it into key-value pairs

**Extended coherent sessions**: We observe agents maintaining coherent work for 50+ tool calls vs 10-20 with standard MCP architectures. (Real data from production use at here.build. Results may vary on concrete server implementation details.)

### Discovery vs Action

Instead of immediate tool execution, Arrival separates exploration from commits:

```typescript
class TasksDiscoveryInteraction extends DiscoveryToolInteraction {
  static readonly name = 'tasks-discovery';
  readonly description = 'Explore tasks safely';

  async registerFunctions() {
    this.registerFunction('get-tasks',
      "get all user tasks",
      () => this.context.get('database').tasks.getAll()
    );
  }
}
```

AI agents can explore in Scheme without side effects:

```scheme
(filter (lambda (task)
          (and (> (@ task :priority) 5)
               (= (@ task :status) "open")))
  (get-tasks))
```

Then commit changes through Action tools with guaranteed context coherence.

### Why S-expressions

When reasoning compositionally, you think: "filter by predicate, map over collection, compose operations." S-expressions are the notation for this. JSON is what you get when you serialize compositional thought into key-value pairs.

Compare:
```scheme
(filter (lambda (x) (> (@ x :priority) 5)) (get-tasks))
```

vs the JSON equivalent requiring operation/predicate/conditions nested objects.

One is thought. The other is data about thought.

**→ [Getting Started with Arrival](./arrival/arrival/README.md)**

---

## Research Status

Arrival embeds a working hypothesis: that AI agent "drift" results from tool architectures violating cognitive subprocess boundaries, not primarily from training limitations.

We have observational evidence (extended session lengths, reduced drift), theoretical framework (subprocess desync mechanism), and citations to related research (self-contradiction, mode collapse, polysemantic activation).

**This needs peer review, controlled experiments, and independent replication.**

If you're interested in validating or refuting this hypothesis, we welcome collaboration. The frameworks work regardless of whether the underlying theory is correct - but understanding *why* they work matters for AI safety and architecture.

---

## Packages

**Plexus:**
- `@here.build/plexus` - Core framework
- `@here.build/plexus-mobx` - MobX reactivity integration

**Arrival:**
- `@here.build/arrival` - Complete bundle
- `@here.build/arrival-serializer` - S-expression serialization
- `@here.build/arrival-scheme` - Sandboxed Scheme interpreter
- `@here.build/arrival-mcp` - MCP framework with discovery/action separation
- `@here.build/arrival-env` - Protocol definitions for shared libraries

## Installation

```bash
# For collaborative state management
npm install @here.build/plexus yjs

# For AI agent tools (complete)
npm install @here.build/arrival

# Or install components separately
npm install @here.build/arrival-serializer
npm install @here.build/arrival-mcp
```

## Research

Arrival embeds a working hypothesis about AI agent fragmentation. See [fragmentation hypothesis](./docs/research/fragmentation-hypothesis.md) for details, limitations, and collaboration opportunities.

## Contributing

This is early-stage open source. We're particularly interested in:

- Independent benchmarks of session length / drift rates
- Security review of Scheme sandbox
- Migration guides from existing tools
- Documentation of failure modes
- Validation or refutation of the fragmentation hypothesis

See [SECURITY.md](./SECURITY.md) for security policy.

## Contact

- **General**: team@here.build
- **Research collaboration**: @merkle_bonsai on Telegram or X
- **Issues**: https://github.com/here-build/foundation/issues

## License

Future MIT (irrevocable, effective starting January 1, 2027).

Until then: MIT terms except for three specific commercial uses (no-code/low-code platforms, MCP infrastructure services, CRDT collaboration infrastructure).

See [LICENSE.md](./LICENSE.md) for complete terms.
