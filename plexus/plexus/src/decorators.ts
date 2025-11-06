import { PlexusConstructor, PlexusModel } from "./PlexusModel";
import {
  AllowedYJSValue,
  backingStorageSymbol,
  GenericRecordSchema,
  informAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
} from "./proxy-runtime-types";
import invariant from "tiny-invariant";
import { entityClasses } from "./globals";
import { __untracked__, trackAccess, trackModification } from "./tracking";
import {
  DefaultedMap,
  DefaultedWeakMap,
  maybeReference,
  maybeTransacting,
} from "./utils";
import { buildRecordProxy } from "./proxies/materialized-map";
import { buildSetProxy } from "./proxies/materialized-set";
import { buildArrayProxy } from "./proxies/materialized-array";

const argsAreClassDecoratorArgs = <
  Model extends PlexusModel,
  T extends AllowedYJSValue,
>(
  args:
    | [
        PlexusConstructor<Model>,
        ClassDecoratorContext<PlexusConstructor<Model>>,
      ]
    | [
        ClassAccessorDecoratorTarget<Model, T>,
        ClassAccessorDecoratorContext<Model, T> & { name: string },
      ],
): args is [
  PlexusConstructor<Model>,
  ClassDecoratorContext<PlexusConstructor<Model>>,
] => args[1].kind === "class";

try {
  // this is letting compiled stage-3 decorators work in wrangler environment
  // @ts-expect-error
  // noinspection JSConstantReassignment
  Symbol.metadata ??= Symbol.for("metadata");
} finally {
}

function syncingDecorator<
  Model extends PlexusModel,
  T extends AllowedYJSValue,
  Constructor extends PlexusConstructor<Model>,
