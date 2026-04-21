import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import invariant from "tiny-invariant";

import {
  DiscriminateMap,
  type DiscriminatingIdentityDecorator,
  type DiscriminatingListDecorator,
  type DiscriminatingRecordDecorator,
  type DiscriminatingSetDecorator,
  type ListDecorator,
  type RecordDecorator,
  type SetDecorator,
} from "./decorator-types.js";
import { entityClasses } from "./globals.js";
import { docPlexus } from "./plexus-registry.js";
import { Plexus } from "./Plexus.js";
import { getInternals, type PlexusConstructor, PlexusModel, safeUuid } from "./PlexusModel.js";
import { buildArrayProxy } from "./proxies/materialized-array.js";
import { buildMapProxy } from "./proxies/materialized-map.js";
import { buildRecordProxy } from "./proxies/materialized-record.js";
import { buildSetProxy } from "./proxies/materialized-set.js";
import {
  type AllowedPrimitive,
  type AllowedVirtualMapKey,
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type GenericRecordSchema,
  informAdoptionSymbol,
  type PlexusTagContainer,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  validateAdoptionSymbol,
  type VirtualMap,
} from "./proxy-runtime-types.js";
import { __untracked__, trackAccess, trackModification } from "./tracking.js";
import { maybeReference, maybeTransacting } from "./utils/utils.js";
import { assertGenesisIsolation } from "./virtual-children-genesis.js";

try {
  // @ts-expect-error this is letting compiled stage-3 decorators work in wrangler dev environment
  // for some unclear reason, flag that needs enabling Symbol.metadata does not work or works weirdly in miniflare
  // since we're relying on its presence, it's better to introduce it anyway - it should not have any
  // negative consequences
  // noinspection JSConstantReassignment
  Symbol.metadata ??= Symbol.for("metadata");
} finally {
  /* empty */
}

const decoratedTracker = new WeakSet<PlexusConstructor>();

/**
 * Class decorator factory — accepts the model name as an argument.
 *
 * NOTE: Sometimes, user-defined classes may adjust constructor logic; e.g.:
 * class Code extends PlexusModel {
 *   constructor(code: string = "void 0") {
 *     validateCodeIsCorrect(code);
 *     super({code});
 *   }
 * }
 *
 * In order to keep the capability to spawn the models even if constructor is different,
 * we dynamically switch the prototype to Object during "bypass mode" (where we rehydrate backed classes).
 * This allows us to access private fields - typical Object.create(Class.prototype) or Reflect.setPrototypeOf(target, Class.prototype)
 * is not working for private fields, so this is only option here.
 *
 * The name is known upfront so no addInitializer needed: previously, decorators executed
 * BEFORE static declarations, making it impossible to do something like:
 *   @syncing
 *   class Model extends PlexusModel {
 *     static modelName = "Model";
 *   }
 * — modelName would not be present at the moment of @syncing decorator call, requiring addInitializer.
 * Now, since name is an argument to @syncing("Name"), it's available immediately.
 *
 * Defines __type__ as a prototype value property, shadowing the PlexusModel getter
 * and avoiding constructor traversal at runtime.
 */
function createClassDecorator(name: string) {
  invariant(name, `@syncing: model name is required`);
  return (target: PlexusConstructor, context: ClassDecoratorContext) => {
    const proto = Reflect.getPrototypeOf(target)! as PlexusConstructor;
    if (proto !== PlexusModel) {
      invariant(
        proto.prototype instanceof PlexusModel,
        `Plexus<${name}>: parent class ${proto.name} is not a PlexusModel`,
      );
      invariant(
        decoratedTracker.has(proto as PlexusConstructor),
        `Plexus<${name}>: parent class ${proto.name} must also use @syncing decorator`,
      );
    }
    decoratedTracker.add(target);
    target.modelName = name;
    Object.defineProperty(target.prototype, "__type__", { value: name, writable: false, enumerable: false });
    target.schema = {} as GenericRecordSchema;
    // it may miss with "barrel" nodes
    if (context.metadata.schema) {
      // we specifically need for...in to traverse over the inherited fields too
      for (const key in context.metadata.schema) {
        target.schema[key] = context.metadata.schema[key];
      }
    }
    invariant(!entityClasses.has(name), `Plexus<${name}>: duplicate class name, must be unique`);
    entityClasses.set(name, target);
    return target;
  };
}

