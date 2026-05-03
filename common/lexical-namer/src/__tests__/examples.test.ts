/**
 * Component examples — concrete sample components in increasing complexity,
 * each shown as ABSTRACT input (scope tree + entities) plus EXPECTED EMIT
 * SHAPE (in the docstring) plus expected resolver assignments.
 *
 * Convention: NO destruction assignments. Every binding is a direct var
 * declaration. Property accesses use member-expression syntax in the emit
 * (e.g., `stateOpen[0]` instead of `const [open] = useState(...)`).
 *
 * Purpose: walk these from simplest to most complex; identify what schema
 * the resolver actually needs in order for an emitter to produce these
 * outputs. The candidate ladders here are illustrative — a real strategy
 * would derive them from model context.
 */

import { describe, expect, it } from "vitest";

import { resolveLexicalNames, type ResolveOptions, type ScopeSpec } from "../index.js";

const stringPostfix: ResolveOptions<string>["postfixFor"] = (k) => k;

function resolve(root: ScopeSpec<string>, options?: Partial<ResolveOptions<string>>): ReadonlyMap<string, string> {
  return resolveLexicalNames(root, { postfixFor: stringPostfix, ...options }).assignments;
}

// ─── Example 1 ─────────────────────────────────────────────────────────
//
//   import * as React from "react";
//   export function Foo(props) {
//     return <div className={styles.root}>Hello</div>;
//   }
//
// No state, no handlers, no queries. Module scope reserves React + the
// function name; component scope reserves props + styles. Zero entities.

describe("ex1: trivial component", () => {
  it("empty entity set → empty assignments", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props", "styles"],
        },
      ],
    });
    expect(r.size).toBe(0);
  });
});

// ─── Example 2 ─────────────────────────────────────────────────────────
//
//   import * as React from "react";
//   import { useState } from "react";
//   export function Foo(props) {
//     const stateOpen = useState(false);
//     return (
//       <button onClick={() => stateOpen[1](!stateOpen[0])}>
//         {stateOpen[0] ? "Open" : "Closed"}
//       </button>
//     );
//   }
//
// One state. With no destructure, the tuple name is the only fresh
// binding the resolver allocates. The emitter derives `stateOpen[0]` and
// `stateOpen[1]` from the tuple name + useState's contract.

describe("ex2: one state, no destructure", () => {
  it("allocates the state tuple name only", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props", "styles"],
          entities: [
            {
              key: "stateTuple:open",
              candidates: {
                100: "stateOpen", // preferred: state-prefixed tuple
                80: "stateOpenResult",
                60: "openTuple",
              },
            },
          ],
        },
      ],
    });
    expect(r.get("stateTuple:open")).toBe("stateOpen");
    // Emitter derives stateOpen[0]/stateOpen[1] from this name; resolver
    // doesn't model the read or setter as separate entities.
    expect(r.size).toBe(1);
  });
});

// ─── Example 3 ─────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const stateOpen = useState(false);
//     const stateValue = useState("");
//     return (
//       <div>
//         <input value={stateValue[0]} onChange={(e) => stateValue[1](e.target.value)} />
//         <button onClick={() => stateOpen[1](!stateOpen[0])}>{stateOpen[0]}</button>
//       </div>
//     );
//   }

describe("ex3: two states", () => {
  it("each tuple allocates independently at T100", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props", "styles"],
          entities: [
            { key: "stateTuple:open", candidates: { 100: "stateOpen", 80: "stateOpenResult" } },
            { key: "stateTuple:value", candidates: { 100: "stateValue", 80: "stateValueResult" } },
          ],
        },
      ],
    });
    expect(r.get("stateTuple:open")).toBe("stateOpen");
    expect(r.get("stateTuple:value")).toBe("stateValue");
  });
});

// ─── Example 4 ─────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const stateOpen = useState(false);
//     const handleToggle = useCallback(() => stateOpen[1](!stateOpen[0]), []);
//     return <button onClick={handleToggle}>{stateOpen[0] ? "Open" : "Closed"}</button>;
//   }

describe("ex4: state + handler", () => {
  it("handler lives at component scope alongside the state tuple", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "useCallback", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props", "styles"],
          entities: [
            { key: "stateTuple:open", candidates: { 100: "stateOpen" } },
            { key: "handler:toggle", candidates: { 100: "handleToggle", 80: "onClick" } },
          ],
        },
      ],
    });
    expect(r.get("stateTuple:open")).toBe("stateOpen");
    expect(r.get("handler:toggle")).toBe("handleToggle");
  });
});

