/**
 * Simplified type test to debug parent discrimination
 */

import { PlexusModel, syncing } from "../../index.js";

@syncing("A")
class A extends PlexusModel<null> {
  @syncing.child accessor child: B | null = null;
}

@syncing("B")
class B extends PlexusModel<A> {
  @syncing accessor value: string = "";
}

@syncing("C")
class C extends PlexusModel<null> {
  @syncing.child accessor child: B | null = null;
}

// Test 1: B should work in A (correct parent)
const a = new A();
const b = new B();
a.child = b; // ✅ Should work

// Test 2: B should NOT work in C (wrong parent - B expects A, not C)
const c = new C();

// LIMITATION: TypeScript decorators can't enforce parent types at assignment time
// This SHOULD be a type error (B expects parent A, not C) but TypeScript allows it
// The decorator validates correctly, but assignment-time checking isn't possible
c.child = b; // No error - demonstrates TypeScript decorator limitation

// Let's check the inferred types
type BParent = B extends PlexusModel<infer P> ? P : never;
// BParent should be A
const _bParent: BParent = null as any as A; // Check: should be A

type AChildType = A["child"];
// Should be B | null
const _aChild: AChildType = null as any as B | null;

type CChildType = C["child"];
// Should be B | null BUT the assignment should still fail because B expects parent A
const _cChild: CChildType = null as any as B | null;

// Debug: What did DiscriminateValue resolve to?
// If discrimination worked, C.child should be `never` or a different type than A.child

// Check if the types are actually different
type AreChildTypesSame = AChildType extends CChildType ? (CChildType extends AChildType ? true : false) : false;
const _same: AreChildTypesSame = true; // If this compiles, types are the same (bug)

// The issue: TypeScript sees both as "B | null" without checking parent compatibility