>(
  ...args: [Constructor, ClassDecoratorContext<PlexusConstructor<Model>>]
): Constructor;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args: [
    ClassAccessorDecoratorTarget<Model, T>,
    ClassAccessorDecoratorContext<Model, T> & { name: string },
  ]
): ClassAccessorDecoratorResult<Model, T>;
function syncingDecorator<Model extends PlexusModel, T extends AllowedYJSValue>(
  ...args:
    | [
        PlexusConstructor<Model>,
        ClassDecoratorContext<PlexusConstructor<Model>>,
      ]
    | [
        ClassAccessorDecoratorTarget<Model, T>,
        ClassAccessorDecoratorContext<Model, T> & { name: string },
      ]
) {
  if (argsAreClassDecoratorArgs(args)) {
    const [target, context] = args as [
      PlexusConstructor<Model>,
      ClassDecoratorContext<PlexusConstructor<Model>>,
    ];
    const name = context.name ?? target.name;
    invariant(name, "Plexus class should have designated name");
    invariant(
      context.metadata.schema,
      `there's no schema of model ${name} to sync`,
    );
    target.modelName = name;
    target.schema = {} as GenericRecordSchema;
    // we specifically need for...in to traverse over the inherited fields too
    for (const key in context.metadata.schema) {
      target.schema[key] = context.metadata.schema[key];
    }
    invariant(
      !entityClasses.has(target.modelName),
      `Plexus class name ${target.modelName} is non-unique`,
    );
    entityClasses.set(target.modelName, target);
    return target;
  } else {
    const [target, context] = args as [
      ClassAccessorDecoratorTarget<Model, T>,
      ClassAccessorDecoratorContext<Model, T> & { name: string },
    ];
    if (!Object.hasOwn(context.metadata, "schema")) {
      context.metadata.schema = {
        // it may be coming from inherited state and we need to use the inheritance here too
        __proto__: context.metadata.schema ?? {},
      };
    }
    (context.metadata.schema as GenericRecordSchema)[context.name] = "val";
    return createHandlers(context) as ClassAccessorDecoratorResult<Model, T>;
  }
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
  const storedValue = object[backingStorageSymbol].get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object._doc, () => {
    if (value == undefined) {
      object[backingStorageSymbol].delete(context.name);
    } else {
      object[backingStorageSymbol].set(context.name, value);
    }
    trackModification(object, context.name);
    if (value == undefined) {
      object._yjsModel?.delete(context.name);
    } else {
      object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
    }
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
  const storedValue = object[backingStorageSymbol].get(context.name) as T;
  if (storedValue === value) {
    return;
  }
  maybeTransacting(object._doc, () => {
    storedValue?.[requestOrphanizationSymbol]?.();
    // old: orphan inside storage, new: attached to old parent
    if (value == undefined) {
      object[backingStorageSymbol].delete(context.name);
    } else {
      object[backingStorageSymbol].set(context.name, value);
    }
    // for that flow, we could've used [requestAdoptionSymbol], but it has some extra checks we just skip
    // old: orphan, removed, new: placed both inside backing storage and old location, has old parent
    value?.[requestEmancipationSymbol]?.(); // removes using old parent pointer
    // old: orphan, removed, new: removed from old location, only inside backing storage, has old parent
    value?.[informAdoptionSymbol]?.(object, context.name);
    // old: orphan, removed, new: removed from old location, only inside backing storage, has new parent
    trackModification(object, context.name);
    if (value == undefined) {
      object._yjsModel?.delete(context.name);
    } else {
      object._yjsModel?.set(context.name, maybeReference(value, object._doc!));
    }
  });
};

/**
 * this seems to be pretty efficient approach, but should be performance-benchmarked.
 * this is (probably) computation-cheap approach for field caching.
 * we need this to dynamically support declaration overrides, e.g.:
 * ```
 * class Parent {@syncing accessor field;}
 * class Child extends Paren {@syncing.child accessor field;}
 * ```
 * (see more details in init() comment)
 *
 * we cannot detect this override in decorator setup phase (we do not have access to class,
 * except in class decorators which is not the case), so we could've either initialize them in init(),
 * or lazily spawn on get() interceptor. Classic time-space problem.
 * This specific approach was not chosen by specific efficiency reason but for being the simplest (out of good ones)
 * way to make it work.
 * This also allows us to generalize decorators behavior, making each of struct decorators being basically
 * `createDecorator(type)` that has uniform behavior (except var/child-var fields).
 * `key` was used as first argument, since we may have uncertain amount of models spawned - and there will probably
 * be more models spawned than keys of all model declarations. This gives us some very minor fixed in-memory overhead.
 * (We know we only create correct fields - so rest of weak maps will be simply unused.)
 * Basically, we just know that we have amount of spawn-router objects being worst case sum(models.fieldsCount).
 * In reality, this amount is even smaller, since different models may have same-named fields (e.g. "name", "children"),
 * and this makes amount of spawn-router objects and factory invocations even less - and making them all happen
 * in init phase rather than runtime (like it would be if PlexusModel would be first arg).
 */
const createBackingStructuresMap = new DefaultedMap((key: string) => ({
  set: new DefaultedWeakMap((owner: PlexusModel) =>
    buildSetProxy({ owner, key, isChildField: false }),
  ),
  "child-set": new DefaultedWeakMap((owner: PlexusModel) =>
    buildSetProxy({ owner, key, isChildField: true }),
  ),
  record: new DefaultedWeakMap((owner: PlexusModel) =>
    buildRecordProxy({ owner, key, isChildField: false }),
  ),
  "child-record": new DefaultedWeakMap((owner: PlexusModel) =>
    buildRecordProxy({ owner, key, isChildField: true }),
  ),
  list: new DefaultedWeakMap((owner: PlexusModel) =>
    buildArrayProxy({ owner, key, isChildField: false }),
  ),
  "child-list": new DefaultedWeakMap((owner: PlexusModel) =>
    buildArrayProxy({ owner, key, isChildField: true }),
  ),
}));

// this madman grade stuff is needed as we may have inheriting decorators overriding type,
// yet decorator factories are using parent declaration, not child declaration.
// by making that behavior dynamic we make overriding possible
const createHandlers = <
  Model extends PlexusModel,
  T extends
    | AllowedYJSValue
    | Set<AllowedYJSValue>
    | AllowedYJSValue[]
    | Record<string, AllowedYJSValue>,
  Context extends ClassAccessorDecoratorContext<Model, T> & {
    name: string;
  } = ClassAccessorDecoratorContext<Model, T> & { name: string },
>(
  context: Context,
) => {
  // we need those backing structures to be spawned individually to make them isolated per-key
  const backingStructures = createBackingStructuresMap.get(context.name);
  return {
    get(this: Model): T {
      trackAccess(this, context.name);
      switch (this._schema[context.name]) {
        case "val":
        case "child-val":
          return this[backingStorageSymbol].get(context.name) ?? null;
        default:
          /** see "We are doing dynamic schema retrieval..." comment below in init()*/
          return backingStructures[this._schema[context.name]].get(this);
      }
    },
    set(this: Model, value: T) {
      if (this._schema[context.name] === "val") {
        set(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      if (this._schema[context.name] === "child-val") {
        setChild(context as any, this, value as Extract<T, AllowedYJSValue>);
        return;
      }

      /** see "We are doing dynamic schema retrieval..." comment below in init()*/
      backingStructures[this._schema[context.name]].get(this).assign(value);
    },
    /**
     * We're doing this overkill-looking init sequence to basically hack the JavaScript.
     * the initiation sequence of classes are clear: parent constructors executes first, then child constructors.
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
     * To bypass this, the init hook of stage-3 decorators was used that lets us manually control initiation sequence.
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
     * Since you just cannot declare some plexus-syncing field to be `undefined` (decorator type explicitly bans it),
     * we may assume that in normal conditions presence of `undefined` in initializer means that there's no
     * initializer value. Missing initializer clearly means that we can skip this specific initialization value.
     *
     * init() for decorators can be called multiple times (each per class in inheritance chain), parent-to-child,
     * after the constructor but before the new() result is returned back. Thus, we can expect that all of them
     * to exist in safe temporal area, and efficiently be represented as following value to be materialized:
     * this._initializationState[field] ?? child.field ?? parent.field ?? grandparent.field
     * (but if ?? would fallback only on undefined, not null)
     * */
    init(this: Model, value: T): T {
      const setter = this._schema[context.name] === "val" ? set : setChild;
      /**
       * ephemeral models may be constructed at mutation-tracking contexts (see createTrackedFunction),
       * read events are always tracked (we need to know what was accessed to make decisions),
       * and nature of construction behavior causes us to do some read requests anyway.
       * This means that need to explicitly initialize the class in a context that silences the mutation reporting.
       * this is not a hack - __untracked__ is legitimate internal function for such use cases.
       * */
      return __untracked__(() => {
        /**
         * We are doing dynamic schema retrieval due to child class decorators may override parent class schema
         * declarations; however, getters seems to be used from parent accessor (stage-3 decorators are pretty
         * nuanced, and it's hard to figure out some edge cases in spec).
         * This problem (child declaration decorator changes schema type) is reproducible
         * So, instead of relying on decorator spawn input, we take actual field type from schema to
         * be sure that we alter the behavior accordingly to actual definition intended.
         */
        switch (this._schema[context.name]) {
          case "val":
          case "child-val": {
            /**
             * we support _two_ initialization flows:
             * - new Model({...init}) - ephemeral, public
             * - new Model([entityId: string, doc: Y.Doc]) - materialized, internal
             *
             * in materialized flow, we need to ignore all "init values" and just use data from underlying yjs model.
             * however, constructor args override the yjs model presence as we may sometimes encounter the model
             * assignment during the post-constructor phase. This will clearly mean that we're initializing
             * as a definition, not synced state, and should represent that value.
             */
            if (this._yjsModel && !this._isWithinYjsModelSeed) {
              const reflectedValue =
                this._initializationState[context.name] !== undefined
                  ? this._initializationState[context.name]
                  : this[context.name];
              setter(context, this, reflectedValue);
              return reflectedValue;
            }
            const actualValue =
              this._initializationState[context.name] !== undefined
                ? this._initializationState[context.name]
                : value;
            setter(
              context as any,
              this,
              actualValue as Extract<T, AllowedYJSValue>,
            );
            return actualValue;
          }
          default:
            /**
             * we must return something, so to avoid code duplication we just redirect init() to get() who does actual logic.
             */
            if (this._yjsModel && !this._isWithinYjsModelSeed) {
              return this[context.name];
            }
            // we do not care about undefined vs null here, as syncing structs have null as banned type too,
            // so it's just simpler and more readable to write like that
            const actualValue =
              this._initializationState[context.name] ?? value;
            if (actualValue != undefined) {
              backingStructures[this._schema[context.name]]
                .get(this)
                .assign(actualValue);
            }
            // this technically goes to accessor private backing field - but we actually do not care a lot about that
            return actualValue;
        }
      });
    },
  };
};

const buildDecorator = <
  T extends
    | AllowedYJSValue
    | Set<AllowedYJSValue>
    | AllowedYJSValue[]
    | Record<string, AllowedYJSValue>,
>(
  kind: GenericRecordSchema[string],
) =>
  function plexusDynamicDecorator<Model extends PlexusModel, Type extends T>(
    target: ClassAccessorDecoratorTarget<Model, Type>,
    context: ClassAccessorDecoratorContext<Model, Type> & { name: string },
  ) {
    if (!Object.hasOwn(context.metadata, "schema")) {
      /**
       * in inheriting classes, first decorator sees that we HAVE context.metadata.schema,
       * but not own one - it is inherited from parent class.
       * Parent class definition expected to be complete at the moment of another declaration,
       * so schema will not change unless dev is some kind of genuine madman
       * (there _are_ ways to declare class mid-declaration of another class).
       * This skill level is respected but not appreciated here.
       *
       * However, to increase soundness (and solve even those cases, because who knows what hacks devs can actually do),
       * we use parent schema as prototype, not simply clone it.
       */
      context.metadata.schema = {
        __proto__: context.metadata.schema ?? {},
      };
    }
    (context.metadata.schema as GenericRecordSchema)[context.name] = kind;
    return createHandlers<Model, Type>(context);
  };

export const syncing = Object.assign(syncingDecorator, {
  child: Object.assign(buildDecorator<AllowedYJSValue>("child-val"), {
    map: buildDecorator<Record<string, AllowedYJSValue>>("child-record"),
    set: buildDecorator<Set<AllowedYJSValue>>("child-set"),
    list: buildDecorator<Array<AllowedYJSValue>>("child-list"),
  }),
  map: buildDecorator<Record<string, AllowedYJSValue>>("record"),
  set: buildDecorator<Set<AllowedYJSValue>>("set"),
  list: buildDecorator<Array<AllowedYJSValue>>("list"),
});
