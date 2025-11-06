# @here.build/arrival-env

Minimal package that provides `Symbol.SExpr` and `Symbol.toSExpr` definitions without actual serialization runtime injection.

Use this in shared libraries that need S-expression serialization in some environments but not others.

## When to Use This

You have a shared model library used across multiple environments:
- MCP server needs to serialize models to S-expressions for AI agents
- Browser frontend just needs the models as regular classes
- You don't want to bundle the full arrival runtime everywhere

## Quick Start

**In your shared library:**

```bash
npm install @here.build/arrival-env
```

```typescript
// shared-models/src/button.ts
import '@here.build/arrival-env';

export class Button {
  constructor(public label: string, public disabled: boolean) {}

  [Symbol.SExpr]() {
    return 'Button';
  }

  [Symbol.toSExpr]({keyword, expr}) {
    return [
        expr('label', this.label), 
        ...(this.disabled ? [keyword('disabled')] : [])
    ];
  }
}
```

### Symbol.toSExpr context

Symbol.toSExpr invocation provides expressive context to use:
```typescript
export class Button {
  [Symbol.toSExpr]({keyword, symbol, quote, string, expr}) {
    return [
        keyword("clickable"), // produces :clickable. Semantic meaning - unique flag, object key
        symbol(this.name), // produces clickme. No semantic value found, added for totality
        quote(this.uuid), // produces 'abc123. Semantic meaning - unique identifier to reference
        string(this.description), // produces "description" - always quoted even when quotes are optional. Semantic meaning - explicit text entity
        expr("onClick", this.clickHandler) // produces (onClick ...). Semantic meaning - isolated statement
    ];
  }
}
```

You can return all types - objects, classes, arrays, sets, etc.

S-expression serializer is designed to generally produce "at least as good as json" output, with custom definitions allowing to make certain entities more expressive and compact.

### In environments that need serialization (MCP server):

```typescript
import { toSExprString } from '@here.build/arrival';
import { Button } from 'shared-models';

const btn = new Button('Click me', false);
toSExprString(btn);
// => (Button
//      :label "Click me"
//      :disabled false)
```

### In environments that don't (browser):

```typescript
import { Button } from 'shared-models';
// No arrival runtime bundled, just the class
```

The protocol is defined once in the shared library. Serialization happens only where `@here.build/arrival` is imported.

Package use is idempotent - multiple sources may include it, yet `Symbol.SExpr` and `Symbol.toSExpr` are defined in stable, failsafe way.
