// -------------------------------------------------------------------------
// :: Pair - the cons cell (fundamental Lisp data structure)
// -------------------------------------------------------------------------
import type { SourceLocation } from "./errors.js";
import { is_native, is_nil, is_pair, is_plain_object } from "./guards.js";
import { SchemeString } from "./LString.js";
import { SchemeSymbol } from "./LSymbol.js";
import { SchemeExact, SchemeInexact } from "./numbers.js";
import { __cycles__, __data__, __location__, __ref__ } from "./primitives.js";
import type { Nil, PairLike } from "./types.js";
import { nil, setPairConstructor } from "./types.js";

/**
 * Internal type for pair with metadata (cycles, refs, location).
 */
interface PairWithMetadata<Car = unknown, Cdr = unknown> extends Pair<Car, Cdr> {
  [__cycles__]?: { car?: string | Pair; cdr?: string | Pair };
  [__ref__]?: string;
  [__location__]?: SourceLocation;
}

// ----------------------------------------------------------------------
// :: Thunk for trampolining (used by mark_cycles)
// ----------------------------------------------------------------------
class Thunk {
  fn: () => Thunk | void;
  cont: () => void;

  constructor(fn: () => Thunk | void, cont: () => void = () => {}) {
    this.fn = fn;
    this.cont = cont;
  }

  toString(): string {
    return "#<Thunk>";
  }
}

// ----------------------------------------------------------------------
type TrampolineFn = (pair: unknown, parents: Pair[]) => Thunk | void;

function trampoline(fn: TrampolineFn): (pair: unknown, parents: Pair[]) => void {
  return function (pair: unknown, parents: Pair[]): void {
    unwind(fn(pair, parents));
  };
}

// ----------------------------------------------------------------------
function unwind(result: Thunk | void): void {
  while (result instanceof Thunk) {
    const thunk = result;
    result = result.fn();
    if (!(result instanceof Thunk)) {
      thunk.cont();
    }
  }
}

// ----------------------------------------------------------------------
// :: Cycle detection for pairs
// ----------------------------------------------------------------------
function is_cycle(pair: unknown): boolean {
  if (!is_pair(pair)) {
    return false;
  }
  if (pair.have_cycles()) {
    return true;
  }
  return is_cycle(pair.car) || is_cycle(pair.cdr);
}

// ----------------------------------------------------------------------
function mark_cycles(pair: Pair): void {
  const seen_pairs: Pair[] = [];
  const cycles: PairWithMetadata[] = [];
  const refs: Pair[] = [];

  function visit(pair: Pair): void {
    if (!seen_pairs.includes(pair)) {
      seen_pairs.push(pair);
    }
  }

  function set(node: PairWithMetadata, type: "car" | "cdr", child: unknown, parents: Pair[]): boolean {
    if (is_pair(child) && parents.includes(child)) {
      if (!refs.includes(child)) {
        refs.push(child);
      }
      if (!node[__cycles__]) {
        node[__cycles__] = {};
      }
      node[__cycles__][type] = child;
      if (!cycles.includes(node)) {
        cycles.push(node);
      }
      return true;
    }
    return false;
  }

  const detect = trampoline(function detect_thunk(pair: unknown, parents: Pair[]): Thunk | void {
    if (is_pair(pair)) {
      const pairWithCycles = pair as PairWithMetadata;
      delete pairWithCycles[__ref__];
      delete pairWithCycles[__cycles__];
      visit(pair);
      parents.push(pair);
      const car = set(pairWithCycles, "car", pair.car, parents);
      const cdr = set(pairWithCycles, "cdr", pair.cdr, parents);
      if (!car) {
        detect(pair.car, [...parents]);
      }
      if (!cdr) {
        return new Thunk(() => {
          return detect_thunk(pair.cdr, [...parents]);
        });
      }
    }
  });

  function mark_node(node: PairWithMetadata, type: "car" | "cdr"): void {
    const cycleData = node[__cycles__];
    if (cycleData && is_pair(cycleData[type])) {
      const count = ref_nodes.indexOf(cycleData[type] as Pair);
      cycleData[type] = `#${count}#`;
    }
  }

  detect(pair, []);
  const ref_nodes = seen_pairs.filter((node) => refs.includes(node));
  for (const [i, node] of ref_nodes.entries()) {
    (node as PairWithMetadata)[__ref__] = `#${i}=`;
  }
  for (const node of cycles) {
    mark_node(node, "car");
    mark_node(node, "cdr");
  }
}

