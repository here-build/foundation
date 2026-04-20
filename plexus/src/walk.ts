/* eslint-disable @typescript-eslint/no-shadow */
/**
 * Zimmerframe-inspired tree walker for Plexus models.
 *
 * Unlike generic AST walkers, we know the schema - so we walk only
 * child fields (child-val, child-list, child-record, child-set).
 */

import invariant from "tiny-invariant";

import { PlexusModel } from "./PlexusModel.js";

const isPlexusModel = (value: unknown): value is PlexusModel => value instanceof PlexusModel;

export interface WalkContext<State, Models extends Record<string, PlexusModel>> {
  state: State;
  path: Models[keyof Models][];
  next: (state?: State) => void;
  stop: () => void;
  visit: <T extends Models[keyof Models]>(node: T, state?: State) => void;
}

export type Visitor<Models extends Record<string, PlexusModel>, T extends PlexusModel, State> = (
  node: T,
  context: WalkContext<State, Models>,
) => void;

export type Visitors<Models extends Record<string, PlexusModel>, State> = {
  [K in keyof Models]?: Visitor<Models, Models[K], State>;
};

export function walk<Models extends Record<string, PlexusModel>, State = unknown>(
  node: Models[keyof Models],
  state: State,
  visitors: Visitors<Models, State>,
): void {
  let stopped = false;

  function visitNode(node: Models[keyof Models], path: PlexusModel[], state: State): void {
    if (stopped) return;

    const typeName = node.__type__;
    const specific = visitors[typeName as keyof Models] as Visitor<Models, PlexusModel, State> | undefined;

    let childState = state;
    // If handler exists, it must call next() to walk children
    // If no handler, auto-walk children
    let shouldWalkChildren = !specific;

    const context: WalkContext<State, Models> = {
      state,
      path: path as Models[keyof Models][],
      next: (nextState?: State) => {
        childState = nextState ?? state;
        shouldWalkChildren = true;
      },
      stop: () => {
        stopped = true;
      },
      visit: (childNode, visitState) => {
        visitNode(childNode, [...path, node], visitState ?? state);
      },
    };

    // Run type-specific visitor
    if (specific) {
      specific(node, context);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopped is set via context.stop() callback
      if (stopped) return;
    }

    // Walk children if next() was called or no handler existed
    if (shouldWalkChildren) {
      walkChildren(
        node,
        [...path, node],
        childState,
        visitNode as (node: PlexusModel, path: PlexusModel[], state: State) => void,
      );
    }
  }

  visitNode(node, [], state);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- simple repeated pattern across field types
export function walkChildren<State>(
  node: PlexusModel,
  path: PlexusModel[],
  state: State,
  visit: (node: PlexusModel, path: PlexusModel[], state: State) => void,
): void {
  const schema = node.__schema__;

  for (const [key, fieldType] of Object.entries(schema)) {
    // Only walk child fields
    if (!fieldType.startsWith("child-")) continue;

    const value = node[key];
    if (value == null) continue;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- filtered by startsWith("child-") above
    switch (fieldType) {
      case "child-val":
        if (isPlexusModel(value)) {
          visit(value, path, state);
        }
        break;

      case "child-list":
        for (const item of value) {
          if (isPlexusModel(item)) {
            visit(item, path, state);
          }
        }
        break;

      case "child-record":
        for (const item of Object.values(value)) {
          if (isPlexusModel(item)) {
            visit(item, path, state);
          }
        }
        break;

      case "child-set":
        for (const item of value as Set<unknown>) {
          if (isPlexusModel(item)) {
            visit(item, path, state);
          }
        }
        break;

      case "child-map":
        for (const item of (value as Map<unknown, unknown>).values()) {
          if (isPlexusModel(item)) {
            visit(item, path, state);
          }
        }
        break;
    }
  }
}

export const buildVisitor =
  <Models extends Record<string, PlexusModel>>() =>
  <Visitors extends { [key in keyof Models]?: (node: Models[key]) => unknown }>(handlers: Visitors) =>
    function visit<Key extends Extract<keyof Models, Extract<keyof Visitors, string>>, Model extends Models[Key]>(
      node: Model,
    ) {
      const typeName = node.__type__ as Key;
      const handler = handlers[typeName];

      invariant(handler, `No handler for node type: ${typeName}`);
      return handler(node);
    } as <NodeArg extends Partial<Models>[Extract<keyof Models, keyof Visitors>]>(
      node: NodeArg,
    ) => {
      [key in keyof Models]: Models[key] extends NodeArg
        ? Visitors[key] extends (...args: any) => infer R
          ? R
          : any
        : never;
    }[keyof Models];