/**
 * @syncing("Name") — class decorator (registers model, defines __type__).
 * @syncing accessor field — identity/val field decorator.
 */
function syncingDecorator(
  name: string,
): <Model extends PlexusModel, TargetConstructor extends PlexusConstructor<Model>>(
  target: TargetConstructor,
  context: ClassDecoratorContext<PlexusConstructor<Model>>,
) => TargetConstructor & PlexusTagContainer<"decorated">;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  target: ClassAccessorDecoratorTarget<Model, T>,
  context: ClassAccessorDecoratorContext<Model, T> & { name: string },
): ClassAccessorDecoratorResult<Model, T>;
function syncingDecorator(
  first: string | ClassAccessorDecoratorTarget<PlexusModel, any>,
  second?: ClassAccessorDecoratorContext<PlexusModel, any> & { name: string },
): any {
  // String call: @syncing("ModelName")
  if (typeof first === "string") {
    return createClassDecorator(first);
  }
  // Accessor decorator: @syncing accessor field
  ensureSchema(second!)[second!.name] = "val";
  return createHandlers(second!);
}

const set = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string },
>(
  context: Context,
  object: Model,
  value: T,
) => {
  const internals = getInternals(object);
  invariant(
    !internals.isDependency,
    `Plexus<${object.__type__}#${safeUuid(object)}.${context.name}>: dependencies are readonly`,
  );
  const storedValue = internals.backingStorage.get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object.__doc__, () => {
    if (value == undefined) {
      internals.backingStorage.delete(context.name);
    } else {
      internals.backingStorage.set(context.name, value);
    }
    if (value == undefined) {
      object.__yjsFieldsMap__?.delete(context.name);
    } else {
      object.__yjsFieldsMap__?.set(context.name, maybeReference(value, object.__doc__!));
    }
    trackModification(object, context.name);
  });
};
const setChild = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string },
>(
  context: Context,
  object: Model,
  value: T,
) => {
  const internals = getInternals(object);
  invariant(
    !internals.isDependency,
    `Plexus<${object.__type__}#${safeUuid(object)}.${context.name}>: dependencies are readonly`,
  );
  const storedValue = internals.backingStorage.get(context.name) as T;
  if (storedValue === value) {
    return;
  }

  /**
   * We're failing early here. We need to understand whether this will crash before we will do any changes.
   * This means that we cannot rely on in-motion crashes as the state will be mutated already.
   * So, before any write action we are checking whether it's OK.
   */
  if (value instanceof PlexusModel) {
    value[validateAdoptionSymbol](object, context.name);
  }

  maybeTransacting(object.__doc__, () => {
    storedValue?.[requestOrphanizationSymbol]?.();
    // old: orphan inside storage, new: attached to old parent
    if (value == undefined) {
      internals.backingStorage.delete(context.name);
    } else {
      internals.backingStorage.set(context.name, value);
    }
    // for that flow, we could've used [requestAdoptionSymbol], but it has some extra checks we just skip
    // old: orphan, removed, new: placed both inside backing storage and old location, has old parent
    value?.[requestEmancipationSymbol]?.(); // removes using old parent pointer
    // old: orphan, removed, new: removed from old location, only inside backing storage, has old parent
    value?.[informAdoptionSymbol]?.(object, context.name);
    // old: orphan, removed, new: removed from old location, only inside backing storage, has new parent
    if (value == undefined) {
      object.__yjsFieldsMap__?.delete(context.name);
    } else {
      object.__yjsFieldsMap__?.set(context.name, maybeReference(value, object.__doc__!));
    }
    trackModification(object, context.name);
  });
};

