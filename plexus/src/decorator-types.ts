import type { PlexusModel } from "./PlexusModel.js";
import type { AllowedPrimitive, AllowedYJSValue } from "./proxy-runtime-types.js";

/**
 * Core parent constraint check shared by all child discriminators.
 *
 * This type basically says: (types logic is inverted, obviously)
 * "If you're using child field - you know what the hell you are doing".
 * Its logic is following:
 * - if it's primitives only, you do not need children
 * - if it's mixed primitives and models, it's ok, let's extract models specifically to look at them
 * - now let's look who's parent of field you passed
 * - if it's default value (any), then it's allowed value. We're not forcing for children declaration hard - sometimes it's not needed
 * - but if you decided to annotate the parent, you better make sure that it's including this specific parent
 * this enables optional type-level schema validation of child-parent relations
 */
type CheckParentConstraint<Value, T, Parent extends PlexusModel> =
  Extract<Value, PlexusModel> extends PlexusModel<infer AP extends PlexusModel>
    ? any extends AP
      ? T
      : Parent extends Extract<AP, Parent>
        ? T
        : never
    : never;

type DiscriminateChildVal<T extends AllowedYJSValue, Parent extends PlexusModel> =
  CheckParentConstraint<T, T, Parent> extends never ? AllowedPrimitive | PlexusModel<Parent> : T;

type DiscriminateChildRecord<T extends Record<string, AllowedYJSValue>, Parent extends PlexusModel> =
  T extends Record<string, infer V>
    ? CheckParentConstraint<V, T, Parent> extends never
      ? Record<string, AllowedPrimitive | PlexusModel<Parent>>
      : T
    : never;

type DiscriminateChildSet<T extends Set<AllowedYJSValue>, Parent extends PlexusModel> =
  T extends Set<infer V>
    ? CheckParentConstraint<V, T, Parent> extends never
      ? Set<AllowedPrimitive | PlexusModel<Parent>>
      : T
    : never;

type DiscriminateChildList<T extends AllowedYJSValue[], Parent extends PlexusModel> = T extends (infer V)[]
  ? CheckParentConstraint<V, T, Parent> extends never
    ? (AllowedPrimitive | PlexusModel<Parent>)[]
    : T
  : never;

type DeclareResult<Out, In, Model extends PlexusModel> = {
  get?(this: Model): Out;
  set?(this: Model, value: In): void;
  init?(this: Model, value: In): In;
};

// ── Decorator interfaces ──
// Explicit per-variant interfaces, cast onto buildDecorator() in decorators.ts.
// Verbose intentionally — TS resolves concrete interfaces faster than generic indexed access.
// Three-generic <Model, V, Struct> is required: without V, TS collapses specific object types.

