export {}
/**
 * @here.build/arrival-env
 *
 * Lightweight type definitions and Symbol protocol for Arrival S-expression serialization.
 * This package provides the typing and protocol without the full LIPS runtime.
 *
 * Simply import this package to get global Symbol.toSExpr and Symbol.SExpr support:
 * ```typescript
 * import "@here.build/arrival-env";
 *
 * class MyClass {
 *   [Symbol.toSExpr](ctx) {
 *     return [this.id, this.name];
 *   }
 *   [Symbol.SExpr]() {
 *     return "MyClass";
 *   }
 * }
 * ```
 */
declare global {

  /**
   * Context provided to Symbol.toSExpr implementations
   *
   * These helpers provide semantic control over serialization:
   *
   * - **keyword**: Property names in key-value pairs (`:type`, `:children`)
   *   Use for named properties in your S-expression representation
   *
   * - **symbol**: Unquoted identifiers and references (`map`, `component-uuid`)
   *   Use for entity references, operators, or identifiers that should not be quoted
   *
   * - **quote**: Force a value to be a string literal
   *   Use when a string value might be confused with a symbol
   *
   * - **expr**: Nested S-expressions `(head arg1 arg2)`
   *   Use for complex nested structures
   */
  interface SExprSerializationContext {
    /**
     * Create a keyword for property names (prefixed with `:`)
     * @example keyword("type") → :type
     */
    keyword: (value: string) => SExprSerializable;

    /**
     * Create an explicitly unquoted symbol (for identifiers, operators, references)
     * @example symbol("target-uuid") → target-uuid (not "target-uuid")
     */
    symbol: (value: string) => SExprSerializable;

    /**
     * Create expression quote. This is NOT quoted string
     * @example quote("map") → 'map
     */
    quote: (value: string) => SExprSerializable;

    /**
     * Force a string literal (prevents symbol interpretation)
     * @example quote("map") → "map" (not the map operator)
     */
    string: (value: string) => SExprSerializable;

    /**
     * Create a nested S-expression
     * @example expr("list", 1, 2, 3) → (list 1 2 3)
     */
    expr: (head: string | SExprSerializable, ...args: SExprSerializable[]) => SExprSerializable;
  }

  /**
   * Values that can be serialized to S-expressions
   */

  type SExprSerializable =
    | string
    | number
    | bigint
    | boolean
    | null
    | symbol
    | SExprSerializable[]
    | { [key: string]: any };
}

// Define the Symbol.toSExpr protocol globally
declare global {
  interface SymbolConstructor {
    /**
     * Symbol for custom S-expression serialization
     * Implement this method to control how your objects are serialized to Arrival S-expressions
     */
    readonly toSExpr: unique symbol;

    /**
     * Symbol for custom S-expression type name
     * Return the name that should appear as the expression head
     */
    readonly SExpr: unique symbol;
  }

  interface Object {
    /**
     * Custom serialization to S-expressions
     *
     * Context helpers provide semantic control over how values are serialized:
     * - `keyword(str)` - Property names, map keys (`:name`, `:type`)
     * - `symbol(str)` - Identifiers, operators, unquoted names (`map`, `filter`)
     * - `quote(str)` - Force string literal even if it looks like a symbol
     * - `expr(head, ...args)` - Nested expressions `(list 1 2 3)`
     *
     * @param context Destructure as `{ keyword, symbol, quote, expr }`
     * @returns Array of elements that will form the expression body
     *
     * @example
     * ```typescript
     * // Property-value pairs with keywords
     * [Symbol.toSExpr]({ keyword }) {
     *   return [
     *     this.uuid,                    // Positional: uuid as identifier
     *     this.name,                    // Positional: name as string
     *     keyword("type"), this.type,   // Named property: :type "component"
     *     keyword("children"), this.children.map(c => c.uuid)  // :children [uuid1 uuid2]
     *   ];
     * }
     * // → (Component uuid "name" :type "component" :children [uuid1 uuid2])
     * ```
     *
     * @example
     * ```typescript
     * // Using symbols for references
     * [Symbol.toSExpr]({ keyword, symbol }) {
     *   return [
     *     this.id,
     *     keyword("ref"), symbol(this.target.uuid)  // :ref target-uuid (not "target-uuid")
     *   ];
     * }
     * // → (Reference id :ref target-uuid)
     * ```
     */
    [Symbol.toSExpr]?: (context: SExprSerializationContext) => Array<string | SExprSerializable>;

    /**
     * Custom S-expression type name
     * @returns The name that appears as the expression head
     *
     * @example
     * ```typescript
     * [Symbol.SExpr]() {
     *   return "Component";
     * }
     * // Results in: (Component ...)
     * ```
     */
    [Symbol.SExpr]?: () => string;
  }
}

// Initialize the symbols (safe to call multiple times)
if (typeof Symbol !== "undefined") {
  if (!Symbol.toSExpr) {
    // @ts-expect-error - Defining new symbol on global Symbol
    // noinspection JSConstantReassignment
    Symbol.toSExpr = Symbol.for("arrival:toSymbolicExpression");
  }

  if (!Symbol.SExpr) {
    // @ts-expect-error - Defining new symbol on global Symbol
    // noinspection JSConstantReassignment
    Symbol.SExpr = Symbol.for("arrival:symbolicExpressionSymbol");
  }
}
