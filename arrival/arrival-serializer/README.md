# @here.build/arrival-serializer

S-expression serializer for Arrival - systematic conversion between JavaScript objects and Scheme/Lisp representations.

## Overview

This package provides tools to convert JavaScript values to s-expressions (symbolic expressions), the fundamental data structure in Lisp-family languages. It is not guaranteeing fully correct representation (yet aiming to), and is focused on data expression via s-expression syntax.

## Features

- **Stepped serialization**: Convert JS objects to s-expressions first, and format them as strings later
- **Simple array IR**: you can simply spread one representation inside another
- **Configurable, specific serialization**: Use `Symbol.toSExpr` for custom type representations
- **LIPS type support**: Built-in handling for LIPS (Scheme) types, along with `@here.build/arrival-scheme`
- **Smart formatting**: Automatic pretty-printing with context-aware indentation
- **Type-safe**: Full TypeScript support

## Installation

```bash
pnpm add @here.build/arrival-serializer
```

## Quick Start

```typescript
import { toSExpr, formatSExpr, toSExprString } from '@here.build/arrival-serializer';

// Basic values
toSExprString(42);              // "42"
toSExprString("hello");         // '"hello"'
toSExprString([1, 2, 3]);       // '(list 1 2 3)'

// Objects
toSExprString({ x: 10, y: 20 }); // '&(:x 10 :y 20)'

// Custom serialization
class Point {
  constructor(public x: number, public y: number) {}
    
  // this part is optional - when Symbol.toSExpr is present, serializer tries following heruistics to identify the symbol:
  // this[Symbol.SExpr]?() ?? this.displayName ?? this.constructor.displayName ?? this.name ?? this.constructor.name
  [Symbol.SExpr]() {
      return "Point";
  }

  [Symbol.toSExpr](ctx) {
    return [ctx.keyword('x'), this.x, ctx.keyword('y'), this.y];
  }
}

toSExprString(new Point(10, 20)); // '(Point :x 10 :y 20)'
```

## Best practices

Representing entities in symbolic expressions efficiently may be tricky.
However, since baseline is already at least as efficient as json, you're free to optimize only specific entities.

Most of the optimizations are "cognitive", they improve output quality but may not improve the tokenomics. Some are purely token-efficient. Most of them are both. Each improvement is producing minor improvement on tokenomics - 5-10% - but when used systematically at most "painful", most data-heavy locations, it can give 30-60% token savings with semantically preserved information. The last example is actually providing better semantic representation with human-readable formatting than compressed JSON, while consuming less tokens.

Following best practices were discovered and can be generally used:

### Type, name and ID

This is the simplest optimization (both cognitive and token-efficient) you can do for most of the entities you have:

```typescript
class User {
    id: string;
    name: string;
    [Symbol.toSExpr]({quote, string}) {
        // note that you do not have to wrap props in any manner. They will auto-convert to &() expr.
        // serializer will dive into object recursively, and will use Symbol.toSExpr inside where applicable,
        // otherwise just follow standard serialization rules.
        return [quote(this.id), string(this.name), this.props];
    }
}
```

will produce this expression (17 Claude tokens, 13 GPT-4o tokens):

```scheme
(User 'abc123 "John Doe" &(:role admin))
```

For comparison, the JSON representing that data will look like this (47 Claude tokens, 39 GPT-4o tokens; 39 and 32 accordingly without `"type": "user"`, 22/19 when additionally minified):

```json
{
  "type": "user",
  "id": "abc123",
  "name": "John Doe",
  "props": {
    "role": "admin"
  }
}
```

What's odd here about the serialization is that people report that this format is more readable (not parsable but specifically readable) for them too - even ones with zero experience with Scheme or Lisp, just common programming.

