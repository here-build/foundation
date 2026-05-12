/**
 * MCP Resources support for arrival framework.
 *
 * Application provides a `ResourceProvider` that resolves URIs to content.
 * Framework wires `resources/list` and `resources/read` MCP requests to it.
 *
 * See docs/proposals/in-flight/arrival-resources.md for design rationale.
 */

import type {
  Resource,
  TextResourceContents,
  BlobResourceContents,
} from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";

export type ArrivalResourceContents = TextResourceContents | BlobResourceContents;

export interface ResourceProvider {
  /**
   * Enumerate resources visible to the session.
   * v1: typically returns [] — clients construct URIs from discovery tool responses.
   */
  list(context: Context, state: Record<string, any>): Promise<Resource[]>;

  /**
   * Resolve a URI to one or more content items.
   * Throws (or returns rejected Promise) with classified error for not-found,
   * malformed URI, auth-denied cases.
   */
  read(
    context: Context,
    state: Record<string, any>,
    uri: string,
  ): Promise<ArrivalResourceContents[]>;
}

export const ARRIVAL_RESOURCE_MIME = "application/vnd.here-build.arrival.entity+json; v=1";