// ─── Example 5 ─────────────────────────────────────────────────────────
//
//   // Foo.tsx
//   import * as React from "react";
//   import { useState } from "react";
//   export function Foo(props) {
//     const stateOpen = useState(false);
//     return ...;
//   }
//   export function Bar(props) {
//     const stateOpen = useState(false);  // SAME NAME — different component
//     return ...;
//   }
//
// Both components allocate the same `stateOpen` name. Sibling-independent
// at component scope.

describe("ex5: two components in one file reuse names", () => {
  it("each component scope allocates stateOpen independently", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "Foo", "Bar"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [{ key: "stateTuple:Foo.open", candidates: { 100: "stateOpen" } }],
        },
        {
          id: "component:Bar",
          reservations: ["props"],
          entities: [{ key: "stateTuple:Bar.open", candidates: { 100: "stateOpen" } }],
        },
      ],
    });
    expect(r.get("stateTuple:Foo.open")).toBe("stateOpen");
    expect(r.get("stateTuple:Bar.open")).toBe("stateOpen");
  });
});

// ─── Example 6 ─────────────────────────────────────────────────────────
//
//   // Foo.tsx imports another `Foo` from elsewhere — name collides with self.
//   import { Foo as FooComponent } from "./other.js";
//   export function Foo(props) {
//     return <FooComponent />;
//   }
//
// Module-scope: function name `Foo` is reserved (it's the export). The
// import entity falls down its ladder to `FooComponent`.

describe("ex6: imported component aliased to avoid self-name collision", () => {
  it("import drops to T80 when T100 'Foo' is reserved by the function name", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "Foo"], // function name reserved
      entities: [
        {
          key: "import:Foo",
          candidates: { 100: "Foo", 80: "FooComponent", 60: "FooImported" },
        },
      ],
      children: [
        { id: "component:Foo", reservations: ["props"] },
      ],
    });
    expect(r.get("import:Foo")).toBe("FooComponent");
  });
});

// ─── Example 7 ─────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const handleScroll = useCallback((e) => {
//       window.scrollTo(0, 0);
//     }, []);
//     return <button onClick={handleScroll}>Top</button>;
//   }
//
// User code inside the handler references `window` (a global). The
// handler scope's reservations include `window` (added by the AST scanner).
// No entity in this example tries to claim `window` — but if one did,
// the parent-chain reservation would correctly block it.

describe("ex7: handler scope inherits user-referenced free vars as reservations", () => {
  it("free var (window) reserved at handler scope; visible to descendants", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useCallback", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [{ key: "handler:scroll", candidates: { 100: "handleScroll" } }],
          children: [
            {
              id: "handler:scroll:body",
              reservations: ["window"], // scanned out of user CustomCode
              // Hypothetical inner-scope entity that wanted "window" would
              // fall to its next tier here — verified by the contract suite.
              entities: [
                {
                  key: "innerLocal",
                  candidates: { 100: "window", 80: "windowLocal" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(r.get("handler:scroll")).toBe("handleScroll");
    expect(r.get("innerLocal")).toBe("windowLocal");
  });
});

// ─── Example 8 ─────────────────────────────────────────────────────────
//
//   import { stateOpen } from "./shared-helpers";
//   export function Foo(props) {
//     const stateOpenResult = useState(false);  // stateOpen is taken
//     return <button onClick={() => stateOpenResult[1](!stateOpenResult[0])}>...</button>;
//   }
//
// Pathological: the user imports something at module scope that shadows
// our preferred T100 tuple name. Module-scope reservation propagates
// down to component scope; tuple falls to T80.

describe("ex8: module-scope import shadows tuple's preferred name", () => {
  it("state tuple drops to T80 when module-scope reserves T100 candidate", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "Foo", "stateOpen"], // imported helper
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            {
              key: "stateTuple:open",
              candidates: { 100: "stateOpen", 80: "stateOpenResult", 60: "openLocal" },
            },
          ],
        },
      ],
    });
    expect(r.get("stateTuple:open")).toBe("stateOpenResult");
  });
});

// ─── Example 9 ─────────────────────────────────────────────────────────
//
//   export function UserList(props) {
//     const queryUsers = useQuery({ queryKey: ["users"], queryFn });
//     const stateSelected = useState(null);
//     const handleSelect = useCallback((id) => stateSelected[1](id), []);
//     return (
//       <ul>
//         {queryUsers.data?.map((u) => (
//           <li key={u.id} onClick={() => handleSelect(u.id)}>{u.name}</li>
//         ))}
//       </ul>
//     );
//   }
//
// Three component-scope entities: query, state tuple, handler. The query
// produces a single binding — emitter accesses `.data`/`.status`/`.error`
// via member access. No destructure.
// The `.map` callback param `u` is at handler-scope (inside the JSX expr),
// but for v0 we treat `.map` callbacks in the JSX return itself as
// handler-scope-equivalent (or skip modeling them since they don't compete
// with anything we allocate). See ex10 for the explicit case.

