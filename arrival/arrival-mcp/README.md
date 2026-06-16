# @here.build/arrival-mcp

Build [Model Context Protocol](https://modelcontextprotocol.io) tools as **plain values** and register
them on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
server. No bespoke server framework, no base classes to subclass — a tool is an object with `name`,
`describe()`, and `call()`.

Two tiers sit over one shared capability:

- **`DiscoveryTool`** — the read tier. The actor sends a Scheme (Lisp) expression that runs in a
  sandboxed REPL over your capability's symbols. One round-trip explores arbitrarily deep — filter, map,
  compose — instead of N rigid getter calls.
- **`ActionTool`** — the mutation tier. The actor sends a *batch* of typed `[name, {props}]` actions that
  share one validated context scope and run sequentially, with rollback-report on the first failure.

Both derive their entire MCP surface (input schema, catalog, validation, eval) from a single
**`McpEnvCapability`** — the verbs, their config, and the resources they read.

## Install

```sh
pnpm add @here.build/arrival-mcp @modelcontextprotocol/sdk
```

## Discovery tool — a read sandbox

A capability declares **symbols** (the verbs), optional **configuration** (typed per-call args the actor
supplies), and optional **resources** (per-call host handles the verbs read). `DiscoveryTool` turns it
into a read-only Scheme REPL.

```ts
import { DiscoveryTool, McpEnvCapability } from "@here.build/arrival-mcp";

const capability = new McpEnvCapability("projects", {
  symbols: {
    user: {
      fn: () => db.currentUser(),
      description: "the current user",
      // Optional LIVE catalog text, resolved at tools/list — the per-session "welcome screen".
      dynamicDescription: async () => `the current user (${(await db.currentUser()).name})`,
    },
    projects: {
      fn: () => db.allProjects(),
      description: "every project the user can open",
    },
  },
});

const discovery = new DiscoveryTool("discover", capability, {
  description: "Read-only discovery sandbox.",
});

// The actor sends Scheme; each top-level form returns one message. Compose stdlib (filter / map /
// fold / lambda) over your verbs in a single call instead of N rigid getter round-trips.
await discovery.call({ expr: "(length (filter (lambda (p) #t) (projects)))" }, { session });
```

The actor sees `user`, `projects` (plus the base Scheme stdlib) advertised in the tool's input schema,
and can compose them freely in one call. Resources auto-spawn on first touch and are read inside a verb
via `this.resources.<name>.live` — authorization is simply a resource that refuses to spawn.

## Action tool — a batched mutation burst

Actions are declared with **`FieldSpec`** types (not bare zod), because a context/prop field may be a
**`Ref`** that resolves a UUID / name / instance against the *live* context (a `"Card"` → the actual
`Component`). zod `.transform()` can't see runtime context; refs can. The shared `context` is validated
**once per batch**, so N actions don't each re-declare it.

```ts
import { ActionTool, str, defineRef, uuidShape, nameShape } from "@here.build/arrival-mcp";

const componentRef = defineRef<Component, { site: Site }>({
  typeName: "Component",
  desc: "a component by uuid or name",
  shapes: [
    uuidShape((id, ctx) => ctx.site.componentByUuid(id)),
    nameShape((name, ctx) => ctx.site.componentByName(name)),
  ],
});

const editing = new ActionTool<{ projectId: string; component?: Component }, { site: Site }>("edit", {
  description: "Mutate the project.",
  context: { projectId: str("the project id"), component: componentRef },
  // Runs once per batch (after primitive ctx parses, before refs resolve). Its result merges into the
  // ctx every handler + ref sees. Closes over your host infra — no separate services injection.
  prepare: async (ctx) => ({ prep: { site: await loadSite(ctx.projectId) } }),
  // Make the whole burst atomic (the canonical CRDT case: pause sync, run, flush once).
  wrapBatch: async (ctx, runBatch) => {
    await ctx.site.pauseSync();
    try {
      return await runBatch();
    } finally {
      await ctx.site.resumeSync();
    }
  },
  actions: (b) => [
    b.act({
      name: "rename",
      needs: ["component"], // narrows ctx.component to non-optional in the handler
      desc: "rename a component",
      props: { name: str("the new name") },
      handle: (ctx, _receiver, { name }) => ctx.component.rename(name),
    }),
  ],
});

await editing.call(
  { intent: "tidy names", projectId: "p1", component: "Card", actions: [["rename", { name: "ProductCard" }]] },
  { session },
);
```

Extra power, all optional:

- **Clusters** (`defineCluster`) — author actions against a `Ctx` shape and compose groups: `clusters: [treeActions, styleActions, …]`.
- **Receiver-dispatch** — one action *name*, different handler per receiver class: `b.act({ name: "set", on: TplTag, … })` vs `on: TplComponent`. Dispatch is exact-class on `ctx[receiverKey]`.
- **`beforeDispatch`** — normalize ctx after refs resolve (e.g. default `element` to the component root).
- **`shapeResponse`** — customize the success envelope.
- **`timeouts` / `limits`** — per-phase deadlines + batch size caps.

A handler failure stops the batch and returns a partial report (`{ success: false, partial: true, executed, failedAction, … }`); a validation failure runs nothing.

## Registering on a server

`registerTools` wires any number of value tools onto an official `McpServer` — `describe()` → `tools/list`,
`call()` → `tools/call`, with results lowered by the one `serializeResult`. The catalog is dynamic
(re-`describe`d per `tools/list`, so the personalized welcome refreshes).

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "@here.build/arrival-mcp";

const server = new McpServer({ name: "my-app", version: "0.1.0" }, { capabilities: { tools: {} } });
registerTools(server, [discovery, editing], (params) => ({ session: resolveSession(params) }));
await server.connect(transport);
```

The optional resolver maps each call to its **`ToolCallCtx`** — `{ session, user, signal, record }` — which
lives *above* the eval membrane, so a sandboxed run can't reach session identity or another call's state.
The transport's `AbortSignal` is threaded in automatically.

## Surface

| Export | What it is |
|---|---|
| `McpEnvCapability` | The shared env: `symbols` (verbs), `configuration` (typed args), `resources`, `annotations`. |
| `DiscoveryTool` | `new DiscoveryTool(name, capability, { description, budgetMs? })` — the read REPL tier. |
| `ActionTool` | `new ActionTool(name, { description, context, clusters?/actions?, prepare?, wrapBatch?, … })` — the batch mutation tier. |
| `defineCluster`, `Act`, `ActBuilder` | Compose action groups authored against a `Ctx`. |
| refs: `str` `num` `bool` `oneOf` `scalar` `stringRecord` `rawList` `optional` `defineRef` `uuidShape` `nameShape` `objectShape` `instanceShape` | The `FieldSpec` system backing action context + props (ctx-aware resolution). |
| `registerTools`, `serializeResult` | Wire onto / lower for the official SDK server. |
| `MCPError`, `withTimeout`, size limits | The typed error kernel used by dispatch. |

## Design

- **Tools are values, not subclasses.** A tool is `{ name, describe, call }`. Everything else (schema,
  catalog, eval) derives from the capability.
- **One faithful transport.** No custom protocol or session layer — the official SDK is the server; this
  package is the tool shape + the `registerTools` seam.
- **Intent over materialization.** Verbs wrap what the actor *means* (`rename`, `deploy`), never the
  plumbing underneath (sync pausing, z-index, release pins). The three host concerns enter at three
  distinct membrane times — eval (resources), dispatch (`ToolCallCtx`), describe (the welcome) — and never
  co-mingle.

## Develop

```sh
pnpm build       # tsc → dist
pnpm test        # vitest
pnpm typecheck
pnpm lint
```
