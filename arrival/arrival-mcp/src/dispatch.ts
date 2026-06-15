import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What a value-shape tool's `call` returns before transport lowering: plain text/object/Blob. */
export type UserlandCallToolResult = File | string | object;

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Userland returns plain strings/objects/Blobs; this lowers them to MCP `CallToolResult`. The one
 * shared lowering: `registerTools` (sdk-adapter) uses it for the official transport, and the custdev
 * loops use it directly. Convention: an object with `success: false` marks the call as an error WITHOUT
 * throwing — so a tool can report a soft failure (e.g. validation) as data, not an exception.
 *
 * (The legacy class-array dispatch — `dispatchTool` / `getToolDefinitions` — was removed with the
 * `ToolInteraction` stack; value-shape tools are dispatched by `registerTools` / `.call()` directly.)
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
            for (const byte of bytes) binary += String.fromCodePoint(byte);
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
