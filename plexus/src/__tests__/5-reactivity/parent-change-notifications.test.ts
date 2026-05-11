import { reaction } from "mobx";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { syncing } from "../../decorators.js";
import { enableMobXIntegration } from "../../mobx/index.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

beforeAll(() => {
  enableMobXIntegration();
});

@syncing("ChildEntity")
class ChildEntity extends PlexusModel {
  @syncing accessor name!: string;
}

@syncing("ContainerEntity")
class ContainerEntity extends PlexusModel {
  @syncing accessor name!: string;
  @syncing.child accessor child!: ChildEntity | null;
  @syncing.child.list accessor children!: ChildEntity[];
}

/**
 * `entity.parent` should be observable through the standard tracking
 * mechanism — adopting, reparenting, and emancipating an entity must each
 * notify reactions that observed `parent`.
 *
 * Background: `@syncing` field initializers run inside `__untracked__`
 * (decorators.ts). That's correct for default expressions like
 * `@syncing.child accessor x = new X()` — the init shouldn't trigger noise.
 * But when an externally-constructed entity is passed as a constructor prop,
 * an external observer may already be tracking the child's `parent`. The
 * "adoption via constructor prop notifies parent watchers" case below
 * documents the bug discovered via @host/model — a child entity
 * constructed standalone, with an autorun watching its `parent`, then
 * wrapped in a parent constructor, never sees the parent change because
 * the adoption ran inside the parent's __untracked__ field-init.
 */
describe("Parent change notifications", () => {
  it("adoption via runtime push notifies parent watchers", () => {
    const child = new ChildEntity({ name: "c" });
    const parent = new ContainerEntity({ name: "p", child: null, children: [] });
    initTestPlexus<ContainerEntity>(parent);

    const notify = vi.fn();
    const dispose = reaction(() => child.parent, notify);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    parent.children.push(child);

    expect(child.parent).to.equal(parent);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose();
  });

  it("emancipation via splice notifies parent watchers", () => {
    const child = new ChildEntity({ name: "c" });
    const parent = new ContainerEntity({ name: "p", child: null, children: [child] });
    initTestPlexus<ContainerEntity>(parent);

    const notify = vi.fn();
    const dispose = reaction(() => child.parent, notify);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    parent.children.splice(0, 1);

    expect(child.parent).to.equal(null);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose();
  });

  it("reparenting (push to a different parent's list) notifies parent watchers", () => {
    const child = new ChildEntity({ name: "c" });
    const parent1 = new ContainerEntity({ name: "p1", child: null, children: [] });
    initTestPlexus<ContainerEntity>(parent1);

    parent1.children.push(child); // initial adoption — notified path
    expect(child.parent).to.equal(parent1);

    const notify = vi.fn();
    const dispose = reaction(() => child.parent, notify);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Re-parent within the same parent (move to .child slot via runtime assignment).
    parent1.child = child;
    expect(child.parent).to.equal(parent1); // same parent, different field
    // parent didn't change identity, only parentKey did. The reaction watches
    // `.parent`, which equals parent1 both before and after. So it should NOT
    // fire for a same-parent reslot.
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);
    dispose();
  });

  /**
   * The failing regression. Adopting via constructor prop currently runs
   * inside __untracked__ and does NOT notify external watchers.
   *
   * Fix sketch: in `decorators.ts`, the field-init's __untracked__ wrapper
   * should wrap only the *default-value* path (when
   * `initializationState[name] === undefined`), not the path where the prop
   * was explicitly provided. Explicit props came from outside the
   * constructor and the adoption is semantically a real change.
   */
  it("adoption via constructor prop notifies parent watchers", async () => {
    const child = new ChildEntity({ name: "c" });

    const notify = vi.fn();
    const dispose = reaction(() => child.parent, notify);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    // Adoption happens inside ContainerEntity's @syncing.child init for `child`.
    const parent = new ContainerEntity({ name: "p", child, children: [] });

    expect(child.parent).to.equal(parent);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose();
  });

  it("adoption via constructor prop into child-list notifies parent watchers", () => {
    const child = new ChildEntity({ name: "c" });

    const notify = vi.fn();
    const dispose = reaction(() => child.parent, notify);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(0);

    const parent = new ContainerEntity({ name: "p", child: null, children: [child] });

    expect(child.parent).to.equal(parent);
    expect(notify).to.have.property("mock").with.property("calls").with.lengthOf(1);
    dispose();
  });
});
