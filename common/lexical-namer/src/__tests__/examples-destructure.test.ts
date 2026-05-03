/**
 * Component examples — destructure-form emit.
 *
 * Each entity that has multiple facets (read+setter for state, data+status+
 * error for query, mutate+isPending for mutation) is expressed as a RICH
 * entity (`shapes` field), not the simple `candidates` form. The resolver
 * selects a shape per entity; emitted code reflects the selected shape.
 *
 * For state, the canonical shape ladder is:
 *   T100 destructure        — `const [open, setOpen] = useState(false)`
 *   T80  non-destructure     — `const stateOpen = useState(false)` + `[0]`/`[1]`
 *
 * Strategy emits T100 first; resolver picks T100 if both bindings allocate.
 * Falls to T80 only when destructure is forced to fail (rare). Reviewer's
 * verdict on the all-non-destructure form: hostile machine output. The
 * destructure shape produces idiomatic React.
 *
 * Result lookup convention:
 *   resolution.bindingNames.get(subKey) → resolved binding name
 *   resolution.facetExpressions.get(facet) → resolved access expression
 */

import { describe, expect, it } from "vitest";

import { resolveLexicalNames, type ResolveOptions } from "../index.js";

const stringPostfix: ResolveOptions<string>["postfixFor"] = (k) => k;

// ─── Example D1 ────────────────────────────────────────────────────────
//
//   import * as React from "react";
//   import { useState } from "react";
//   export function Foo(props) {
//     const [open, setOpen] = useState(false);
//     return (
//       <button onClick={() => setOpen(!open)}>
//         {open ? "Open" : "Closed"}
//       </button>
//     );
//   }