// ----------------------------------------------------------------------
// :: Basic value stringifier for Pair.toString()
// ----------------------------------------------------------------------
interface ObjectWithToString {
  toString: (quote?: boolean) => string;
}
interface FunctionWithName extends Function {
  __name__?: string | symbol;
}

function stringifyValue(obj: unknown, quote?: boolean): string {
  // Handle null/undefined
  if (obj === null) return "null";
  if (obj === undefined) return "#void";
  if (obj === true) return "#t";
  if (obj === false) return "#f";

  // Handle primitives
  const t = typeof obj;
  if (t === "string") return quote ? JSON.stringify(obj) : (obj as string);
  if (t === "number" || t === "bigint") return String(obj);
  if (t === "symbol") return (obj as symbol).toString().replace(/^Symbol\(([^)]+)\)/, "$1");

  // Handle objects with toString method (SchemeSymbol, SchemeString, SchemeCharacter, numbers, nil, etc.)
  if (t === "object" || t === "function") {
    // Special handling for functions
    if (t === "function") {
      const fn = obj as FunctionWithName;
      if (fn.__name__) {
        const name =
          typeof fn.__name__ === "symbol"
            ? fn.__name__.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1")
            : fn.__name__;
        return `#<procedure:${name}>`;
      }
      return "#<procedure>";
    }
    // Objects with custom toString
    const o = obj as ObjectWithToString;
    if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
      const str = o.toString(quote);
      return typeof str === "string" ? str : String(str);
    }
    // Fallback for plain objects
    const ctor = (obj as object).constructor;
    if (ctor?.name) {
      return `#<${ctor.name}>`;
    }
    return "#<Object>";
  }

  return String(obj);
}

// ----------------------------------------------------------------------
// :: Pair class
// ----------------------------------------------------------------------
export class Pair<Car = unknown, Cdr = unknown> implements PairLike<Car, Cdr> {
  static __class__ = "pair";
  [__data__]?: boolean;
  [__location__]?: SourceLocation;

  car: Car;
  cdr: Cdr;

  constructor(car?: Car, cdr?: Cdr) {
    this.car = car as Car;
    this.cdr = cdr as Cdr;
  }

  // Static methods
  static match(obj: unknown, item: string | RegExp | SchemeSymbol): boolean {
    if (obj instanceof SchemeSymbol) {
      return SchemeSymbol.is(obj, item);
    } else if (is_pair(obj)) {
      return Pair.match(obj.car, item) || Pair.match(obj.cdr, item);
    } else if (Array.isArray(obj)) {
      return obj.some((x) => Pair.match(x, item));
    } else if (is_plain_object(obj)) {
      return Object.values(obj).some((x) => Pair.match(x, item));
    }
    return false;
  }

  static fromArray(array: unknown, deep = true, quote = false): Pair | Nil | unknown[] {
    if (
      is_pair(array) ||
      (quote && Array.isArray(array) && (array as unknown as { [key: symbol]: unknown })[__data__])
    ) {
      return array as Pair | unknown[];
    }
    const arr = Array.isArray(array) ? array : [...(array as Iterable<unknown>)];
    if (deep === false) {
      let list: Pair | Nil = nil;
      for (let i = arr.length; i--; ) {
        list = new Pair(arr[i], list);
      }
      return list;
    }
    let result: Pair | Nil = nil;
    let i = arr.length;
    while (i--) {
      let car: unknown = arr[i];
      if (Array.isArray(car)) {
        car = Pair.fromArray(car, deep, quote);
      } else if (typeof car === "string") {
        car = new SchemeString(car);
      } else if (typeof car === "number" && !Number.isNaN(car)) {
        car = Number.isSafeInteger(car) ? new SchemeExact(BigInt(car)) : new SchemeInexact(car);
      } else if (typeof car === "bigint") {
        car = new SchemeExact(car);
      }
      result = new Pair(car, result);
    }
    return result;
  }

  static fromPairs(array: [string, unknown][]): Pair | Nil {
    return array.reduce<Pair | Nil>((list, pair) => {
      return new Pair(new Pair(new SchemeSymbol(pair[0]), pair[1]), list);
    }, nil);
  }

  static fromObject(obj: Record<string, unknown>): Pair | Nil {
    const array = Object.keys(obj).map((key) => [key, obj[key]] as [string, unknown]);
    return Pair.fromPairs(array);
  }

