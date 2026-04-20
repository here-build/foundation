import { getInternals, PlexusModel, safeUuid } from "./PlexusModel.js";

abstract class PlexusError extends Error {
  name = this.constructor.name;

  protected constructor(message: string, consoleMessage: string, consoleData: object) {
    super(message);
    // Maintain proper stack trace for where error was thrown
    // some weird browsers may not have captureStackTrace so let's not crash inside crash.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    Error.captureStackTrace?.(this, this.constructor);
    setTimeout(() => {
      console.error(this, consoleMessage, {
        ...consoleData,
        stack: this.stack,
      });
    });
  }

  static invariant<T extends new (...args: any) => any>(
    this: T,
    condition: boolean,
    ...args: ConstructorParameters<T>
  ): asserts condition {
    if (!condition) throw new this(...args);
  }
}

export class PlexusSelfAdoptionError extends PlexusError {
  constructor(
    public readonly entity: PlexusModel,
    public readonly field: string,
  ) {
    super(
      `Plexus<${entity.__type__}#${safeUuid(entity)}>: cannot adopt self (via ${field})`,
      "Self-adoption attempt detected:",
      {
        entity: `${entity.__type__}#${safeUuid(entity)}`,
        field,
        currentParent: entity.parent ? `${entity.parent.__type__}#${safeUuid(entity.parent)}` : null,
      },
    );
  }
}

export class PlexusCycleError extends PlexusError {
  constructor(
    public readonly child: PlexusModel,
    public readonly newParent: PlexusModel,
    public readonly field: string,
    public readonly cycleNode: PlexusModel,
  ) {
    super(
      `Plexus<${child.__type__}#${safeUuid(child)}>: cannot be adopted by descendant ${newParent.__type__}#${safeUuid(newParent)} (would create cycle via ${field})`,
      "Cycle detected during adoption:",
      {
        child: `${child.__type__}#${safeUuid(child)}`,
        newParent: `${newParent.__type__}#${safeUuid(newParent)}`,
        field,
        cycleNode: `${cycleNode.__type__}#${safeUuid(cycleNode)}`,
        currentParent: child.parent ? `${child.parent.__type__}#${safeUuid(child.parent)}` : null,
      },
    );
  }
}

export class PlexusDependencyError extends PlexusError {
  constructor(
    public readonly entity: PlexusModel,
    public readonly operation: "adopted" | "edited" | "orphaned" | "emancipated" | "accessed",
  ) {
    super(
      `Plexus<${entity.__type__}#${safeUuid(entity)}>: dependency cannot be ${operation}`,
      "Dependency modification attempt:",
      {
        entity: `${entity.__type__}#${safeUuid(entity)}`,
        operation,
        isDependency: getInternals(entity).isDependency,
      },
    );
  }
}

export class PlexusRootParentError extends PlexusError {
  constructor(
    public readonly rootEntity: PlexusModel,
    public readonly attemptedParent: PlexusModel,
  ) {
    super(
      `Plexus<${rootEntity.__type__}#root>: root entity cannot have a parent`,
      "Root entity parent assignment attempt:",
      {
        rootEntity: `${rootEntity.__type__}#${safeUuid(rootEntity)}`,
        attemptedParent: `${attemptedParent.__type__}#${safeUuid(attemptedParent)}`,
        isRoot: rootEntity.isRoot,
      },
    );
  }
}

export class PlexusDocMismatchError extends PlexusError {
  constructor(
    public readonly child: PlexusModel,
    public readonly newParent: PlexusModel,
  ) {
    super(
      `Plexus<${child.__type__}#${safeUuid(child)}>: cannot adopt entity from different doc`,
      "Document mismatch during adoption:",
      {
        child: `${child.__type__}#${safeUuid(child)}`,
        childDoc: child.__doc__?.clientID,
        newParent: `${newParent.__type__}#${safeUuid(newParent)}`,
        parentDoc: newParent.__doc__?.clientID,
      },
    );
  }
}

export class PlexusDuplicateChildError extends PlexusError {
  constructor(
    public readonly parent: PlexusModel,
    public readonly field: string,
    public readonly child: PlexusModel,
    public readonly operation: string,
  ) {
    super(
      `Plexus<${parent.__type__}#${safeUuid(parent)}.${field}>: ${operation} cannot insert the same child multiple times`,
      "Duplicate child insertion attempt:",
      {
        parent: `${parent.__type__}#${safeUuid(parent)}`,
        field,
        child: `${child.__type__}#${safeUuid(child)}`,
        operation,
        childCurrentParent: child.parent ? `${child.parent.__type__}#${safeUuid(child.parent)}` : null,
      },
    );
  }

  /**
   * Checks an iterable for duplicate PlexusModel instances.
   * Throws if a duplicate is found.
   *
   * @param items Iterable of items to check for duplicates
   * @param parent Parent entity that would contain the items
   * @param field Field name where items would be stored
   * @param operation Name of the operation being performed
   */
  static uniquenessInvariant<T>(items: Iterable<T>, parent: PlexusModel, field: string, operation: string): void {
    const seen = new Set<T>();
    for (const item of items) {
      if (item instanceof PlexusModel) {
        this.invariant(!seen.has(item), parent, field, item, operation);
        seen.add(item);
      }
    }
  }
}
