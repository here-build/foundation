# @here.build/arrival-scheme

**Sandboxed Scheme interpreter for AI agent exploration**

Fork of LIPS.js rewritten to prioritize sandboxing over JavaScript compatibility. AI agents explore problem spaces in Scheme without triggering state changes or side effects.

> ⚠️ **version 0.x may be unsafe - use zero-trust environments only**
>
> This is a fork of LIPS.js with known architectural security issues. We've identified potential sandbox escape strategies but haven't fixed all of them yet. **Assume the sandbox can be escaped.** Use only in isolated containers, unprivileged Worker threads and ShadowRealms, or any other environment that can be considered zero-trust.
> 
> Version 1.x will be released after external audit verifying it is production-ready.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works. When AI agents explore data ("find all items where priority > threshold"), they think in filter/map/compose patterns. Scheme is the notation for compositional thinking.

Sandboxing prevents exploration from accidentally executing actions.

## Quick Start

```bash
npm install @here.build/arrival-scheme
```

### Basic Execution

```typescript
import { exec, sandboxedEnv, lipsToJs } from '@here.build/arrival-scheme';

const results = await exec(`
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`, { env: sandboxedEnv });

console.log(lipsToJs(results[0], {})); // [7, 9]
```

### Register Custom Functions

`@here.build/arrival-scheme` provides scheme-js interoperability layer capable of entities translation between runtimes.

```typescript
import { exec, sandboxedEnv, lipsToJs } from '@here.build/arrival-scheme';

// Rosetta: automatic JS ↔ Scheme conversion
sandboxedEnv.defineRosetta('double-all', {
  fn: (numbers: number[]) => numbers.map(x => x * 2)
});

const results = await exec(`
  (double-all (list 1 2 3 4 5))
`, { env: sandboxedEnv });

console.log(lipsToJs(results[0], {})); // [2, 4, 6, 8, 10]
```

### Complex Data

```typescript
import { exec, sandboxedEnv, lipsToJs, jsToLips } from '@here.build/arrival-scheme';

// Register function filtering objects
sandboxedEnv.defineRosetta('high-priority-users', {
  fn: (users: Array<{id: string, priority: number}>) =>
    users.filter(u => u.priority > 10)
});

// Pass JS data to Scheme
const users = [
  { id: "alice", priority: 15 },
  { id: "bob", priority: 5 },
  { id: "charlie", priority: 20 }
];

sandboxedEnv.set('users', jsToLips(users, {}));

const results = await exec(`
  (high-priority-users users)
`, { env: sandboxedEnv });

console.log(lipsToJs(results[0], {}));
// [{ id: "alice", priority: 15 }, { id: "charlie", priority: 20 }]
```

## Key Differences from LIPS.js

This is a **fork** of LIPS with fundamental architectural changes:

### 1. Sandboxed by Default

**LIPS.js**: Full JavaScript interop, call any JS function, access global scope
**arrival-scheme**: Isolated environment, only explicitly registered functions

```typescript
// LIPS.js: dangerous
await exec(`(. console (log "pwned"))`); // Has console access

// arrival-scheme: safe
await exec(`(. console (log "pwned"))`, { env: sandboxedEnv });
// Error: console not defined
```

### 2. Rosetta Integration

**LIPS.js**: Manual conversion between JS and Scheme types
**arrival-scheme**: Automatic translation via Rosetta layer

```typescript
// Automatic conversion:
// - JS arrays ↔ Scheme lists (consider nil)
// - JS objects ↔ Scheme alists
// - JS functions → Scheme procedures
// - Natural interop in both directions
```

### 3. Fantasy-land Support

**LIPS.js**: Fixed implementations of map, filter, etc.
**arrival-scheme**: Polymorphic operations defined by data structures