export interface RecordDecorator {
  <Model extends PlexusModel, V extends AllowedPrimitive | PlexusModel, Struct extends Record<string, V>>(
    target: ClassAccessorDecoratorTarget<Model, Struct>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends Record<string, AllowedPrimitive | PlexusModel>, In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<Model, Out>,
    context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

export interface SetDecorator {
  <Model extends PlexusModel, V extends AllowedPrimitive | PlexusModel, Struct extends Set<V>>(
    target: ClassAccessorDecoratorTarget<Model, Struct>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends Set<AllowedPrimitive | PlexusModel>, In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<Model, Out>,
    context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

export interface ListDecorator {
  <Model extends PlexusModel, V extends AllowedPrimitive | PlexusModel, Struct extends V[]>(
    target: ClassAccessorDecoratorTarget<Model, Struct>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends (AllowedPrimitive | PlexusModel)[], In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<Model, Out>,
    context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

// ── Child (discriminating) decorator interfaces ──

export interface DiscriminatingIdentityDecorator {
  <Model extends PlexusModel, T extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, DiscriminateChildVal<T, Model>>,
    context: ClassAccessorDecoratorContext<Model, T> & { name: string },
  ): ClassAccessorDecoratorResult<Model, T>;
  declare<Out extends AllowedPrimitive | PlexusModel, In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<PlexusModel, Out>,
    context: ClassAccessorDecoratorContext<PlexusModel, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

export interface DiscriminatingRecordDecorator {
  <Model extends PlexusModel, V extends AllowedYJSValue, Struct extends Record<string, V>>(
    target: ClassAccessorDecoratorTarget<Model, DiscriminateChildRecord<Struct, Model>>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends Record<string, AllowedPrimitive | PlexusModel>, In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<PlexusModel, Out>,
    context: ClassAccessorDecoratorContext<PlexusModel, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

export interface DiscriminatingSetDecorator {
  <Model extends PlexusModel, V extends AllowedYJSValue, Struct extends Set<V>>(
    target: ClassAccessorDecoratorTarget<Model, DiscriminateChildSet<Struct, Model>>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends Set<AllowedPrimitive | PlexusModel>, In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<PlexusModel, Out>,
    context: ClassAccessorDecoratorContext<PlexusModel, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

export interface DiscriminatingListDecorator {
  <Model extends PlexusModel, V extends AllowedYJSValue, Struct extends V[]>(
    target: ClassAccessorDecoratorTarget<Model, DiscriminateChildList<Struct, Model>>,
    context: ClassAccessorDecoratorContext<Model, Struct> & { name: string },
  ): ClassAccessorDecoratorResult<Model, Struct>;
  declare<Out extends (AllowedPrimitive | PlexusModel)[], In extends Out>(): <Model extends PlexusModel>(
    target: ClassAccessorDecoratorTarget<PlexusModel, Out>,
    context: ClassAccessorDecoratorContext<PlexusModel, Out> & { name: string },
  ) => DeclareResult<Out, In, Model>;
}

/**
 * Pre-discrimination for map values.
 * Checks if V can be a child of Parent - returns V if valid, never if not.
 *
 * Logic (same as CheckParentConstraint but for raw value type, not Mapping):
 * - Extract PlexusModel from V (might be V itself or part of union)
 * - If no PlexusModel in V, return never (child fields require model values)
 * - If PlexusModel has `any` parent (unspecified), allow it
 * - If PlexusModel's declared parent includes this Parent, allow it
 * - Otherwise, return never
 */
type PreDiscriminateMapValue<V extends AllowedYJSValue, Parent extends PlexusModel> =
  Extract<V, PlexusModel> extends PlexusModel<infer ActualParent extends PlexusModel>
    ? any extends ActualParent
      ? V
      : Parent extends Extract<ActualParent, Parent>
        ? V
        : never
    : never;

/**
 * Full discrimination for map values with fallback.
 * If PreDiscriminateMapValue returns never (invalid parent relationship),
 * falls back to a correctly-constrained type instead of just failing.
 */
type DiscriminateMapValue<V extends AllowedYJSValue, Parent extends PlexusModel> =
  PreDiscriminateMapValue<V, Parent> extends never
    ? AllowedPrimitive | PlexusModel<Parent>
    : PreDiscriminateMapValue<V, Parent>;

type MapKey<T extends Map<any, any>> =
  T extends Map<infer K, any>
    ?
        | (Extract<K, Set<AllowedYJSValue>> extends Set<AllowedYJSValue> ? K : never)
        | (Extract<K, Array<AllowedYJSValue>> extends Array<AllowedYJSValue> ? K : never)
        | (Extract<K, AllowedYJSValue> extends AllowedYJSValue ? K : never)
    : never;
type MapValue<T extends Map<any, any>> = T extends Map<any, infer K> ? Extract<K, AllowedYJSValue> : never;

export type DiscriminateMap<Field extends Map<any, any>, Parent extends PlexusModel> = Map<
  MapKey<Field>,
  DiscriminateMapValue<MapValue<Field>, Parent>
>;