/**
 * this seems to be a pretty efficient approach, but should be performance-benchmarked.
 * this is (probably) computation-cheap approach for field caching.
 * we need this to dynamically support declaration overrides, e.g.:
 * ```
 * class Parent {@syncing accessor field;}
 * class Child extends Paren {@syncing.child accessor field;}
 * ```
 * (see more details in init() comment)
 *
 * we cannot detect this override in the decorator setup phase (we do not have access to class,
 * except in class decorators, which is not the case), so we could've either initialized them in init()
 * or lazily spawn on get() interceptor. Classic time-space problem.
 * This specific approach was not chosen by specific efficiency reason but for being the simplest (out of good ones)
 * way to make it work.
 * This also allows us to generalize decorators' behavior, making each of the struct decorators being basically
 * `createDecorator(type)` that has uniform behavior (except var/child-var fields).
 * `key` was used as the first argument, since we may have an uncertain number of models spawned - and there will probably
 * be more models spawned than keys of all model declarations. This gives us some very minor fixed in-memory overhead.
 * (We know we only create correct fields - so the rest of weak maps will be simply unused.)
 * Basically, we just know that we have a number of spawn-router objects being worst case sum(models.fieldsCount).
 * In reality, this amount is even smaller, since different models may have same-named fields (e.g. "name", "children"),
 * and this makes the number of spawn-router objects and factory invocations even less - and making them all happen
 * in init phase rather than runtime (like it would be if PlexusModel would be first arg).
 */
const createBackingStructuresMap = new DefaultedMap((key: string) => ({
  set: new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: false })),
  "child-set": new DefaultedWeakMap((owner: PlexusModel) => buildSetProxy({ owner, key, isChildField: true })),
  record: new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: false })),
  "child-record": new DefaultedWeakMap((owner: PlexusModel) => buildRecordProxy({ owner, key, isChildField: true })),
  list: new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: false })),
  "child-list": new DefaultedWeakMap((owner: PlexusModel) => buildArrayProxy({ owner, key, isChildField: true })),
  map: new DefaultedWeakMap((owner: PlexusModel) => buildMapProxy({ owner, key, isChildField: false })),
  "child-map": new DefaultedWeakMap((owner: PlexusModel) => {
    const virtualFactory = (owner.constructor as {
      [Symbol.metadata]?: { virtualFactories?: Record<string, (key: unknown) => PlexusModel> };
    })[Symbol.metadata]?.virtualFactories?.[key];
    return buildMapProxy({ owner, key, isChildField: true, virtualFactory });
  }),
}));

const emptyEphemeralDependency = new DefaultedWeakMap(() => Object.freeze({}));

// this madman grade stuff is needed as we may have inheriting decorators overriding type,
// yet decorator factories are using parent declaration, not child declaration.
// by making that behavior dynamic, we make overriding possible
const createHandlers = <
  Model extends PlexusModel,
  T extends
    | AllowedYJSValue
    | Set<AllowedYJSValue>
    | AllowedYJSValue[]
    | Record<string, AllowedYJSValue>
    | Map<AllowedYJSMapKey, AllowedYJSValue>
    | VirtualMap<AllowedVirtualMapKey, AllowedYJSValue>,
  Context extends ClassAccessorDecoratorContext<Model, T> & { name: string } = ClassAccessorDecoratorContext<
    Model,
    T
  > & { name: string },