describe("ex9: query + state + handler combined", () => {
  it("all three component-scope entities allocate at T100", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "useCallback", "useQuery", "UserList"],
      children: [
        {
          id: "component:UserList",
          reservations: ["props"],
          entities: [
            { key: "query:users", candidates: { 100: "queryUsers", 80: "queryUsersResult" } },
            { key: "stateTuple:selected", candidates: { 100: "stateSelected" } },
            { key: "handler:select", candidates: { 100: "handleSelect" } },
          ],
        },
      ],
    });
    expect(r.get("query:users")).toBe("queryUsers");
    expect(r.get("stateTuple:selected")).toBe("stateSelected");
    expect(r.get("handler:select")).toBe("handleSelect");
  });
});

// ─── Example 10 ────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const handleListA = useCallback(() => {
//       props.itemsA.map((item) => doSomething(item));
//     }, []);
//     const handleListB = useCallback(() => {
//       props.itemsB.map((item) => doOtherThing(item));
//     }, []);
//     return ...;
//   }
//
// Two handlers. Each handler's body has a `.map` callback whose user-given
// param is `item`. Each map-callback is its own grandchild scope; the two
// scopes are siblings of each other (children of different handlers).
// `item` allocates independently in each — sibling independence in action.

describe("ex10: two .map callbacks in different handlers — independent scopes", () => {
  it("each handler's inner .map scope independently claims 'item'", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useCallback", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            { key: "handler:listA", candidates: { 100: "handleListA" } },
            { key: "handler:listB", candidates: { 100: "handleListB" } },
          ],
          children: [
            {
              id: "handler:listA:body",
              children: [
                {
                  id: "handler:listA:body:map",
                  entities: [{ key: "param:listA.item", candidates: { 100: "item" } }],
                },
              ],
            },
            {
              id: "handler:listB:body",
              children: [
                {
                  id: "handler:listB:body:map",
                  entities: [{ key: "param:listB.item", candidates: { 100: "item" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(r.get("handler:listA")).toBe("handleListA");
    expect(r.get("handler:listB")).toBe("handleListB");
    expect(r.get("param:listA.item")).toBe("item");
    expect(r.get("param:listB.item")).toBe("item");
  });
});

// ─── Example 11 ────────────────────────────────────────────────────────
//
//   export function Foo(props) {
//     const stateUsers = useState([]);
//     const handleClick = useCallback(() => {
//       const result = doSomething();           // user-declared in handler body
//       stateUsers[1]([...stateUsers[0], result]);
//     }, []);
//     return <button onClick={handleClick}>Add</button>;
//   }
//
// User code inside the handler declares `result`. Handler scope records
// `result` as a user declaration; if some inner scope tries to allocate
// `result`, it'd conflict (we treat user declarations as reservations
// at the scope where they're declared). For this example, the handler
// body has user-declared `result`; we model that as a reservation.

describe("ex11: handler body has user-declared local that shadows nothing", () => {
  it("user-declared local in handler scope reserved; handler entity unaffected", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "useState", "useCallback", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            { key: "stateTuple:users", candidates: { 100: "stateUsers" } },
            { key: "handler:click", candidates: { 100: "handleClick" } },
          ],
          children: [
            {
              id: "handler:click:body",
              // user-declared `const result = ...` recorded as scope reservation
              reservations: ["result"],
            },
          ],
        },
      ],
    });
    expect(r.get("stateTuple:users")).toBe("stateUsers");
    expect(r.get("handler:click")).toBe("handleClick");
  });
});

// ─── Example W1 — window globals: direct-or-prefixed via path candidates ─
//
// Two configurations of the same logical reference. Strategy emits both
// shapes as priority-keyed candidates; resolver picks the higher-priority
// one whose viaName is in scope.
//
// Implicit-globals target (root scope reserves all browser globals):
//   const link = navigator.userAgent;
//
// Explicit-globals target (root scope reserves only `window`/`globalThis`):
//   const link = window.navigator.userAgent;

describe("ex-W1: window global with implicit-globals target", () => {
  it("direct reference picked when bare global is reserved", () => {
    const r = resolve({
      id: "module",
      // implicit-globals: browser globals reserved at module scope
      reservations: ["React", "window", "navigator", "location", "document", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            {
              key: "ref:navigator",
              candidates: {
                100: { viaName: "navigator", access: "" },
                80: { viaName: "window", access: ".navigator" },
              },
            },
          ],
        },
      ],
    });
    expect(r.get("ref:navigator")).toBe("navigator");
  });
});

