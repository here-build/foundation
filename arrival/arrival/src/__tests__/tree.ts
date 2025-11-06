/**
 * Fantasy Land compatible Tree data structure
 *
 * A simple rose tree (tree with arbitrary number of children) that implements
 * Fantasy Land protocols, demonstrating that our polymorphic operations work
 * with FL-compatible entities from the JS world.
 */

// Fantasy Land method names
const FL = {
  map: "fantasy-land/map",
  filter: "fantasy-land/filter",
  reduce: "fantasy-land/reduce",
  of: "fantasy-land/of"
};

/**
 * Rose Tree - a tree where each node can have any number of children
 */
export class Tree<T> {
  constructor(
    public value: T,
    public children: Tree<T>[] = []
  ) {}

  // Fantasy Land: Applicative - of (point)
  static ["fantasy-land/of"]<T>(value: T): Tree<T> {
    return new Tree(value, []);
  }

  // Convenience: Create a tree from value and children
  static of<T>(value: T, ...children: Tree<T>[]): Tree<T> {
    return new Tree(value, children);
  }

  // Fantasy Land: Functor - map over tree values
  ["fantasy-land/map"]<U>(fn: (value: T) => U): Tree<U> {
    return new Tree(
      fn(this.value),
      this.children.map((child) => child["fantasy-land/map"](fn))
    );
  }

  // Fantasy Land: Filterable - filter tree nodes by predicate
  ["fantasy-land/filter"](predicate: (value: T) => boolean): Tree<T> | null {
    // Filter children first (depth-first)
    const filteredChildren = this.children
      .map((child) => child["fantasy-land/filter"](predicate))
      .filter((child): child is Tree<T> => child !== null);

    // If current node doesn't match predicate, return null
    if (!predicate(this.value)) {
      // If we have filtered children, we might want to keep them
      // For simplicity, we'll discard the whole subtree if root doesn't match
      return null;
    }

    return new Tree(this.value, filteredChildren);
  }

  // Fantasy Land: Foldable - reduce over tree values (depth-first, pre-order)
  ["fantasy-land/reduce"]<U>(fn: (acc: U, value: T) => U, initial: U): U {
    // Process current node
    let acc = fn(initial, this.value);

    // Process children (left to right, depth-first)
    for (const child of this.children) {
      acc = child["fantasy-land/reduce"](fn, acc);
    }

    return acc;
  }

  // Convenience: Convert to array (depth-first, pre-order)
  toArray(): T[] {
    return [this.value, ...this.children.flatMap((child) => child.toArray())];
  }

  // Convenience: Pretty print
  toString(indent = 0): string {
    const prefix = "  ".repeat(indent);
    const childrenStr = this.children.map((child) => child.toString(indent + 1)).join("\n");

    return `${prefix}${this.value}${childrenStr ? "\n" + childrenStr : ""}`;
  }
}

/**
 * Helper to create tree nodes more ergonomically
 */
export function tree<T>(value: T, ...children: Tree<T>[]): Tree<T> {
  return new Tree(value, children);
}