> **Why named entities improve processing:**
>
> The same reason variable names matter in code vs raw memory addresses - they create semantic anchors for pattern recognition. `(User 'abc123 "John")` provides three types of information: entity type (User), unique identifier (quoted symbol), and display name (string). This matches how humans reason about entities.
>
> **Why quoted symbols work as identifiers:**
>
> High-entropy strings (like UUIDs) are naturally understood as unique pointers. The quoted symbol syntax `'abc123` signals "this is a reference/identifier symbol, not data" - same cognitive pattern as pointers in programming. AI models trained on code recognize this pattern immediately. 

### Property enumeration

Of course, you can iterate over properties directly into expression (with some manual work):

```typescript
class User {
    id: string;
    name: string;
    [Symbol.toSExpr]({quote, keyword, string}) {
        // note that you do not have to wrap props in any manner. They will auto-convert to &() expr.
        // serializer will dive into object recursively, and will use Symbol.toSExpr inside where applicable,
        // otherwise just follow standard serialization rules.
        return [
            quote(this.id), 
            string(this.name),
            // you may also use expr(key, value) - but this is recommended to group entities;
            // AI handles :key value :key value enumeration great
            Object.entries(this.props).map(([key, value]) => [keyword(key), value])
        ].flat();
    }
}
```
will produce this (16 Claude tokens, 12 GPT-4o tokens):

```scheme
(User 'abc123 "John Doe" :role admin)
```

### Iterative properties

If you have some field that represents unordered collection, it will be useful to represent this collection as (collection-name ...collection-items).

E.g.:

```typescript
class Team {
    id: string;
    name: string;
    members: User[];
    [Symbol.toSExpr]({quote, string, expr}) {
        // note that you do not have to wrap props in any manner. They will auto-convert to &() expr.
        // serializer will dive into object recursively, and will use Symbol.toSExpr inside where applicable,
        // otherwise just follow standard serialization rules.
        return [quote(this.id), string(this.name), expr("members", ...this.members)];
    }
}
```

will produce this as a serialization output (36/28 Claude/GPT, 30/24 compressed):
```scheme
(Team 'def456 "Team Rocket" 
  (members 
    (User 'abc123 "John Doe" :role admin)))
```

that is perceptionally equivalent to this JSON (90/74, 36/31 without types and compressed):

```json
{
  "type": "team",
  "id": "def456",
  "name": "Team Rocket",
  "members": [
    {
      "type": "user",
      "id": "abc123",
      "name": "John Doe",
      "props": {
        "role": "admin"
      }
    } 
  ]
}
```

### Flags as keywords

If there are some optional flags or attributes that clearly make sense only when present, you may explicitly annotate them as keywords when needed. Same works with keywords that have clear attribution (e.g. in here.build we have html element nodes in render tree, and `:div` or `:section` has pretty clear semantic value). You may also just skip fields or replace them with keywords for better semantic representation. Same approach works beautifully with e.g. flag sets 

```typescript
class Team {
    id: string;
    name: string;
    members: User[];
    isFreeTier: boolean;
    [Symbol.toSExpr]({quote, string, keyword, expr}) {
        return [
            quote(this.id),
            this.name ? string(this.name) : [],
            // using .flat(1) is just our team preference, you can use any alternative approach
            this.isFreeTier ? keyword("free-tier") : [], 
            expr("members", ...this.members)
        ].flat(1);
    }
}
```

will produce this (34/27; 29/23 compressed):
```scheme
(Team 'def456 :free-tier
  (members 
    (User 'abc123 "John Doe" :role admin)))
```
that is semantically equal to this(96/79; 40/34 no-type and compressed):
```json
{
  "type": "team",
  "id": "def456",
  "name": "",
  "isFreeTier": true,
  "members": [
    {
      "type": "user",
      "id": "abc123",
      "name": "John Doe",
      "props": {
        "role": "admin"
      }
    } 
  ]
}
```

Note how readable s-expression representation remains. With less tokens used than in compressed JSON, it is more clear, more comfortable to read than even formatted JSON. Same works for AI - there are several not-yet-validated theories we have, but this is clearly domain to be researched.

### Views