Custom data structures can implement `map`, `filter`, `reduce` following the [fantasy-land](https://github.com/fantasyland/fantasy-land) spec, and Scheme primitives will use them. This is exceptionally useful for complex structures like trees.

### 4. Polyglot runtime

Some features from other Lisp dialects were added as expression means, e.g. `(:key alist)` property accessor.

## Sandbox Architecture

### What's Allowed

**Standard Scheme library**:
- List operations: `car`, `cdr`, `cons`, `list`, `append`, etc.
- Higher-order: `map`, `filter`, `reduce`, `fold`, etc.
- Logic: `and`, `or`, `not`, `if`, `cond`, etc.
- Math: `+`, `-`, `*`, `/`, `>`, `<`, `=`, etc.
- Lambda functions and closures

**Explicitly registered functions**:
- Via `env.defineRosetta(name, { fn })`
- Via `env.set(name, value)`

### What's Blocked or Removed

**Filesystem access**: No `open-input-file`, `open-output-file`, etc.
**Network access**: No fetch, HTTP, sockets
**Process execution**: No `system`, shell commands
**Global JavaScript**: No `window`, `global`, `process`, `require`
**Unregistered functions**: Attempting to call undefined function throws error

### Isolation Boundaries

```typescript
// Environment is isolated per execution
const env1 = sandboxedEnv.clone();
const env2 = sandboxedEnv.clone();

env1.set('x', 10);
env2.set('x', 20);

await exec(`x`, { env: env1 }); // 10
await exec(`x`, { env: env2 }); // 20
```

Each environment maintains separate bindings. Global state variance don't leak between executions.

### Error Handling

Errors are thrown with extra metadata at `publicMessage` on potential issues.

This provides valuable feedback instead of opaque, unclear behavior.

## Security Status

⚠️ **version 0.x - use at your own risk**

LIPS.js (upstream) has deep JavaScript integration that creates attack surfaces. We've removed the biggest ones (filesystem, process, network access) but sandbox escape is still feasible at least via property access and some rosetta layer aspects.

**Do not**:
- Expose to untrusted user input without additional isolation
- Use in security-critical contexts
- Deploy without containerization
- Trust sandbox isolation

We welcome security researchers to responsibly disclose findings and collaborate on improvements: team@here.build or @merkle_bonsai (Telegram/X)

## Rosetta Translation Layer

Automatic conversion between JavaScript and Scheme:

### JS → Scheme

| JavaScript | Scheme |
|-----------|--------|
| `[1, 2, 3]` | `(list 1 2 3)` |
| `{x: 10, y: 20}` | `((x . 10) (y . 20))` (alist) |
| `(a, b) => a + b` | `(lambda (a b) (+ a b))` |
| `null` / `undefined` | `nil` |
| `true` / `false` | `#t` / `#f` |

### Scheme → JS

| Scheme | JavaScript |
|--------|-----------|
| `(list 1 2 3)` | `[1, 2, 3]` |
| `((x . 10) (y . 20))` | `{x: 10, y: 20}` |
| `#t` / `#f` | `true` / `false` |
| `nil` | `null` |
| Symbols | Strings (configurable) |

### Registering Functions

```typescript
// Simple function
env.defineRosetta('add', {
  fn: (a: number, b: number) => a + b
});

// With type conversion hints
env.defineRosetta('process-users', {
  fn: (users: User[]) => users.filter(u => u.active),
  // Automatic conversion of return value to Scheme list
});

// Direct Scheme value
env.set('pi', 3.14159);
env.set('config', jsToLips({ timeout: 5000 }, {}));
```

## Fantasy-land Support

Data structures can implement algebraic operations via fantasy-land spec:

```typescript
// Custom list type implementing map
class MyList {
    ["fantasy-land/map"]<U>(fn: (value: T) => U): Tree<U> {
        return new MyList(
            fn(this.value),
            this.children.map((child) => child["fantasy-land/map"](fn))
        );
    }
}

// Scheme (map) will use the .map method
await exec(`(map double my-list)`, { env });
```

Supported algebras:
- Functor: `map`
- Apply: `ap`
- Chain: `chain` / `flatMap`
- Monoid: `empty`, `concat`

[request on collaboration: deeper fantasy-land integration and description is needed]

## Performance Characteristics

**Overhead vs native JS**:
- Interpretation cost: ~10-100x slower than native
- Worth it for: Isolation, sandboxing, compositional expressiveness, AI intent expression
- Not worth it for: CPU-intensive computation

**Optimization**:
- Register performance-critical functions in JS via Rosetta
- Use Scheme for orchestration, JS for computation
- Limit expression complexity

**Not yet benchmarked**:
- Precise overhead measurements
- Memory usage profiles
- Comparison with other sandboxing approaches

## API Reference

### Core Functions

**`exec(code: string, options: ExecOptions): Promise<any[]>`**

Execute Scheme code, return results.

```typescript
const results = await exec(`(+ 1 2 3)`, { env: sandboxedEnv });
console.log(results[0]); // 6
```

**`jsToLips(value: any, context: ConversionContext): LipsValue`**

Convert JavaScript value to Scheme representation.

**`lipsToJs(value: LipsValue, context: ConversionContext): any`**

Convert Scheme value to JavaScript.

### Environment Methods

**`env.defineRosetta(name: string, { fn: Function })`**

Register JS function with automatic type conversion.

**`env.set(name: string, value: LipsValue)`**

Set binding in environment (use `jsToLips` for JS values).

**`env.get(name: string): LipsValue`**

Get binding from environment.

**`env.clone(): Environment`**

Create isolated copy of environment.

TypeScript types coverage will be added eventually.

## Contributing

Early-stage fork. We're interested in:

- **Security review** - audit sandbox isolation
- **Performance benchmarks** - measure overhead
- **Fantasy-land docs** - document algebraic operations
- **Testing** - expand test coverage

## License

Future MIT (irrevocable, effective starting January 1, 2027).

Until then: MIT terms except for three specific commercial uses.

This is a fork of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed). LIPS.js copyright notices are preserved in source files.

See [LICENSE.md](../../LICENSE.md) for complete terms.
