import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { initTestPlexus } from "../_helpers/test-plexus.js";

// Simple test entities
@syncing("User")
class User extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor email!: string;

  @syncing
  accessor age!: number;
}

@syncing("Post")
class Post extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing
  accessor content!: string;

  @syncing
  accessor author!: User | null;

  @syncing.list
  accessor tags!: string[];
}

describe("Plexus Basic Functionality", () => {
  it("should create and manage Plexus document with simple entities", () => {
    const user = new User({
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    });

    const post = new Post({
      title: "Test Post",
      content: "Test content",
      author: user,
      tags: ["test", "plexus"],
    });

    // Initialize Plexus with post as root
    const { plexus, root, doc } = initTestPlexus<Post>(post);

    // Verify Plexus is properly initialized
    expect(plexus).to.not.eq(undefined);
    expect(doc).to.be.instanceOf(Y.Doc);

    // Verify entity data is properly loaded
    expect([
      root.title,
      root.content,
      root.author,
      root.author!.name,
      root.tags.length,
      root.tags[0],
    ]).to.have.ordered.members(["Test Post", "Test content", root.author, "John Doe", 2, "test"]);
    expect(root.author).to.not.eq(null);

    // Verify mutations work
    root.title = "Updated Title";
    root.tags.push("updated");

    expect([root.title, root.tags.length, root.tags[2]]).to.have.ordered.members(["Updated Title", 3, "updated"]);
  });

  it("should have root available immediately after construction", () => {
    const user = new User({
      name: "Jane Doe",
      email: "jane@example.com",
      age: 25,
    });

    const { plexus, root } = initTestPlexus<User>(user);

    // Root is immediately available (no async)
    expect(plexus.root).to.equal(root);
    expect([plexus.root.name, plexus.root.age]).to.have.ordered.members(["Jane Doe", 25]);
  });

  it("should maintain document-plexus relationship", () => {
    const user = new User({
      name: "Bob Smith",
      email: "bob@example.com",
      age: 35,
    });

    const { plexus, doc } = initTestPlexus<User>(user);

    // Verify Plexus is associated with document
    expect(plexus.doc).to.equal(doc);
  });

  it("should handle entity relationships correctly", () => {
    const author = new User({
      name: "Author Name",
      email: "author@example.com",
      age: 40,
    });

    const post = new Post({
      title: "Related Post",
      content: "Content with relationships",
      author,
      tags: ["relationship", "test"],
    });

    const { root } = initTestPlexus<Post>(post);

    // Verify relationship integrity
    expect(root.author).to.not.eq(null);
    expect([root.author!.name, root.author!.email]).to.have.ordered.members(["Author Name", "author@example.com"]);

    // Verify relationship is maintained through mutations
    root.author!.name = "Updated Author";
    expect(root.author!.name).to.equal("Updated Author");
  });
});