In here.build, we're using views as a concept heavily.
E.g. when user is mentioned in data structure, it's not described in full;
instead, it's usually something like `(User 'abc123 "John Doe")`. It works good as a cyclic reference defense and for usage optimization.

Yet, certain representations (e.g. component render tree) are producing way larger structures.
They are describing the entities from certain aspect, or just describe in details.

This is one of actually used views from here.build:

```typescript
export class ParamView {
  get uuid() {
    return this.param.uuid;
  }

  constructor(private param: Param) {}

  [Symbol.toSExpr](context) {
    const { quote, string, expr, keyword } = context;
    return [
      // repeat what param itself tells about it
      (this.param)[Symbol.toSExpr]?.(context) ?? [],
      keyword(ParamOps.getParamTypeName(this.param.type)),
      this.param.required ? keyword("required") : [],
      this.param instanceof SlotParam ? keyword(this.param.isMainContentSlot ? "main-slot" : "slot") : [],
      this.param.isRepeated ? keyword("repeated") : [],
      this.param instanceof StateParam ? keyword("state") : [],
      this.param instanceof PropParam ? keyword("property") : [],

      // Values (only if present)
      this.param.defaultExpr ? expr("default", ParamOps.extractLiteralValue(this.param.defaultExpr)) : [],
      this.param.previewExpr ? expr("preview", ParamOps.extractLiteralValue(this.param.previewExpr)) : [],
      // ...more fields...
    ].flat(1);
  }
}
```

## API

### Core Functions

#### `toSExpr(obj: any): SExpr`
Converts a JavaScript value to an s-expression representation.

#### `formatSExpr(sexpr: SExpr, indent?: number): string`
Formats an s-expression as a pretty-printed string.

#### `toSExprString(obj: any, indent?: number): string`
Convenience function that combines `toSExpr` and `formatSExpr`.

### Helper Functions

#### `sexpr(tag: string, ...args: any[]): SExprDefinition`
Creates a tagged s-expression.

#### `smap(obj: Record<string, any>): SExprDefinition`
Creates a map-style s-expression from an object.

#### `slist(...items: any[]): SExprDefinition`
Creates a list s-expression.

### Custom Serialization

Implement `Symbol.toSExpr` on your classes to control their serialization:

```typescript
class CustomType {
  [Symbol.toSExpr](ctx) {
    return [
      ctx.symbol('my-symbol'),    // Unquoted symbol
      ctx.keyword('my-keyword'),  // :my-keyword
      ctx.quote('quoted'),        // 'quoted
      ctx.string('string'),       // "string"
      ctx.expr('func', arg1, arg2) // (func arg1 arg2)
    ];
  }
}
```

The context object provides:
- `ctx.symbol(value)` - Creates an unquoted symbol
- `ctx.keyword(value)` - Creates a keyword (`:value`)
- `ctx.quote(value)` - Creates a quoted value
- `ctx.string(value)` - Creates a quoted string
- `ctx.expr(head, ...args)` - Creates an expression

## Type Mappings

| JavaScript | S-Expression                  |
|-----------|-------------------------------|
| `null`, `undefined` | `nil`                         |
| Numbers | Numbers (with BigInt support) |
| Strings | Quoted strings                |
| Booleans | `true` / `false`              |
| Arrays | `(list ...)`                  |
| Objects | `&(:key value ...)`           |
| Symbols | `:keyword`                    |
| Map | `&(:key value ...)`       |
| Set | `(set ...)`                   |
| Date | ISO string                    |

## LIPS Integration

The serializer has built-in support for LIPS (Scheme interpreter) types:
- `LNumber`, `LFloat`, `LBigInteger` → Numbers
- `LSymbol` → Symbols/keywords
- `LString` → Quoted strings
- `LCharacter` → Character literals (`#\char`)
- `Pair` → Lists
- `Values` → Multiple return values

## Part of Arrival

This package is part of the Arrival ecosystem:
- **@here.build/arrival-env** - Type definitions and protocols
- **@here.build/arrival-scheme** - Scheme interpreter integration
- **@here.build/arrival-serializer** - This package
- **@here.build/arrival** - Umbrella package exposing everything

## License

MIT