  /**
   * Set source location metadata for this pair.
   * Returns this for chaining.
   */
  setLocation(loc: SourceLocation): this {
    this[__location__] = loc;
    return this;
  }

  /**
   * Get source location metadata for this pair.
   */
  getLocation(): SourceLocation | undefined {
    return this[__location__];
  }

  // Instance methods
  flatten(): Pair | Nil | unknown[] {
    return Pair.fromArray(this.to_array().flat(Infinity));
  }

  length(): number {
    let len = 0;
    let node: Pair | unknown = this;
    while (true) {
      if (!node || is_nil(node) || !is_pair(node) || node.have_cycles("cdr")) {
        break;
      }
      len++;
      node = node.cdr;
    }
    return len;
  }

  find(item: string | RegExp | SchemeSymbol): boolean {
    return Pair.match(this, item);
  }

  clone(deep = true): Pair {
    const visited = new Map<Pair, Pair>();

    function cloneNode(node: unknown): unknown {
      if (is_pair(node)) {
        if (visited.has(node)) {
          return visited.get(node);
        }
        const pair = new Pair() as PairWithMetadata;
        visited.set(node, pair);
        pair.car = deep ? cloneNode(node.car) : node.car;
        pair.cdr = cloneNode(node.cdr);
        pair[__cycles__] = (node as PairWithMetadata)[__cycles__];
        return pair;
      }
      return node;
    }

    return cloneNode(this) as Pair;
  }

  last_pair(): Pair | undefined {
    let node: Pair = this;
    while (true) {
      if (!is_pair(node.cdr)) {
        return node;
      }
      if (node.have_cycles("cdr")) {
        break;
      }
      node = node.cdr;
    }
  }

  to_array(deep = true): unknown[] {
    let result: unknown[] = [];
    if (is_pair(this.car)) {
      if (deep) {
        result.push(this.car.to_array());
      } else {
        result.push(this.car);
      }
    } else {
      const car = this.car;
      // When deep=false (used for vector literals), preserve Scheme values as-is
      // Only call valueOf() for deep conversions to JS primitives
      if (deep && car !== null && car !== undefined && typeof car === "object" && "valueOf" in car) {
        // But preserve SchemeSymbol, SchemeString, and number types even in deep mode
        // as they are Scheme values that should remain wrapped
        if (
          car instanceof SchemeSymbol ||
          car instanceof SchemeString ||
          car instanceof SchemeExact ||
          car instanceof SchemeInexact
        ) {
          result.push(car);
        } else {
          result.push((car as { valueOf(): unknown }).valueOf());
        }
      } else {
        result.push(car);
      }
    }
    if (is_pair(this.cdr)) {
      result = [...result, ...this.cdr.to_array(deep)];
    }
    return result;
  }

  to_object(literal = false): Record<string, unknown> {
    let node: Pair | unknown = this;
    const result: Record<string, unknown> = {};
    while (true) {
      if (is_pair(node) && is_pair(node.car)) {
        const pair = node.car;
        let name: unknown = pair.car;
        if (name instanceof SchemeSymbol) {
          name = name.__name__;
        }
        if (name instanceof SchemeString) {
          name = name.valueOf();
        }
        let cdr: unknown = pair.cdr;
        if (is_pair(cdr)) {
          cdr = cdr.to_object(literal);
        }
        if (is_native(cdr) && !literal) {
          cdr = (cdr as { valueOf(): unknown }).valueOf();
        }
        result[name as string] = cdr;
        node = node.cdr;
      } else {
        break;
      }
    }
    return result;
  }

  reduce<T>(fn: (acc: T | Nil, val: unknown) => T): T | Nil {
    let node: Pair | unknown = this;
    let result: T | Nil = nil;
    while (true) {
      if (is_nil(node)) {
        break;
      } else if (is_pair(node)) {
        result = fn(result, node.car);
        node = node.cdr;
      } else {
        break;
      }
    }
    return result;
  }

  reverse(): Pair | Nil {
    if (this.have_cycles()) {
      throw new Error("You can't reverse list that have cycles");
    }
    let node: Pair | unknown = this;
    let prev: Pair | Nil = nil;
    while (!is_nil(node) && is_pair(node)) {
      const next = node.cdr;
      node.cdr = prev;
      prev = node;
      node = next;
    }
    return prev;
  }

