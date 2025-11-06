import { SSEStreamingApi, streamSSE } from "hono/streaming";
import { MCPServer } from "../MCPServer";
import { JSONRPCRequest, ServerResult } from "@modelcontextprotocol/sdk/types.js";

export type MCPClientInfo = Record<string, any>;
/**
 * Hono HTTP/SSE handler for MCPServer
 * Bridges HTTP requests to MCPServer protocol methods
 */
export class HonoMCPServer extends MCPServer {
  public serverInfo: ServerResult = {
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "",
      version: "0.0.0",
    },
    capabilities: {
      tools: { list: true },
    },
  }

  clientInfo = new Map<string, MCPClientInfo>();

  // todo narrow down types
  protected async processJsonRpcRequest<Request extends JSONRPCRequest>(context: import("hono").Context, method: Request['method'], params: Request["params"], sessionId: string) {
    switch (method) {
      case "initialize":
        if (params?.clientInfo) {
          this.clientInfo.set(sessionId, params.clientInfo)
        }
        return this.serverInfo;

      case "tools/list":
        return {
          tools: await this.getToolDefinitions(context, this.clientInfo.get(sessionId)),
        };

      case "tools/call":
        try {
          return await this.callTool(context, params as any, this.clientInfo.get(sessionId));
        } catch (error) {
          console.error("[HonoMCPServer] Tool execution error:", error);
          throw {
            code: -32_603,
            message: (error as any).publicMessage ?? "Tool execution failed",
            data: {
              errorMessage: error instanceof Error ? (error as any).publicMessage ?? error.message : error?.toString(),
            }
          };
        }

      case "resources/list":
      case "resources/read":
        throw {
          code: -32_601,
          message: "Resources not implemented yet",
        }

      case "prompts/list":
      case "prompts/get":
        throw {
          code: -32_601,
          message: "Prompts not implemented yet",
        };

      case "logging/setLevel":
        console.log(`[HonoMCPServer] Logging level set to: ${params?.level}`);
        return;

      case "completion/complete":
        throw {
          code: -32_601,
          message: "Completion not implemented",
        };

      case "sampling/createMessage":
        throw {
          code: -32_601,
          message: "Sampling not implemented",
        }

      case "ping":
        return {};

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      default:
        throw {
          code: -32_601,
          message: `Method not found: ${method}`,
        }
    }
  }

  protected async processRequest(context: import("hono").Context, {id, method, params}: JSONRPCRequest, sessionId: string) {
    try {
      const result = await this.processJsonRpcRequest(context, method, params, sessionId);
      return result === null ? null : {
        jsonrpc: "2.0",
        id,
        result,
      }
    } catch (error) {
      if (error instanceof Error) {
       return {
         jsonrpc: "2.0",
         id,
         error: {
           code: (error as any).code ?? -1,
           message: (error as any).publicMessage ?? error.message
         },
       }
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error,
        }
      }
    }
  }

  outputSSE = new Map<string, SSEStreamingApi>();

  get = async (context: import("hono").Context): Promise<Response> => {
    const sessionId = context.req.header("Mcp-Session-Id") ?? crypto.randomUUID();
    context.res.headers.set("Mcp-Session-Id", sessionId);
    const wantsSSE = context.req.header("accept")?.includes("text/event-stream");
    console.log(`client connected, wants ${context.req.header("accept")}`)
    if (!wantsSSE) {
      console.warn("GET request do not want SSE")
      return context.json({
        jsonrpc: "2.0",
        result: this.serverInfo
      })
    }

    return streamSSE(context, async (stream) => {
      console.log("[HonoMCPServer] notifications channel opened, session id", sessionId);
      this.outputSSE.set(sessionId, stream);
      await stream.sleep(60_000);
    });
  }

  post = async (context: import("hono").Context): Promise<Response> => {
    const sessionId = context.req.header("Mcp-Session-Id") ?? crypto.randomUUID();
    context.res.headers.set("Mcp-Session-Id", sessionId);

    const request = await context.req.json<JSONRPCRequest>();

    const wantsSSE = context.req.header("accept")?.includes("text/event-stream");


    // If client wants SSE for this POST request
    if (wantsSSE) {
      console.log(`[HonoMCPServer] SSE: ${request.method}`, request.params)
      return streamSSE(context, async (stream) => {
        const response = await this.processRequest(context, request, sessionId);
        console.log(`[HonoMCPServer] SSE response:`, response)
        if (response) {
          await stream.writeSSE({
            data: JSON.stringify(response),
          });
        }
        await stream.close();
      });
    } else {
      console.log(`[HonoMCPServer] HTTP: ${request.method}`, request.params)
      const response = await this.processRequest(context, request, sessionId);
      console.log(`[HonoMCPServer] HTTP response:`, response)
      return context.json(response)
    }
  };

  delete = async (context: import("hono").Context): Promise<Response> => {
    const sessionId = context.req.header("Mcp-Session-Id");

    if (sessionId) {
      this.outputSSE.get(sessionId)?.abort();
      console.log(`[HonoMCPServer] Deleting session: ${sessionId}`);
      await this.deleteSession(context, sessionId);
    }

    return context.json({ success: true });
  };
}
