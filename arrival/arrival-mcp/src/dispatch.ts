import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import invariant from "tiny-invariant";
import type { Constructor } from "type-fest";

import type { ArrivalSessionStore, ErrorType } from "./store";
import type { ToolInteraction, MCPClientInfo, UserlandCallToolResult } from "./ToolInteraction";

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Serialize userland results (string | object | Blob) to MCP CallToolResult format.
 */
export async function serializeResult(
  callToolResult: UserlandCallToolResult | UserlandCallToolResult[],
): Promise<CallToolResult> {
  const isError =
    callToolResult != null &&
    typeof callToolResult === "object" &&
    !Array.isArray(callToolResult) &&
    "success" in callToolResult &&
    callToolResult.success === false;

  return {
    content: await Promise.all(
      asArray(callToolResult).map(async (result): Promise<CallToolResult["content"][number]> => {
        switch (true) {
          case typeof result === "string":
            return { type: "text", text: result };
          case result instanceof Blob && result.type.startsWith("image/"):
          case result instanceof Blob && result.type.startsWith("audio/"): {
            let binary = "";
            const bytes = new Uint8Array(await result.arrayBuffer());
            const length_ = bytes.byteLength;
            for (let index = 0; index < length_; index++) {
              binary += String.fromCodePoint(bytes[index]);
            }
            return {
              type: result.type.split("/")[0] as "image" | "audio",
              data: btoa(binary),
              mimeType: result.type,
            };
          }
          default:
            return { type: "text", text: JSON.stringify(result) };
        }
      }),
    ),
    isError,
  };
}

/**
 * Classify an error into an ErrorType for the store.
 */
function classifyError(error: unknown, toolName?: string): { errorType: ErrorType; errorMessage: string } {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("Unknown tool") || msg.includes("Unknown action"))
      return { errorType: "unknown_action", errorMessage: msg };
    if (msg.includes("validation") || msg.includes("Validation")) return { errorType: "validation", errorMessage: msg };
    if (msg.includes("Parse Error")) return { errorType: "parse", errorMessage: msg };
    if (msg.includes("Unbound variable") || msg.includes("is not defined"))
      return { errorType: "eval", errorMessage: msg };
    if (msg.includes("timeout") || msg.includes("Timeout")) return { errorType: "timeout", errorMessage: msg };
    return { errorType: "runtime", errorMessage: msg };
  }
  return { errorType: "runtime", errorMessage: String(error) };
}

/**
 * Dispatch a tool call: find the tool class, instantiate, execute, serialize result.
 * Pure logic — no transport, no protocol, no session management.
 *
 * When `store` is provided, records every interaction (success and failure).
 * Store writes are fire-and-forget — never block the response.
 */
export async function dispatchTool(
  tools: Constructor<ToolInteraction<any>>[],
  context: Context,
  state: Record<string, any>,
  request: { name: string; arguments?: Record<string, unknown> },
  clientInfo?: MCPClientInfo,
  store?: ArrivalSessionStore,
  sessionId?: string,
): Promise<CallToolResult> {
  const startTime = Date.now();
  const intent = request.arguments?.intent as string | undefined;

  // Unknown tool
  const ToolClass = tools.find(({ name }) => name === request.name);
  if (!ToolClass) {
    const interaction = {
      id: crypto.randomUUID(),
      sessionId: sessionId ?? "unknown",
      timestamp: startTime,
      tool: request.name,
      intent,
      arguments: request.arguments ?? {},
      success: false as const,
      durationMs: Date.now() - startTime,
      errorType: "unknown_action" as const,
      errorMessage: `Unknown tool: ${request.name}. Available: ${tools.map(({ name }) => name).join(", ")}`,
    };
    store?.recordInteraction(interaction);
    invariant(false, interaction.errorMessage);
  }

  const tool = new ToolClass(context, state, request.arguments);
  console.log("calling MCP", request.name, request.arguments);

  try {
    const result = await tool.executeTool(clientInfo);
    const serialized = await serializeResult(result);

    // Record success (or validation failure — success=false from tool)
    const isError = serialized.isError ?? false;
    if (store) {
      const resultText = serialized.content.map((c: any) => ("text" in c ? c.text : "")).join("\n");
      store.recordInteraction({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? "unknown",
        timestamp: startTime,
        tool: request.name,
        intent,
        arguments: request.arguments ?? {},
        success: !isError,
        resultSummary: resultText.slice(0, 500),
        durationMs: Date.now() - startTime,
        ...(isError ? classifyError(new Error(resultText)) : {}),
      });
    }

    return serialized;
  } catch (error) {
    // Record runtime/eval/parse errors
    const { errorType, errorMessage } = classifyError(error);
    if (store) {
      store.recordInteraction({
        id: crypto.randomUUID(),
        sessionId: sessionId ?? "unknown",
        timestamp: startTime,
        tool: request.name,
        intent,
        arguments: request.arguments ?? {},
        success: false,
        durationMs: Date.now() - startTime,
        errorType,
        errorMessage,
      });
    }
    throw error;
  }
}

/**
 * Get tool definitions from all registered tool classes.
 * Pure logic — no transport, no protocol.
 */
export async function getToolDefinitions(
  tools: Constructor<ToolInteraction<any>>[],
  context: Context,
  state: Record<string, any>,
  clientInfo?: MCPClientInfo,
): Promise<ListToolsResult["tools"]> {
  const definitions: ListToolsResult["tools"] = [];
  for (const ToolClass of tools) {
    try {
      const tool = new ToolClass(context, state);
      definitions.push(await tool.getToolDescription(clientInfo));
    } catch (error) {
      console.warn(`Failed to get definition for ${ToolClass.name}:`, error);
    }
  }
  return definitions;
}
