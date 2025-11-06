# @here.build/plexus-mobx

Enhanced MobX observer components with Plexus tracking integration.

## Overview

Reactivity requires one of two approaches:

**Direct MobX integration:**

```typescript
import { enableMobXIntegration } from "@here.build/plexus-mobx";

enableMobXIntegration();
```

This integrates Plexus tracking into MobX. Use MobX's `observer` components and `computed` values normally. It just works.

**Advanced (custom reactivity frameworks):**

```typescript
import { createTrackedFunction, trackingHook } from "@here.build/plexus";

// Granular reactivity for specific functions
createTrackedFunction(callback, fn);

// Global tracking hooks
trackingHook.access = (entity, field) => { /* ... */ };
trackingHook.modification = (entity, field) => { /* ... */ };
```

## That's all?

Yes. This is literally it. 

`enableMobXIntegration` is simply connecting MobX atoms to `trackingHook.access` and `trackingHook.modification`. It is literally 22 lines. Look at [src/index.ts](./src/index.ts) if you are building custom integration.

Things are simple, when you have right foundation.

For Plexus, any field interaction is reported as `[entity: PlexusModel | Set | Array | Record, field: string | Symbol("all keys")]`. There are no nested interactions, as any deep access is always just "operation on another model": `root.teams[0].name` reports access to:
- `[root, "teams"]`
- `[root.teams, 0]`
- `[team, "name"]`

Plexus is designed to make things simpler - not harder.
