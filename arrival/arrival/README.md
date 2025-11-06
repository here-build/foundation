# @here.build/arrival

**AI agent architecture preventing fragmentation through structure**

## What Arrival Provides

**Token efficiency** (measured and reproducible):
- ~5-10% savings in MCP calls out of the box, model-dependent
- 30-60% savings with structured domain markup
- Up to 5x more tools in MCP server without performance degradation
- [Detailed explanation](../arrival-serializer/README.md#best-practices)

**Architectural safety** (structural guarantees):
- Discovery tools execute in sandboxed Scheme - exploration can't accidentally trigger actions
- Action tools use batch-level context immutability - mid-operation drift becomes impossible
- S-expressions match compositional reasoning instead of forcing it into key-value serialization

**Extended coherent sessions** (observational, corroborated):
- We observe 50+ tool calls without drift in production (here.build)
- Research on standard MCP finds drift emerging within 5-15 tool calls, with recommendations to monitor every 5-10 calls ([arXiv:2508.06418v1](https://arxiv.org/abs/2508.06418v1), tool masking studies)
- Our observations align with existing research on standard architectures
- *Needs controlled head-to-head comparison*

## The Core Problem

AI agents fragment not from lack of capability but from architecture mismatch. When tool architectures force different reasoning patterns to share state inappropriately, these patterns desynchronize.

**Working hypothesis**: Drift results from subprocess desync, not training limitations. See [fragmentation hypothesis](../../docs/research/fragmentation-hypothesis.md) for research background.

**Arrival prevents this through structure:**
- **Discovery tools** - read-only exploration in sandboxed Scheme
- **Action tools** - mutation with guaranteed context coherence
- **Context coherence constraint** - all actions in a batch see exactly the same world-state

## Why S-expressions?

S-expressions map to how compositional reasoning works:

```scheme
(filter
  (lambda (item)
    (and
      (not (null? item))
      (> (@ item :priority) threshold)))
  (map
    (lambda (x) (process-with context x))
    candidates))
```

vs JSON equivalent:

```json
{
  "operation": "filter",
  "predicate": {
    "type": "and",
    "conditions": [
      {"type": "not", "arg": {"type": "null-check", "target": "item"}},
      {"type": "greater-than", "left": {"type": "get", "object": "item", "key": "priority"}, "right": "threshold"}
    ]
  },
  "input": {
    "operation": "map",
    "function": "process-with",
    "args": ["context", "x"],
    "collection": "candidates"
  }
}
```

One is thought. The other is data about thought.

When you reason compositionally, you compose: filter by predicate, map over collection, build conditions from primitives. S-expressions are the notation for compositional thinking. JSON is what you get when you try to serialize that structure into key-value pairs.

There are good approaches to making JSON more efficient (e.g. [toon](https://github.com/toon-format/toon)), but they still serialize data rather than expressing intent. S-expressions are homoiconic - code is data, data is code. The format doesn't fight the thought process.

## Quick Start

### Which Package Do I Need?

**Complete bundle:**
```bash
npm install @here.build/arrival
```

**Just S-expression serialization:**
```bash
npm install @here.build/arrival-serializer
```
[See serialization guide](../arrival-serializer/README.md#quick-start)

**Building MCP servers:**
```bash
npm install @here.build/arrival-mcp
```
[See MCP framework guide](../arrival-mcp/README.md#quick-start)

**Scheme exploration for agents:**
```bash
npm install @here.build/arrival-scheme @here.build/arrival-mcp
```
[See Scheme integration guide](../arrival-scheme/README.md#quick-start)

**Shared libraries with optional serialization:**
```bash
npm install @here.build/arrival-env
```
[See protocol-only setup](../arrival-env/README.md#quick-start)

## Architecture Overview

### Discovery Tools: Exploration Without Side Effects

Discovery tools let AI agents explore data safely in Scheme:

```typescript
import { DiscoveryToolInteraction } from '@here.build/arrival-mcp';

class TasksDiscovery extends DiscoveryToolInteraction {
  static readonly name = 'tasks-discovery';
  readonly description = 'Explore tasks';

  async registerFunctions() {
    // Register domain functions - automatic JS ↔ Scheme translation
    this.registerFunction('get-tasks',
      "get all user tasks",
      () => this.context.get('database').tasks.getAll()
    );
  }
}
```

**AI agents explore:**

```scheme
(filter (lambda (task)
          (and (> (@ task :priority) 5)
               (= (@ task :status) "open")))
  (get-tasks))
```

**Key properties:**
- Sandboxed - only registered functions available
- Read-only - no state changes possible
- Exploratory - errors return as data, don't fragment session

### Action Tools: Mutations With Context Coherence

After exploration, agents commit changes through batched actions:

```typescript
import { ActionToolInteraction } from '@here.build/arrival-mcp';
import * as z from 'zod';

class UpdateTasks extends ActionToolInteraction<{ projectId: string }> {
  static readonly name = 'update-tasks';
  readonly description = 'Batch update tasks';

  readonly contextSchema = {
    projectId: z.string().describe('Project ID')
  };

  constructor(...args) {
    super(...args);

    this.registerAction({
      name: 'create-task',
      description: 'Create a new task',
      context: ['projectId'],
      props: {
        title: z.string(),
        priority: z.number().optional()
      },
      handler: async (context, { title, priority }) => {
        const task = await database.tasks.create({
          projectId: context.projectId,
          title,
          priority: priority ?? 0
        });
        return { created: task.id };
      }
    });
  }
}
```

**AI agents send:**

```json
{
  "projectId": "proj-123",
  "actions": [
    ["create-task", {"title": "Implement login", "priority": 5}],
    ["create-task", {"title": "Write tests", "priority": 3}],
    ["update-task", {"taskId": "task-456", "title": "Fix auth bug", "priority": 10}]
  ]
}
```

**What happens:**
1. Validation phase - all actions validated before execution
2. Context snapshot - `projectId` frozen for batch
3. Sequential execution - actions run in order
4. Atomic validation - if ANY action fails validation, NOTHING executes

All actions see identical context. Mid-batch drift is structurally impossible.

### How Fragmentation is Prevented

**Discovery sandbox boundaries:**

Discovery tools execute in Scheme interpreter with strict isolation:
- **Allowed**: Registered functions, pure Scheme stdlib (filter, map, reduce, etc.)
- **Blocked**: Filesystem, network, unregistered functions, side effects

Errors stay isolated. If Scheme expression throws, it returns as data. No unwinding, no panic, no fragmentation.

**Action batch atomicity:**

- Context snapshot captured at batch start: `{ projectId: "proj-123" }`
- All actions see identical context - no mid-batch changes
- Upfront validation - if action 3 of 5 fails, actions 1-2 don't run
- Prevents classic pattern: explore with context A, execute with context B, panic to checkpoint C

**Phase separation:**

Discovery produces inert data. No side effects, no state changes. Pure exploration.

Actions are explicit commits. The AI must construct valid batch - can't "accidentally execute."

## Standard MCP Compatibility

Arrival builds **on top** of Model Context Protocol, not replacing it.

- Discovery tools return S-expression strings (standard MCP text responses)
- Action tools return JSON arrays (standard MCP structured responses)
- Discovery/action separation happens server-side through tool design
- Any MCP client works: Claude Desktop, Claude Code, Cursor, etc.

You can mix Arrival tools with standard MCP tools in the same server.

## Security Status

⚠️ **version 0.x is likely unsafe - use zero-trust environments only**

The Scheme sandbox (forked from LIPS.js) contains known architectural issues from deep JavaScript integration. We've identified potential attack vectors (missing reentrancy checks, prototype access paths) but haven't fully characterized or fixed them.

**Current status (0.x)**:
- **Probably exploitable** by determined attackers
- **Not externally audited**
- **Use only in isolated containers with zero-trust architecture**

**Planned for 1.x**:
- External security audit
- Architecture hardening
- Formal threat model
- Production-ready isolation guarantees

**How we use 0.x**:
- Zero-trust containers. MCP runtime has access only to current user bearer token
- Timeouts on all expressions (5s default)
- Resource monitoring and limits
- Assume sandbox can be escaped

**Do not**:
- Expose to untrusted user input directly
- Deploy without containerization or any other means of isolation
- Use in security-critical contexts
- Trust sandbox isolation without additional defenses

We welcome security researchers to review and responsibly disclose findings: team@here.build or @merkle_bonsai (Telegram/X)

## Context Management

Arrival uses Hono as HTTP framework. Three levels of state:

**Request context (Hono)** - per HTTP request:
```typescript
app.use('*', async (c, next) => {
  c.set('database', myDatabase);
  c.set('user', await getUser(c));
  return next();
});
```
Available as `this.context` in tools.

**Session state** - across tool calls:
```typescript
async executeTool(args) {
  this.state.lastQuery = args.expr; // Persists across calls
  this.state.queryCount = (this.state.queryCount || 0) + 1;
}
```
Keyed by `Mcp-Session-Id` header. Override `getSessionState`/`setSessionState` for Redis/etc.

**Execution focus** - what batch operates on:
```typescript
class MyAction extends ActionToolInteraction<{ projectId: string }> {
  readonly contextSchema = {
    projectId: z.string()
  };
}
```
Snapshot captured at batch start, immutable for all actions.

## Performance Characteristics

**Token efficiency** (measured):
- S-expression serialization: 30-60% reduction vs JSON for structured data
- Tool definitions: 5x more tools in same token budget
- [Detailed explanation](../arrival-serializer/README.md#best-practices)

**Session coherence** (observational, needs validation):
- 50+ tool calls without drift in production
- Standard architectures: 10-20 calls before fragmentation
- Needs controlled experiments and independent replication

**Execution overhead** (not yet benchmarked):
- Scheme sandbox adds interpretation cost
- Batch validation adds upfront latency
- Context snapshotting minimal overhead
- Needs profiling and optimization

BUT:
- Discovery queries reduce the data transferred significantly, while allowing complex requests, not just data batching with filters - e.g. "What are top-priority tasks of my colleague I've just assigned current task? How many story points does he have in total in front of my task?"
- Action burst batching reduces roundabouts
- Plexus-Arrival integration enables full state presence at the moment of invocation and server response BEFORE state is synced - for here.build, we execute state changes locally, respond to MCP tool call and expect sync as a side effect

## When NOT to Use Arrival

**Use standard MCP when:**
- Simple CRUD operations - single-step, straightforward
- JSON is fine for your data - no complex composition needed
- Low tool count - token efficiency doesn't matter
- Immediate execution preferred - no need for exploration phase

**Use Arrival for:**
- Complex multi-step tasks requiring exploration
- Compositional queries over data
- Token efficiency matters (large tool sets)
- Session coherence critical (long-running agents)

## Research

Arrival embeds a working hypothesis about AI agent fragmentation. See [fragmentation hypothesis](../../docs/research/fragmentation-hypothesis.md) for details, limitations, and collaboration opportunities.

## What's Inside

- **[@here.build/arrival-serializer](../arrival-serializer/)** - S-expression serialization with `Symbol.toSExpr` protocol
- **[@here.build/arrival-scheme](../arrival-scheme/)** - Modified LIPS interpreter for sandboxed exploration
- **[@here.build/arrival-mcp](../arrival-mcp/)** - MCP meta-framework with discovery/action separation on Hono
- **[@here.build/arrival-env](../arrival-env/)** - Protocol definitions for shared libraries

Packages work together but can be used independently.

## Contributing

Early-stage open source. We're interested in:

- Security review of Scheme sandbox
- Controlled drift benchmarks vs standard MCP
- Migration guides from existing tools
- Documentation of failure modes
- Validation or refutation of fragmentation hypothesis
- General contributions to Scheme sandbox, Rosetta layer improvements and opaque pointer representations
- MCP server general improvements and spec compliance

## License

Future MIT (irrevocable, effective starting January 1, 2027).

Until then: MIT terms except for three specific commercial uses. See [LICENSE.md](../../LICENSE.md) for complete terms.
