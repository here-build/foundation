/**
 * The application supplies a `ResourceProvider`; the framework wires it to the `resources/list`
 * and `resources/read` MCP requests. Design rationale: docs/proposals/in-flight/arrival-resources.md
 */

import type { Resource, TextResourceContents, BlobResourceContents } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";

export type ArrivalResourceContents = TextResourceContents | BlobResourceContents;

export interface ResourceProvider {
  /** v1 typically returns [] — clients construct URIs from discovery-tool responses instead. */
  list(context: Context, state: Record<string, any>): Promise<Resource[]>;

  /** Rejects with a classified error for not-found, malformed-URI, and auth-denied cases. */
  read(context: Context, state: Record<string, any>, uri: string): Promise<ArrivalResourceContents[]>;
}

export const ARRIVAL_RESOURCE_MIME = "application/vnd.here-build.arrival.entity+json; v=1";
