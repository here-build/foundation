# MCP Framework

Framework for building Model Context Protocol (MCP) servers with clean separation of concerns.

## Architecture

### Core Components

**`MCPServer`** - Protocol-only MCP server
- Manages tools and their lifecycle
- Handles session state (override `getSessionState`, `setSessionState`, `deleteSessionState` for Redis/etc)
- No transport concerns

**`HonoMCPServer`** - HTTP/SSE transport layer
- Bridges HTTP requests to `MCPServer`
- Supports both JSON-RPC and SSE response modes
- Handles session creation/cleanup

**`ToolInteraction`** - Base class for tools (generally internal)
- Access to Hono context: `this.context`
- Access to session state: `this.state`
- Define schema and execution logic

**`DiscoveryToolInteraction`** - Tools that execute Scheme expressions
- Sandboxed, readonly LIPS environment
- Register functions for domain-specific operations
- Returns serialized results

**`ActionToolInteraction`** - Tools with batched, focused action bursts
- Define actions with context constraints
- Batch execution with validation
- Shared context across all actions in batch

## Quick Start

### Define a Tool

```typescript
import { DiscoveryToolInteraction, ActionToolInteraction } from "@here.build/arrival-mcp";
import * as z from 'zod';

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

class UpdateTasks extends ActionToolInteraction<{ projectId: string }> {
    static readonly name = 'update-tasks';
    readonly description = 'Edit tasks';

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

### Create Server

```typescript
import { Hono } from "hono";
import { HonoMCPServer } from "@here.build/arrival-mcp";

const honoServer = new HonoMCPServer(MyTool, OtherTool);

const app = new Hono();

app
  .get("/", honoServer.get)
  .post("/", honoServer.post)
  .delete("/", honoServer.delete);

export default app;
```

## Session Management

Sessions are managed automatically via `Mcp-Session-Id` header.

**Default (in-memory):**
```typescript
const mcpServer = new MCPServer(tools...);
// Sessions stored in Map
```

**Production (Redis):**
```typescript
class RedisMCPServer extends MCPServer {
  protected async getSessionState(context, sessionId) {
    const data = await context.env.REDIS.get(`mcp:${sessionId}`);
    return data ? JSON.parse(data) : {};
  }

  protected async setSessionState(context, sessionId, state) {
    await context.env.REDIS.set(
      `mcp:${sessionId}`,
      JSON.stringify(state),
      { EX: 3600 }
    );
  }

  protected async deleteSessionState(context, sessionId) {
    await context.env.REDIS.del(`mcp:${sessionId}`);
  }
}
```

## SSE Support

The framework supports both JSON-RPC and SSE response modes:

**JSON-RPC (default):**
```
POST /mcp
Content-Type: application/json

→ JSON response
```

**SSE per-request:**
```
POST /mcp
Accept: text/event-stream

→ SSE stream with single response event, then closes
```

**SSE persistent:**
```
GET /mcp
Accept: text/event-stream

→ SSE stream stays open for server notifications
```

## Testing

```bash
npm test
```

Tests cover:
- Session persistence across requests
- Session isolation between clients
- State mutations (counters, arrays)
- Backward compatibility (no session ID)
- Tool definitions with state
- Session cleanup
- Custom storage overrides
