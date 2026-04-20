import { describe, expect, it } from "vitest";

// eslint-disable-next-line import-x/no-useless-path-segments
import { PlexusModel, syncing } from "../index.js";
import { buildVisitor, walk } from "../walk.js";

// Test models
@syncing("Leaf")
class Leaf extends PlexusModel {
  @syncing accessor value: string = "";
}

@syncing("Branch")
class Branch extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing.child accessor leaf: Leaf | null = null;
  @syncing.child.list accessor leaves: Leaf[] = [];
}

@syncing("Tree")
class Tree extends PlexusModel {
  @syncing.child.list accessor branches: Branch[] = [];
  @syncing.child accessor mainBranch!: Branch | null;
}

describe("walk", () => {
  it("visits all nodes in tree", () => {
    const tree = new Tree();
    const branch1 = new Branch({ name: "b1" });
    const branch2 = new Branch({ name: "b2" });
    const leaf1 = new Leaf({ value: "l1" });
    const leaf2 = new Leaf({ value: "l2" });

    tree.branches = [branch1, branch2];
    branch1.leaf = leaf1;
    branch2.leaves = [leaf2];

    const visited: string[] = [];

    walk<{
      Tree: Tree;
      Branch: Branch;
      Leaf: Leaf;
    }>(
      tree,
      {},
      {
        Tree(node, { next }) {
          visited.push("Tree");
          next();
        },
        Branch(node, { next }) {
          visited.push(`Branch:${node.name}`);
          next();
        },
        Leaf(node) {
          visited.push(`Leaf:${node.value}`);
        },
      },
    );

    expect(visited).to.deep.equal(["Tree", "Branch:b1", "Leaf:l1", "Branch:b2", "Leaf:l2"]);
  });

  it("inherits state through next()", () => {
    const tree = new Tree();
    const branch = new Branch({ name: "b" });
    const leaf = new Leaf({ value: "l" });

    tree.mainBranch = branch;
    branch.leaf = leaf;

    const depths: number[] = [];

    walk<{ Tree: Tree; Branch: Branch; Leaf: Leaf }, { depth: number }>(
      tree,
      { depth: 0 },
      {
        Tree(node, { state, next }) {
          depths.push(state.depth);
          next({ depth: state.depth + 1 });
        },
        Branch(node, { state, next }) {
          depths.push(state.depth);
          next({ depth: state.depth + 1 });
        },
        Leaf(node, { state }) {
          depths.push(state.depth);
        },
      },
    );

    expect(depths).to.deep.equal([0, 1, 2]);
  });

  it("stop() halts traversal", () => {
    const tree = new Tree();
    tree.branches = [new Branch({ name: "b1" }), new Branch({ name: "b2" }), new Branch({ name: "b3" })];

    const visited: string[] = [];

    walk<{
      Tree: Tree;
      Branch: Branch;
      Leaf: Leaf;
    }>(
      tree,
      {},
      {
        Branch(node, { stop }) {
          visited.push(node.name);
          if (node.name === "b2") stop();
        },
      },
    );

    expect(visited).to.deep.equal(["b1", "b2"]);
  });

  it("skips children if next() not called", () => {
    const tree = new Tree();
    const branch = new Branch({ name: "b" });
    const leaf = new Leaf({ value: "l" });

    tree.mainBranch = branch;
    branch.leaf = leaf;

    const visited: string[] = [];

    walk<{
      Tree: Tree;
      Branch: Branch;
      Leaf: Leaf;
    }>(
      tree,
      {},
      {
        Tree(node) {
          visited.push("Tree");
          // NOT calling next() - should skip children
        },
        Branch(node, { next }) {
          visited.push("Branch");
          next();
        },
        Leaf(node) {
          visited.push("Leaf");
        },
      },
    );

    expect(visited).to.deep.equal(["Tree"]);
  });
});

describe("buildVisitor", () => {
  it("produces values from tree", () => {
    const tree = new Tree();
    const branch1 = new Branch({ name: "b1" });
    const branch2 = new Branch({ name: "b2" });
    const leaf1 = new Leaf({ value: "l1" });

    tree.branches = [branch1, branch2];
    branch1.leaf = leaf1;

    const visit = buildVisitor<{
      Tree: Tree;
      Branch: Branch;
      Leaf: Leaf;
    }>()({
      Tree(node) {
        const branches = node.branches.map((b) => visit(b)).join(", ");
        return `Tree(${branches})`;
      },
      Branch(node) {
        const leaf = node.leaf ? visit(node.leaf) : "null";
        return `Branch:${node.name}(${leaf})`;
      },
      Leaf(node) {
        return `Leaf:${node.value}`;
      },
    });

    const result = visit(tree);
    expect(result).to.equal("Tree(Branch:b1(Leaf:l1), Branch:b2(null))");
  });

  it("works for codegen-style string building", () => {
    const tree = new Tree();
    const branch = new Branch({ name: "main" });
    const leaf1 = new Leaf({ value: "hello" });
    const leaf2 = new Leaf({ value: "world" });

    tree.mainBranch = branch;
    branch.leaves = [leaf1, leaf2];

    const visit = buildVisitor<{
      Tree: Tree;
      Branch: Branch;
      Leaf: Leaf;
    }>()({
      Tree(node): string {
        const main = node.mainBranch ? visit(node.mainBranch) : "";
        return `<Tree>\n${main}\n</Tree>`;
      },
      Branch(node): string {
        const leaves = node.leaves.map((l) => `  ${visit(l)}`).join("\n");
        return `<Branch name="${node.name}">\n${leaves}\n</Branch>`;
      },
      Leaf(node): string {
        return `<Leaf value="${node.value}" />`;
      },
    });

    const code = visit(tree);

    expect(code).to.equal(`<Tree>
<Branch name="main">
  <Leaf value="hello" />
  <Leaf value="world" />
</Branch>
</Tree>`);
  });
});