  transform(fn: (val: unknown) => unknown): Pair {
    const visited: Pair[] = [];

    function recur(pair: unknown): unknown {
      if (is_pair(pair)) {
        if ((pair as Pair & { replace?: boolean }).replace) {
          delete (pair as Pair & { replace?: boolean }).replace;
          return pair;
        }
        let car = fn(pair.car);
        if (is_pair(car)) {
          car = recur(car);
          visited.push(car as Pair);
        }
        let cdr = fn(pair.cdr);
        if (is_pair(cdr)) {
          cdr = recur(cdr);
          visited.push(cdr as Pair);
        }
        return new Pair(car, cdr);
      }
      return pair;
    }

    return recur(this) as Pair;
  }

  map(fn: (val: unknown) => unknown): Pair | Nil {
    return this.car === undefined ? nil : new Pair(fn(this.car), is_nil(this.cdr) ? nil : (this.cdr as Pair).map(fn));
  }

  mark_cycles(): this {
    mark_cycles(this);
    return this;
  }

  have_cycles(name: "car" | "cdr" | null = null): boolean {
    if (!name) {
      return this.have_cycles("car") || this.have_cycles("cdr");
    }
    return !!(this as PairWithMetadata)[__cycles__]?.[name];
  }

  is_cycle(): boolean {
    return is_cycle(this);
  }

  toString(quote?: boolean, { nested = false } = {}): string {
    const parts: string[] = [];
    const thisWithCycles = this as PairWithMetadata;

    // Opening paren (with ref marker if present)
    if (thisWithCycles[__ref__]) {
      parts.push(`${thisWithCycles[__ref__]}(`);
    } else if (!nested) {
      parts.push("(");
    }

    let node: Pair = this;
    let first = true;

    // Iterate through cdr chain (no recursion on cdr = no stack overflow on long lists)
    while (is_pair(node)) {
      const nodeWithCycles = node as PairWithMetadata;
      if (!first) {
        if (nodeWithCycles[__ref__]) {
          // Shared structure in cdr position - print as dotted pair with full notation
          parts.push(" . ", node.toString(quote));
          node = nil as unknown as Pair;
          continue;
        }
        parts.push(" ");
      }
      first = false;

      // Car value (recursive for nested structures - usually shallow)
      const carValue = nodeWithCycles[__cycles__]?.car ?? stringifyValue(node.car, quote);
      if (carValue !== undefined) {
        parts.push(String(carValue));
      }

      // Check for cdr cycle marker
      if (nodeWithCycles[__cycles__]?.cdr) {
        parts.push(" . ", String(nodeWithCycles[__cycles__].cdr));
        break;
      }

      node = node.cdr as Pair;
    }

    // Improper list tail (non-nil, non-pair cdr)
    if (!is_nil(node) && !is_pair(node)) {
      parts.push(" . ", stringifyValue(node, quote));
    }

    // Closing paren
    if (!nested || thisWithCycles[__ref__]) {
      parts.push(")");
    }
    return parts.join("");
  }

  set(prop: "car" | "cdr", value: unknown): void {
    (this as Pair<unknown, unknown>)[prop] = value;
    if (is_pair(value)) {
      this.mark_cycles();
    }
  }

  append(arg: unknown): this {
    if (Array.isArray(arg)) {
      return this.append(Pair.fromArray(arg));
    }
    const self = this as Pair<unknown, unknown>;
    let p: Pair = self;
    if (p.car === undefined) {
      if (is_pair(arg)) {
        self.car = arg.car;
        self.cdr = arg.cdr;
      } else {
        self.car = arg;
      }
    } else if (!is_nil(arg)) {
      while (true) {
        if (is_pair(p) && is_pair(p.cdr)) {
          p = p.cdr;
        } else {
          break;
        }
      }
      (p as Pair<unknown, unknown>).cdr = arg;
    }
    return this;
  }

  serialize(): [unknown, unknown] {
    return [this.car, this.cdr];
  }

  [Symbol.iterator](): Iterator<unknown> {
    let node: Pair | Nil | unknown = this;
    return {
      next(): IteratorResult<unknown> {
        const cur = node;
        if (is_nil(cur)) {
          node = nil;
          return { value: undefined, done: true };
        }
        if (!is_pair(cur)) {
          node = nil;
          return { value: cur, done: false };
        }
        node = cur.cdr;
        return { value: cur.car, done: false };
      },
    };
  }
}

// Register Pair constructor with types.ts for Nil.append
setPairConstructor(Pair);