describe("D1: one state — destructure form preferred and selected", () => {
  it("selects destructure shape; bindingNames and facetExpressions reflect it", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useState", "Foo"],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 100, // destructure
                    bindings: [
                      {
                        subKey: "state:open:read",
                        candidates: { 100: "open", 80: "openValue" },
                      },
                      {
                        subKey: "state:open:setter",
                        candidates: { 100: "setOpen", 80: "setOpenValue" },
                      },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:read", access: "" },
                      setter: { kind: "binding", ref: "state:open:setter", access: "" },
                    },
                  },
                  {
                    priority: 80, // non-destructure fallback
                    bindings: [
                      {
                        subKey: "state:open:tuple",
                        candidates: { 100: "stateOpen", 80: "stateOpenResult" },
                      },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:tuple", access: "[0]" },
                      setter: { kind: "binding", ref: "state:open:tuple", access: "[1]" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("state:open");
    expect(r?.selectedShapePriority).toBe(100);
    expect(r?.bindingNames.get("state:open:read")).toBe("open");
    expect(r?.bindingNames.get("state:open:setter")).toBe("setOpen");
    expect(r?.facetExpressions.get("read")).toBe("open");
    expect(r?.facetExpressions.get("setter")).toBe("setOpen");
  });
});

// ─── Example D2 ────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const [open, setOpen] = useState(false);
//     const [value, setValue] = useState("");
//     return (
//       <div>
//         <input value={value} onChange={(e) => setValue(e.target.value)} />
//         <button onClick={() => setOpen(!open)}>{open ? value : "—"}</button>
//       </div>
//     );
//   }

describe("D2: two states — both destructure independently", () => {
  it("each state selects its T100 destructure shape", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useState", "Foo"],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:open:read", candidates: { 100: "open", 80: "openValue" } },
                      { subKey: "state:open:setter", candidates: { 100: "setOpen", 80: "setOpenValue" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:read", access: "" },
                      setter: { kind: "binding", ref: "state:open:setter", access: "" },
                    },
                  },
                ],
              },
              {
                key: "state:value",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:value:read", candidates: { 100: "value", 80: "valueState" } },
                      { subKey: "state:value:setter", candidates: { 100: "setValue", 80: "setValueState" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:value:read", access: "" },
                      setter: { kind: "binding", ref: "state:value:setter", access: "" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    expect(result.resolutions.get("state:open")?.facetExpressions.get("read")).toBe("open");
    expect(result.resolutions.get("state:open")?.facetExpressions.get("setter")).toBe("setOpen");
    expect(result.resolutions.get("state:value")?.facetExpressions.get("read")).toBe("value");
    expect(result.resolutions.get("state:value")?.facetExpressions.get("setter")).toBe("setValue");
  });
});

// ─── Example D3 ────────────────────────────────────────────────────────
//
//   import { open } from "./helpers";  // shadows the bare 'open' name
//   export function Foo(props) {
//     const [openValue, setOpen] = useState(false);
//     return (
//       <button onClick={() => setOpen(!openValue)}>{openValue ? "Open" : "Closed"}</button>
//     );
//   }
//
// The READ binding is forced to the T80 candidate ("openValue") because
// "open" is reserved at module scope. The SETTER binding still hits T100
// ("setOpen"). Mixed-tier per-binding allocation within ONE selected
// destructure shape.

describe("D3: state with READ binding forced to fallback (per-binding ladder)", () => {
  it("destructure shape still wins; one binding falls within the shape", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useState", "Foo", "open"], // imported helper
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:open:read", candidates: { 100: "open", 80: "openValue" } },
                      { subKey: "state:open:setter", candidates: { 100: "setOpen", 80: "setOpenValue" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:read", access: "" },
                      setter: { kind: "binding", ref: "state:open:setter", access: "" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("state:open");
    expect(r?.selectedShapePriority).toBe(100);
    expect(r?.facetExpressions.get("read")).toBe("openValue");
    expect(r?.facetExpressions.get("setter")).toBe("setOpen");
  });
});

// ─── Example D4 ────────────────────────────────────────────────────────
//
//   import { open, setOpen } from "./helpers"; // both T100 names taken
//   import { openValue } from "./more-helpers"; // T80 read also taken
//   export function Foo(props) {
//     const stateOpen = useState(false);
//     return <button onClick={() => stateOpen[1](!stateOpen[0])}>...</button>;
//   }
//
// Destructure shape can't satisfy any candidate combination → fall to T80
// non-destructure shape. This is the "rare" case where the reviewer-criticized
// indexed-access form is justified — every other option is taken.

describe("D4: destructure shape blocked → falls to non-destructure tuple", () => {
  it("selects T80 non-destructure shape; facet expressions are indexed", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: [
          "React",
          "useState",
          "Foo",
          "open", // T100 read blocked
          "setOpen", // T100 setter blocked
          "openValue", // T80 read also blocked
          "setOpenValue", // T80 setter also blocked
        ],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:open:read", candidates: { 100: "open", 80: "openValue" } },
                      { subKey: "state:open:setter", candidates: { 100: "setOpen", 80: "setOpenValue" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:read", access: "" },
                      setter: { kind: "binding", ref: "state:open:setter", access: "" },
                    },
                  },
                  {
                    priority: 80,
                    bindings: [
                      { subKey: "state:open:tuple", candidates: { 100: "stateOpen", 80: "stateOpenResult" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:tuple", access: "[0]" },
                      setter: { kind: "binding", ref: "state:open:tuple", access: "[1]" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("state:open");
    expect(r?.selectedShapePriority).toBe(80);
    expect(r?.bindingNames.get("state:open:tuple")).toBe("stateOpen");
    expect(r?.facetExpressions.get("read")).toBe("stateOpen[0]");
    expect(r?.facetExpressions.get("setter")).toBe("stateOpen[1]");
  });
});

// ─── Example D5 ────────────────────────────────────────────────────────
//
//   // Fully-controlled passthrough — applies when the consuming framework
//   // (e.g. Radix-style components) treats this state as completely owned by
//   // the parent. Component doesn't allocate local state at all.
//   //
//   //   export function Foo(props) {
//   //     return (
//   //       <button onClick={() => props.onOpenChange(!props.open)}>
//   //         {props.open ? "Open" : "Closed"}
//   //       </button>
//   //     );
//   //   }
//
// Note: this fixture covers the FULLY-CONTROLLED case. The CONTROLLABLE-WITH-
// DEFAULT case (`open ?? defaultOpen`, the dominant Radix-style pattern) is
// a different shape — would have its own bindings (a useState fallback) and
// a more complex facet expression. Modeled separately as a future fixture.

describe("D5: fully-controlled passthrough state via props (no local allocation)", () => {
  it("selects passthrough shape; facet expressions are props-relative", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "Foo"],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 110, // passthrough — preferred when applicable
                    bindings: [],
                    facets: {
                      read: { kind: "external", viaName: "props", access: ".open" },
                      setter: { kind: "external", viaName: "props", access: ".onOpenChange" },
                    },
                  },
                  {
                    priority: 100, // local destructure fallback
                    bindings: [
                      { subKey: "state:open:read", candidates: { 100: "open" } },
                      { subKey: "state:open:setter", candidates: { 100: "setOpen" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:read", access: "" },
                      setter: { kind: "binding", ref: "state:open:setter", access: "" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("state:open");
    expect(r?.selectedShapePriority).toBe(110);
    expect(r?.bindingNames.size).toBe(0); // no fresh allocations
    expect(r?.facetExpressions.get("read")).toBe("props.open");
    expect(r?.facetExpressions.get("setter")).toBe("props.onOpenChange");
  });
});

// ─── Example D6 ────────────────────────────────────────────────────────
//
//   // mobx-react target — uses useLocalObservable, not observable.box.
//   // observable.box is a 5%-case escape hatch; idiomatic mobx-react groups
//   // related state into one observable object.
//   import { useLocalObservable, observer } from "mobx-react-lite";
//   export const Foo = observer((props) => {
//     const store = useLocalObservable(() => ({
//       open: false,
//       toggle() { this.open = !this.open },
//     }));
//     return (
//       <button onClick={store.toggle}>
//         {store.open ? "Open" : "Closed"}
//       </button>
//     );
//   });
//
// One fresh binding (`store`); facets reach in via member access. The
// `setter` facet is a method on the store, not a separate binding —
// reflects mobx's "method on observable" idiom, not React's setter pattern.

describe("D6: mobx useLocalObservable realization (member-access facets)", () => {
  it("store binding selected; read=.open, action=.toggle", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useLocalObservable", "observer", "Foo"],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "state:open",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:open:store", candidates: { 100: "store", 80: "openStore" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:open:store", access: ".open" },
                      setter: { kind: "binding", ref: "state:open:store", access: ".toggle" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("state:open");
    expect(r?.selectedShapePriority).toBe(100);
    expect(r?.facetExpressions.get("read")).toBe("store.open");
    expect(r?.facetExpressions.get("setter")).toBe("store.toggle");
  });
});

// ─── Example D7 ────────────────────────────────────────────────────────
//
//   export function UserList(props) {
//     const { data: users, isLoading } = useQuery({ queryKey: ["users"], queryFn });
//     if (isLoading) return <div>Loading...</div>;
//     return <ul>{users?.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
//   }
//
// Query result destructure with rename (`data: users`). Two facets used,
// status NOT used → strategy emits only those facets.

describe("D7: query result with destructure (rename data → users)", () => {
  it("selects destructure shape; facets land on renamed bindings", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useQuery", "UserList"],
        children: [
          {
            id: "component:UserList",
            reservations: ["props", "queryFn"],
            entities: [
              {
                key: "query:users",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "query:users:data", candidates: { 100: "users", 80: "usersData" } },
                      {
                        subKey: "query:users:loading",
                        candidates: { 100: "isLoading", 80: "isLoadingUsers" },
                      },
                    ],
                    facets: {
                      data: { kind: "binding", ref: "query:users:data", access: "" },
                      isLoading: { kind: "binding", ref: "query:users:loading", access: "" },
                    },
                  },
                  {
                    priority: 80, // single-binding fallback
                    bindings: [
                      { subKey: "query:users:result", candidates: { 100: "queryUsers" } },
                    ],
                    facets: {
                      data: { kind: "binding", ref: "query:users:result", access: ".data" },
                      isLoading: { kind: "binding", ref: "query:users:result", access: ".isLoading" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("query:users");
    expect(r?.selectedShapePriority).toBe(100);
    expect(r?.facetExpressions.get("data")).toBe("users");
    expect(r?.facetExpressions.get("isLoading")).toBe("isLoading");
  });
});

// ─── Example D8 ────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const createUser = useMutation({ mutationFn: createUserApi });
//     return <button onClick={() => createUser.mutate({ name: "Alice" })}>Create</button>;
//   }
//
// Mutation: single binding (the mutation hook result), member-access at
// consumer sites for `.mutate`, `.isPending`, etc. No destructure attempted
// here because the dominant pattern in the React-Query community is single
// binding + member access (mutation result has many useful members).

describe("D8: mutation (single binding, member-access facets)", () => {
  it("single shape selected; facets are member-access on the binding", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "useMutation", "Foo"],
        entities: [{ key: "import:createUserApi", candidates: { 100: "createUserApi" } }],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "mutation:createUser",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      {
                        subKey: "mutation:createUser:result",
                        candidates: { 100: "createUser", 80: "createUserMutation" },
                      },
                    ],
                    facets: {
                      mutate: { kind: "binding", ref: "mutation:createUser:result", access: ".mutate" },
                      isPending: {
                        kind: "binding",
                        ref: "mutation:createUser:result",
                        access: ".isPending",
                      },
                      error: { kind: "binding", ref: "mutation:createUser:result", access: ".error" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("mutation:createUser");
    expect(r?.bindingNames.get("mutation:createUser:result")).toBe("createUser");
    expect(r?.facetExpressions.get("mutate")).toBe("createUser.mutate");
    expect(r?.facetExpressions.get("isPending")).toBe("createUser.isPending");
    expect(r?.facetExpressions.get("error")).toBe("createUser.error");
  });
});

// ─── Example D9 ────────────────────────────────────────────────────────
//
//   // Full-feature component, idiomatic React (the shape D8 + D7 + state
//   // destructure all together).
//   import * as React from "react";
//   import { useState, useCallback } from "react";
//   import { useQuery, useMutation } from "@tanstack/react-query";
//   import { fetchUsers, createUser as createUserApi } from "./api";
//   //
//   export function UserManager(props) {
//     const { data: users, isLoading } = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
//     const createUser = useMutation({ mutationFn: createUserApi });
//     const [name, setName] = useState("");
//     const [error, setError] = useState(null);
//     const handleSubmit = useCallback((e) => {
//       e.preventDefault();
//       if (!name) {
//         setError("Name required");
//         return;
//       }
//       createUser.mutate({ name });
//     }, [name, createUser]);
//     return (
//       <form onSubmit={handleSubmit}>
//         <input value={name} onChange={(e) => setName(e.target.value)} />
//         {error && <Toast>{error}</Toast>}
//         <button type="submit">Create</button>
//         {!isLoading && users?.map((u) => <li key={u.id}>{u.name}</li>)}
//       </form>
//     );
//   }
//
// Reviewer-rejected ex12 from the simple-form file becomes idiomatic.

describe("D9: full-feature component — idiomatic React shape end-to-end", () => {
  it("query destructure + state destructure + mutation member access", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: [
          "React",
          "useState",
          "useCallback",
          "useQuery",
          "useMutation",
          "UserManager",
        ],
        entities: [
          { key: "import:fetchUsers", candidates: { 100: "fetchUsers" } },
          { key: "import:createUserApi", candidates: { 100: "createUserApi" } },
          { key: "import:Toast", candidates: { 100: "Toast" } },
        ],
        children: [
          {
            id: "component:UserManager",
            reservations: ["props"],
            entities: [
              {
                key: "query:users",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "query:users:data", candidates: { 100: "users" } },
                      { subKey: "query:users:loading", candidates: { 100: "isLoading" } },
                    ],
                    facets: {
                      data: { kind: "binding", ref: "query:users:data", access: "" },
                      isLoading: { kind: "binding", ref: "query:users:loading", access: "" },
                    },
                  },
                ],
              },
              {
                key: "mutation:createUser",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "mutation:createUser:result", candidates: { 100: "createUser" } },
                    ],
                    facets: {
                      mutate: { kind: "binding", ref: "mutation:createUser:result", access: ".mutate" },
                    },
                  },
                ],
              },
              {
                key: "state:name",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:name:read", candidates: { 100: "name" } },
                      { subKey: "state:name:setter", candidates: { 100: "setName" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:name:read", access: "" },
                      setter: { kind: "binding", ref: "state:name:setter", access: "" },
                    },
                  },
                ],
              },
              {
                key: "state:error",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "state:error:read", candidates: { 100: "error" } },
                      { subKey: "state:error:setter", candidates: { 100: "setError" } },
                    ],
                    facets: {
                      read: { kind: "binding", ref: "state:error:read", access: "" },
                      setter: { kind: "binding", ref: "state:error:setter", access: "" },
                    },
                  },
                ],
              },
              {
                key: "handler:submit",
                candidates: { 100: "handleSubmit" }, // simple — single name, single facet
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    // Module imports — simple form
    expect(result.assignments.get("import:fetchUsers")).toBe("fetchUsers");
    expect(result.assignments.get("import:createUserApi")).toBe("createUserApi");
    expect(result.assignments.get("import:Toast")).toBe("Toast");
    // Component scope — rich entities
    expect(result.resolutions.get("query:users")?.facetExpressions.get("data")).toBe("users");
    expect(result.resolutions.get("query:users")?.facetExpressions.get("isLoading")).toBe("isLoading");
    expect(result.resolutions.get("mutation:createUser")?.facetExpressions.get("mutate")).toBe(
      "createUser.mutate",
    );
    expect(result.resolutions.get("state:name")?.facetExpressions.get("read")).toBe("name");
    expect(result.resolutions.get("state:name")?.facetExpressions.get("setter")).toBe("setName");
    expect(result.resolutions.get("state:error")?.facetExpressions.get("read")).toBe("error");
    expect(result.resolutions.get("state:error")?.facetExpressions.get("setter")).toBe("setError");
    // Handler — simple form
    expect(result.assignments.get("handler:submit")).toBe("handleSubmit");
  });
});

// ─── Example D10 ───────────────────────────────────────────────────────
//
//   // Two states whose preferred T100 destructure names CONFLICT with each
//   // other: both want `value` and `setValue` because both states are model-
//   // named "value". Symmetric tie → both fall to T80 within the destructure
//   // shape OR to non-destructure shape.
//
//   // Wait — same-named states in the same component aren't allowed by the
//   // model (state names are unique within a component). So this case is
//   // actually impossible. Demonstrating the resolver doesn't have to handle
//   // it; if it did, symmetric tie-break + per-binding fallback would do
//   // the right thing.

// (no fixture — same-named states in one component are model-prevented)

// ─── Example D11 ───────────────────────────────────────────────────────
//
//   // Custom hook that returns an object — modern (2025) idiom. Object-
//   // returning hooks beat tuple-returning ones because they're extensible
//   // (add fields without breaking call sites) and self-documenting.
//   //
//   import { useCounter } from "./hooks";
//   export function Foo(props) {
//     const { count, increment, reset } = useCounter();
//     return (
//       <div>
//         <button onClick={increment}>{count}</button>
//         <button onClick={reset}>Reset</button>
//       </div>
//     );
//   }
//
// Three facets (value/action/reset), each its own destructured binding.
// Same shape as D7's query destructure — object-rename pattern, not tuple.

describe("D11: custom hook with OBJECT destructure (modern idiom)", () => {
  it("object-destructure shape allocates one binding per facet", () => {
    const result = resolveLexicalNames(
      {
        id: "module",
        reservations: ["React", "Foo"],
        entities: [{ key: "import:useCounter", candidates: { 100: "useCounter" } }],
        children: [
          {
            id: "component:Foo",
            reservations: ["props"],
            entities: [
              {
                key: "hook:counter",
                shapes: [
                  {
                    priority: 100,
                    bindings: [
                      { subKey: "hook:counter:value", candidates: { 100: "count", 80: "counterValue" } },
                      {
                        subKey: "hook:counter:increment",
                        candidates: { 100: "increment", 80: "counterIncrement" },
                      },
                      {
                        subKey: "hook:counter:reset",
                        candidates: { 100: "reset", 80: "counterReset" },
                      },
                    ],
                    facets: {
                      value: { kind: "binding", ref: "hook:counter:value", access: "" },
                      increment: { kind: "binding", ref: "hook:counter:increment", access: "" },
                      reset: { kind: "binding", ref: "hook:counter:reset", access: "" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    const r = result.resolutions.get("hook:counter");
    expect(r?.facetExpressions.get("value")).toBe("count");
    expect(r?.facetExpressions.get("increment")).toBe("increment");
    expect(r?.facetExpressions.get("reset")).toBe("reset");
  });
});
