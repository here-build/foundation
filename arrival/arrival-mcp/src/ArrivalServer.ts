import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { Constructor } from "type-fest";

import { dispatchTool, getToolDefinitions } from "./dispatch.js";
import type { ResourceProvider } from "./resources/index.js";
import type { ArrivalSessionStore } from "./store.js";
import type { ToolInteraction, MCPClientInfo } from "./ToolInteraction.js";

/**
 * Pluggable session state storage.
 * Default: in-memory Map on the session object.
 * Override for Durable Objects, Redis, etc.
 */
export interface SessionStore {
  get(context: Context, sessionId: string): Promise<Record<string, any>>;

  set(context: Context, sessionId: string, state: Record<string, any>): Promise<void>;

  delete(context: Context, sessionId: string): Promise<void>;
}

interface Session {
  id?: string;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  currentContext?: Context;
  state: Record<string, any>;
}

export interface ArrivalServerOptions {
  name: string;
  version: string;
  tools: Constructor<ToolInteraction<any>>[];
  instructions?: string;
  sessionStore?: SessionStore;
  /** Pluggable interaction store for recording all tool calls, intents, and errors. */
  arrivalStore?: ArrivalSessionStore;
  /** Optional resource provider. When set, advertises MCP `resources` capability. */
  resourceProvider?: ResourceProvider;
}

/**
 * MCP server built on the official SDK transport + arrival-mcp tool patterns.
 *
 * Manages per-session SDK Server + Transport pairs.
 * Routes Hono requests to the right session.
 * Threads Hono context to tool handlers.
 *
 * Usage:
 * ```typescript
 * const server = new ArrivalServer({
 *   name: "my-server",
 *   version: "1.0.0",
 *   tools: [MyDiscoveryTool, MyActionTool],
 * });
 *
 * app.all("/mcp", (c) => server.handleRequest(c));
 * ```
 */
export class ArrivalServer {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: ArrivalServerOptions) {}

  /**
   * Handle an incoming Hono request. Routes to the correct session
   * or creates a new one for initialize requests.
   */
  async handleRequest(c: Context): Promise<Response> {
    const sessionId = c.req.header("mcp-session-id");

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.currentContext = c;

        // Load state from external store if configured
        if (this.options.sessionStore) {
          session.state = await this.options.sessionStore.get(c, sessionId);
        }

        const response = await session.transport.handleRequest(c.req.raw);

        // Persist state after request completes
        if (this.options.sessionStore) {
          await this.options.sessionStore.set(c, sessionId, session.state);
        }

        return response;
      }

      // DELETE for unknown/expired session — clean response
      if (c.req.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
    }

    // No session or unknown session — create new
    const session = await this.createSession(c);
    session.currentContext = c;
    return session.transport.handleRequest(c.req.raw);
  }

  private async createSession(initialContext: Context): Promise<Session> {
    const sessionId = crypto.randomUUID();
    const session: Session = {
      id: undefined,
      server: undefined as any,
      transport: undefined as any,
      currentContext: initialContext,
      state: {},
    };

    // Record session start
    this.options.arrivalStore?.startSession({
      id: sessionId,
      startedAt: Date.now(),
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        this.sessions.set(id, session);
      },
      onsessionclosed: async (id) => {
        if (this.options.sessionStore && session.currentContext) {
          await this.options.sessionStore.delete(session.currentContext, id);
        }
        this.sessions.delete(id);
      },
    });

    const server = new Server(
      { name: this.options.name, version: this.options.version },
      {
        capabilities: {
          tools: {},
          ...(this.options.resourceProvider ? { resources: {} } : {}),
        },
        instructions: this.options.instructions,
      },
    );

    session.transport = transport;
    session.server = server;

    this.setupHandlers(server, session);
    await server.connect(transport);

    return session;
  }

  private setupHandlers(server: Server, session: Session) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const clientInfo = server.getClientVersion() as MCPClientInfo | undefined;
      return {
        tools: await getToolDefinitions(this.options.tools, session.currentContext!, session.state, clientInfo),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const clientInfo = server.getClientVersion() as MCPClientInfo | undefined;
      return dispatchTool(
        this.options.tools,
        session.currentContext!,
        session.state,
        request.params,
        clientInfo,
        this.options.arrivalStore,
        session.id,
      );
    });

    const { resourceProvider } = this.options;
    if (resourceProvider) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        try {
          return { resources: await resourceProvider.list(session.currentContext!, session.state) };
        } catch (error) {
          throw asMcpError(error);
        }
      });

      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        try {
          return {
            contents: await resourceProvider.read(session.currentContext!, session.state, request.params.uri),
          };
        } catch (error) {
          throw asMcpError(error);
        }
      });
    }
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.server.close();
    }
    this.sessions.clear();
  }
}

/**
 * Duck-type errors carrying a numeric `code` (e.g. a domain ResourceError) as
 * MCP wire errors so the SDK serializes the code into the JSON-RPC response.
 * Without this, typed application errors degrade to generic -32603.
 */
function asMcpError(e: unknown): unknown {
  if (e instanceof McpError) return e;
  if (e != null && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "number") {
    const err = e as { code: number; message?: string };
    return new McpError(err.code, err.message ?? String(err));
  }
  return e;
}