>(
  context: Context,
) => {
  // we need those backing structures to be spawned individually to make them isolated per-key
  const backingStructures = createBackingStructuresMap.get(context.name);
  return {
    get(this: Model): T {
      assertGenesisIsolation(this);
      const internals = getInternals(this);
      invariant(
        !internals.isDependency,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: dependencies are handled via special flow overriding this getter. This error should not happen`,
      );
      if (context.name === "dependencies" && this.isRoot) {
        if (this.__doc__) {
          return docPlexus.get(this.__doc__)!.rootDependenciesRepresentation as T;
        } else {
          emptyEphemeralDependency.get(this);
        }
      }
      trackAccess(this, context.name);
      switch (this.__schema__[context.name]) {
        case "val":
        case "child-val":
          return internals.backingStorage.get(context.name) ?? null;
        default:
          /** see "We are doing dynamic schema retrieval..." comment below in init()*/
          return backingStructures[this.__schema__[context.name]].get(this);
      }
    },
    set(this: Model, value: T) {
      const internals = getInternals(this);
      invariant(
        !internals.isDependency,
        `Plexus<${this.__type__}#${safeUuid(this)}.${context.name}>: dependencies are handled via special flow overriding this setter. This error should not happen`,
      );
      if (this.__schema__[context.name] === "val") {
        set(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      if (this.__schema__[context.name] === "child-val") {
        setChild(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      /** see "We are doing dynamic schema retrieval..." comment below in init()*/
      backingStructures[this.__schema__[context.name]].get(this).assign(value);
    },
    /**
     * We're doing this overkill-looking init sequence to basically hack the JavaScript.
     * the initiation sequence of classes is clear: parent constructors execute first, then child constructors.
     * but that means that we cannot define default values while using prop initializer like that:
     *
     * class A extends PlexusModel {
     *   @syncing accessor field: number = 42;
     * }
     *
     * new A({field: 69}) // nice
     *
     * as the execution sequence like that:
     * (this: PlexusModel).field = 69;
     * (this: A).field = 42;
     *
     * To bypass this, the init hook of stage-3 decorators was used that lets us manually control the initiation sequence.
     * So, now it works like that (very simplified):
     * constructor () {
     *    PlexusModel: {
     *      this._initializationState.field = 69;
     *    }
     *    A: {
     *      field.@syncingDecorator.init(defaultValue: 42) {
     *        this.field = this._initializationState.field ?? defaultValue
     *      }
     *    }
     * }
     *
     * However, this highlighted another problem with modern TS/JS behavior:
     * ```
     * class Model {
     *   field: string;
     * }
     * ```
     * is compiled by default (since TS 5.6+ or 5.7+ - unsure about that) not to `class Model {}`, but to
     * ```
     * class Model {
     *   field;
     * }
     * ```
     * this looks safe, but this is what is this declaration is actually doing:
     * ```
     * class Model {
     *   constructor() {
     *     this.field = undefined;
     *   }
     * }
     * ```
     *
     * In real world scenarios, this leaded to very specific problem with inheritance that looks like that:
     * ```
     * @syncing
     * class Component extends PlexusModel {
     *   @syncing
     *   accessor type: "page" | "component" = "page";
     * }
     * ```
     * @syncing
     * class CodeComponent {
     *  type: "component";
     * }
     * ```
     * We needed to be both able to omit declarations (because, well, everyone forgets about `declare` TS keyword)
     * and support nullification override (e.g. parent is "page", child wants to initialize with `null`).
     * To mitigate it, the general design decision of Plexus - `undefined` is illegal - was applied here.
     * Since you just cannot declare some plexus-syncing field to be `undefined` (a decorator type explicitly bans it),
     * we may assume that in normal conditions the presence of `undefined` in initializer means that there's no
     * initializer value. Missing initializer clearly means that we can skip this specific initialization value.
     *
     * init() for decorators can be called multiple times (each per class in the inheritance chain), parent-to-child,
     * after the constructor, but before the new() result is returned. Thus, we can expect that all of them is
     * to exist in a safe temporal area and efficiently be represented as the following value to be materialized:
     * this._initializationState[field] ?? child.field ?? parent.field ?? grandparent.field
     * (but if ?? would fall back only on undefined, not null)
     * */
    init(this: Model, value: T | undefined): T {
      // Skip field init during controlled construction (sentinel-driven)
      if (Plexus.__isControlledConstruction__) {
        return undefined as any;
      }
      const internals = getInternals(this);
      if (internals.isDependency) {
        return null as any;
      }
      const setter = this.__schema__[context.name] === "val" ? set : setChild;
      /**
       * ephemeral models may be constructed at mutation-tracking contexts (e.g. inside a MobX reaction),
       * read events are always tracked (we need to know what was accessed to make decisions),
       * and the nature of construction behavior causes us to do some read requests anyway.
       * This means that need to explicitly initialize the class in a context that silences the mutation reporting.
       * this is not a hack - __untracked__ is a legitimate internal function for such use cases.
       * */
      return __untracked__(() => {
        /**
         * We are doing dynamic schema retrieval due to child class decorators may override parent class schema
         * declarations; however, getters seem to be used from parent accessor (stage-3 decorators are pretty
         * nuanced, and it's hard to figure out some edge cases in spec).
         * This problem (child declaration decorator changes a schema type) is reproducible
         * So, instead of relying on decorator spawn input, we take an actual field type from schema to
         * be sure that we alter the behavior accordingly to the actual definition intended.
         */
        switch (this.__schema__[context.name]) {
          case "val":
          case "child-val": {
            /**
             * we support _two_ initialization flows:
             * - new Model({...init}) - ephemeral, public
             * - new Model([entityId: string, doc: Y.Doc]) - materialized, internal
             *
             * in materialized flow, we need to ignore all "init values" and just use data from the underlying yjs model.
             * however, constructor args override the yjs model presence as we may sometimes encounter the model
             * assignment during the post-constructor phase. This will clearly mean that we're initializing
             * as a definition, not synced state, and should represent that value.
             */
            if (internals.yjsModel && !internals.isWithinYjsModelSeed) {
              const reflectedValue =
                internals.initializationState[context.name] === undefined
                  ? this[context.name]
                  : internals.initializationState[context.name];
              setter(context, this, reflectedValue);
              return reflectedValue;
            }
            const actualValue =
              // remember, null is valid
              internals.initializationState[context.name] === undefined
                ? // this fixes "override cases" when fields are re-declared without default value - in that case we take already known value instead of undefined
                  value === undefined
                  ? this[context.name]
                  : value
                : internals.initializationState[context.name];
            setter(context as any, this, actualValue as Extract<T, AllowedYJSValue>);
            return actualValue;
          }
          default: {
            /**
             * we must return something, so to avoid code duplication we just redirect init() to get() who does actual logic.
             */
            if (internals.yjsModel && !internals.isWithinYjsModelSeed) {
              return this[context.name];
            }
            // we do not care about undefined vs null here, as syncing structs have null as banned type too,
            // so it's just simpler and more readable to write like that
            const actualValue = internals.initializationState[context.name] ?? value;
            if (actualValue != undefined) {
              backingStructures[this.__schema__[context.name]].get(this).assign(actualValue);
            }
            // this technically goes to accessor private backing field - but we actually do not care a lot about that
            return actualValue;
          }
        }
      });
    },
  };
};

const ensureSchema = (context: ClassAccessorDecoratorContext<PlexusModel, any>): GenericRecordSchema => {
  /**
   * in inheriting classes, the first decorator sees that we HAVE context.metadata.schema,
   * but not own one - it is inherited from the parent class.
   * Parent class definition expected to be complete at the moment of another declaration,
   * so the schema will not change unless dev is some kind of genuine madman
   * (there _are_ ways to declare class mid-declaration of another class).
   * This skill level is respected but not appreciated here.
   *
   * However, to increase soundness (and even solve those cases, because who knows what hacks devs can actually do),
   * we use the parent schema as a prototype, not simply clone it.
   */
  if (!Object.hasOwn(context.metadata, "schema")) {
    context.metadata.schema = {
      __proto__: context.metadata.schema ?? {},
    };
  }
  return context.metadata.schema as GenericRecordSchema;
};

const ensureVirtualFactories = (context: ClassAccessorDecoratorContext<PlexusModel, any>): Record<string, Function> => {
  if (!Object.hasOwn(context.metadata, "virtualFactories")) {
    context.metadata.virtualFactories = {
      __proto__: (context.metadata.virtualFactories as Record<string, Function> | undefined) ?? {},
    };
  }
  return context.metadata.virtualFactories as Record<string, Function>;
};

/**
 * Unified decorator builder. Runtime is identical for all field types —
 * type differentiation is handled by explicit interface casts at the assignment site.
 *
 * The problem we're solving here is that PlexusModel<A | B> is not matching PlexusModel<B>;
 * yet we cannot just generalize types. So, we infer two types - FieldValue, that is produced from usage,
 * and discriminator, that defines what FieldValue is allowed to be. Since we have 2 args, we can make first one
 * produce FieldValue, and second one to act as discriminator. (decorators are weird; maybe there's more efficient
 * way to solve it, but it's very hard to debug decorator types)
 *
 * // todo narrow down
 */
const buildDecorator = (kind: GenericRecordSchema[string]) =>
  Object.assign(
    function plexusDynamicDecorator(
      target: ClassAccessorDecoratorTarget<PlexusModel, any>,
      context: ClassAccessorDecoratorContext<PlexusModel, any> & { name: string },
    ) {
      ensureSchema(context)[context.name] = kind;
      return createHandlers(context);
    },
    {
      declare() {
        return function plexusDynamicDecorator(
          target: ClassAccessorDecoratorTarget<PlexusModel, any>,
          context: ClassAccessorDecoratorContext<PlexusModel, any> & { name: string },
        ) {
          ensureSchema(context)[context.name] = kind;
          return createHandlers(context);
        };
      },
    },
  );

export const syncing = Object.assign(syncingDecorator, {
  child: Object.assign(buildDecorator("child-val") as DiscriminatingIdentityDecorator, {
    record: buildDecorator("child-record") as DiscriminatingRecordDecorator,
    set: buildDecorator("child-set") as DiscriminatingSetDecorator,
    list: buildDecorator("child-list") as DiscriminatingListDecorator,
    /**
     * Specialized decorator for Map fields where values are tracked as children.
     * Provides parent-child ownership tracking for map values.
     */
    map<Model extends PlexusModel, Field extends Map<any, any>>(
      target: ClassAccessorDecoratorTarget<Model, Field>,
      context: ClassAccessorDecoratorContext<Model, DiscriminateMap<Field, Model>> & {
        name: string;
      },
    ) {
      ensureSchema(context)[context.name] = "child-map";
      return createHandlers<Model, DiscriminateMap<Field, Model>>(context);
    },
  }),
  record: buildDecorator("record") as RecordDecorator,
  set: buildDecorator("set") as SetDecorator,
  list: buildDecorator("list") as ListDecorator,

  /**
   * Specialized decorator for Map fields that preserves both key and value types.
   * Returns PlexusMap which extends Map with bulk operations like assign().
   */
  map<Model extends PlexusModel, FieldValueKey extends AllowedYJSMapKey, FieldValue extends AllowedYJSValue>(
    target: ClassAccessorDecoratorTarget<Model, Map<FieldValueKey, FieldValue>>,
    context: ClassAccessorDecoratorContext<Model, Map<FieldValueKey, FieldValue>> & { name: string },
  ) {
    ensureSchema(context)[context.name] = "map";
    return createHandlers<Model, Map<FieldValueKey, FieldValue>>(context);
  },

  /**
   * Declares a document-bound virtual child map. Entries are auto-materialized
   * on first `.get(key)` via content-addressed genesis — two independent peers
   * producing the same entry get identical CRDT Items (sync is a no-op).
   *
   * **Document-bound:** `.get()` requires the owner to be connected to a
   * `Y.Doc`. Ephemeral (doc-less) models must not call `.get()` — it will
   * throw. Use eager construction (`constructor` + `@syncing.child.map`) for
   * fields that must work in both ephemeral and connected contexts.
   *
   * Mutations (`.set()`, `.delete()`, `.clear()`) are blocked at runtime —
   * virtual children are created by the factory, not by callers.
   */
  virtual<K extends AllowedVirtualMapKey, V extends PlexusModel>(factory: (key: K) => V) {
    return function <Model extends PlexusModel>(
      target: ClassAccessorDecoratorTarget<Model, VirtualMap<K, V>>,
      context: ClassAccessorDecoratorContext<Model, VirtualMap<K, V>> & { name: string },
    ) {
      ensureSchema(context)[context.name] = "child-map";
      ensureVirtualFactories(context)[context.name] = factory;
      const handlers = createHandlers<Model, VirtualMap<K, V>>(context);
      // Virtual maps: get returns VirtualMap, set accepts never (assignment is a type error),
      // init returns the backing proxy without calling .assign()
      return {
        get(this: Model): VirtualMap<K, V> {
          return handlers.get.call(this);
        },
        set(this: Model, _value: never): void {
          invariant(
            false,
            `@syncing.virtual field "${String(context.name)}" cannot be assigned — use .get(key) to auto-materialize`,
          );
        },
        init(this: Model, _value: never): VirtualMap<K, V> {
          if (Plexus.__isControlledConstruction__) return undefined as any;
          return handlers.get.call(this);
        },
      };
    };
  },

  declare<Out extends AllowedPrimitive | PlexusModel, In extends Out>() {
    return function plexusDynamicDecorator<Model extends PlexusModel>(
      target: ClassAccessorDecoratorTarget<Model, Out>,
      context: ClassAccessorDecoratorContext<Model, Out> & { name: string },
    ) {
      ensureSchema(context)[context.name] = "val";
      return createHandlers<Model, Out>(context) as {
        get?(this: Model): Out;
        set?(this: Model, value: In): void;
        init?(this: Model, value: In): In;
      };
    };
  },
});
