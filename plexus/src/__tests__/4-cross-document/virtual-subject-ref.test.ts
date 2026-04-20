/**
 * Regression test — VariantGroup-like entity whose `@syncing` ref field
 * targets a virtual-genesis child in the same doc.
 *
 * Pre-fix symptom (2026-04-20): groups whose `subject` ref points into a
 * `@syncing.virtual` map were dropped on cross-doc hydration. Root cause
 * was in `virtual-children-genesis.ts:329` — the genesis epilogue write
 * `yjsMap.set(mapKey, [rootUuid])` used origin `GENESIS_ORIGIN`, which the
 * shadow→main forwarder filtered out as "unknown symbol origin". The
 * resulting clock advance on shadow (but not main) created a pending-struct
 * gap on main for every subsequent write, so `Y.applyUpdate` silently
 * parked the Group insertion structs in `pendingStructs` and the Group
 * never made it into main's state. Fix: add `GENESIS_ORIGIN` to the
 * shadow→main forwarder allow-list.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import type { VirtualMap } from "../../proxy-runtime-types.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";

@syncing("VSREnv")
class Env extends PlexusModel {
  @syncing accessor feature!: string;
}

@syncing("VSRState")
class State extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("VSRGroup")
class Group extends PlexusModel {
  @syncing accessor name!: string;
  /** Polymorphic ref — either a virtual-genesis Env or a child-attached State. */
  @syncing accessor subject!: Env | State;
}

@syncing("VSRRoot")
class Root extends PlexusModel {
  @syncing.virtual((key: string) => new Env({ feature: key }))
  accessor envs!: VirtualMap<string, Env>;

  @syncing.child.list accessor states: State[] = [];
  @syncing.child.list accessor groups: Group[] = [];
}

function roundTrip(doc: Y.Doc): Y.Doc {
  const update = Y.encodeStateAsUpdate(doc);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, update);
  return fresh;
}

describe("virtual-subject ref across doc hydration", () => {
  it("control: Group with State (child-attached) subject round-trips", () => {
    const { doc, root } = initTestPlexus(new Root({}));

    const mode = new State({ name: "mode" });
    root.states.push(mode);
    root.groups.push(new Group({ name: "mode", subject: mode }));

    expect(root.groups.length).toBe(1);

    const hydrated = roundTrip(doc);
    const { root: hRoot } = connectTestPlexus<Root>(hydrated);

    expect(hRoot.groups.length).toBe(1);
    expect(hRoot.groups[0].name).toBe("mode");
    expect(hRoot.groups[0].subject).toBeInstanceOf(State);
    expect((hRoot.groups[0].subject as State).name).toBe("mode");
  });

  it("Group with virtual-genesis Env subject round-trips", () => {
    const { doc, root } = initTestPlexus(new Root({}));

    const widthEnv = root.envs.get("width");
    root.groups.push(new Group({ name: "width", subject: widthEnv }));

    expect(root.groups.length).toBe(1);
    expect(root.groups[0].subject).toBe(widthEnv);

    const hydrated = roundTrip(doc);
    const { root: hRoot } = connectTestPlexus<Root>(hydrated);

    expect(hRoot.groups.length).toBe(1);
    expect(hRoot.groups[0].name).toBe("width");
    expect(hRoot.groups[0].subject).toBeInstanceOf(Env);
    expect((hRoot.groups[0].subject as Env).feature).toBe("width");
  });

  it("virtual-genesis Env alone (no ref) round-trips", () => {
    const { doc, root } = initTestPlexus(new Root({}));

    root.envs.get("width");

    const hydrated = roundTrip(doc);
    const { root: hRoot } = connectTestPlexus<Root>(hydrated);

    // Re-reading the key should observe the materialised entry, not re-genesis.
    const env = hRoot.envs.get("width");
    expect(env).toBeInstanceOf(Env);
    expect(env.feature).toBe("width");
  });
});