describe("ex-W2: window global with explicit-globals target", () => {
  it("falls to window-prefixed when bare global is NOT reserved", () => {
    const r = resolve({
      id: "module",
      // explicit-globals: only `window`/`globalThis` reserved; `navigator` not
      reservations: ["React", "window", "globalThis", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            {
              key: "ref:navigator",
              candidates: {
                100: { viaName: "navigator", access: "" },
                80: { viaName: "window", access: ".navigator" },
              },
            },
          ],
        },
      ],
    });
    expect(r.get("ref:navigator")).toBe("window.navigator");
  });
});

describe("ex-W3: same component referencing both location and navigator", () => {
  it("each ref independently picks direct or prefixed based on reservations", () => {
    const r = resolve({
      id: "module",
      // Hybrid: navigator reserved, location not
      reservations: ["React", "window", "navigator", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            {
              key: "ref:navigator",
              candidates: {
                100: { viaName: "navigator", access: "" },
                80: { viaName: "window", access: ".navigator" },
              },
            },
            {
              key: "ref:location",
              candidates: {
                100: { viaName: "location", access: "" },
                80: { viaName: "window", access: ".location" },
              },
            },
          ],
        },
      ],
    });
    expect(r.get("ref:navigator")).toBe("navigator");
    expect(r.get("ref:location")).toBe("window.location");
  });
});

describe("ex-W4: nested member access — window.location.href", () => {
  it("ViaPath access supports multi-segment chains", () => {
    const r = resolve({
      id: "module",
      reservations: ["React", "window", "Foo"],
      children: [
        {
          id: "component:Foo",
          reservations: ["props"],
          entities: [
            {
              key: "ref:locationHref",
              candidates: {
                100: { viaName: "location", access: ".href" },
                80: { viaName: "window", access: ".location.href" },
              },
            },
          ],
        },
      ],
    });
    expect(r.get("ref:locationHref")).toBe("window.location.href");
  });
});

// ─── Example 12 ────────────────────────────────────────────────────────
//
//   // The most complex shape we currently emit, end-to-end:
//   //
//   import * as React from "react";
//   import { useState, useCallback } from "react";
//   import { useQuery, useMutation } from "@tanstack/react-query";
//   import { fetchUsers, createUser } from "./api";
//   import { Toast } from "./components";
//   //
//   export function UserManager(props) {
//     const queryUsers = useQuery({ queryKey: ["users"], queryFn: fetchUsers });
//     const mutationCreate = useMutation({ mutationFn: createUser });
//     const stateName = useState("");
//     const stateError = useState(null);
//     const handleSubmit = useCallback(() => {
//       if (!stateName[0]) {
//         stateError[1]("Name required");
//         return;
//       }
//       mutationCreate.mutate(stateName[0]);
//     }, []);
//     return (
//       <form onSubmit={handleSubmit}>
//         <input value={stateName[0]} onChange={(e) => stateName[1](e.target.value)} />
//         {stateError[0] && <Toast>{stateError[0]}</Toast>}
//         <button type="submit">Create</button>
//         {queryUsers.data?.map((u) => <li key={u.id}>{u.name}</li>)}
//       </form>
//     );
//   }
//
// Module-scope imports: React, useState, useCallback, useQuery, useMutation,
//   fetchUsers, createUser, Toast, UserManager.
// Component scope: queryUsers, mutationCreate, stateName, stateError,
//   handleSubmit.

describe("ex12: full-feature component (no destructure throughout)", () => {
  it("allocates all module + component scope entities", () => {
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
          { key: "import:createUser", candidates: { 100: "createUser" } },
          { key: "import:Toast", candidates: { 100: "Toast" } },
        ],
        children: [
          {
            id: "component:UserManager",
            reservations: ["props"],
            entities: [
              { key: "query:users", candidates: { 100: "queryUsers" } },
              { key: "mutation:create", candidates: { 100: "mutationCreate" } },
              { key: "stateTuple:name", candidates: { 100: "stateName" } },
              { key: "stateTuple:error", candidates: { 100: "stateError" } },
              { key: "handler:submit", candidates: { 100: "handleSubmit" } },
            ],
          },
        ],
      },
      { postfixFor: stringPostfix },
    );
    expect(result.assignments.get("import:fetchUsers")).toBe("fetchUsers");
    expect(result.assignments.get("import:createUser")).toBe("createUser");
    expect(result.assignments.get("import:Toast")).toBe("Toast");
    expect(result.assignments.get("query:users")).toBe("queryUsers");
    expect(result.assignments.get("mutation:create")).toBe("mutationCreate");
    expect(result.assignments.get("stateTuple:name")).toBe("stateName");
    expect(result.assignments.get("stateTuple:error")).toBe("stateError");
    expect(result.assignments.get("handler:submit")).toBe("handleSubmit");
    expect(result.assignments.size).toBe(8);
  });
});
