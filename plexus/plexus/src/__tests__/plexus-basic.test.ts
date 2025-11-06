import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { initTestPlexus } from "./test-plexus";

// Simple test entities
@syncing
class User extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor email!: string;

  @syncing
  accessor age!: number;

  constructor(props) {
    super(props);
  }
}

@syncing
class Post extends PlexusModel {
  @syncing
  accessor title!: string;

  @syncing
  accessor content!: string;

  @syncing
  accessor author!: User | null;

  @syncing.list
  accessor tags!: string[];


  constructor(props) {
    super(props);
  }
}

describe("Plexus Basic Functionality", () => {
  it("should create and manage Plexus document with simple entities", async () => {
    const user = new User({
      name: "John Doe",
      email: "john@example.com",
      age: 30
    });

    const post = new Post({
      title: "Test Post",
      content: "Test content",
      author: user,
      tags: ["test", "plexus"]
    });

    // Initialize Plexus with post as root
    const { plexus, root, doc } = await initTestPlexus<Post>(post);

    // Verify Plexus is properly initialized
    expect(plexus).toBeDefined();
    expect(doc).toBeInstanceOf(Y.Doc);

    // Verify entity data is properly loaded
    expect(root.title).toBe("Test Post");
    expect(root.content).toBe("Test content");
    expect(root.author).not.toBeNull();
    expect(root.author!.name).toBe("John Doe");
    expect(root.tags).toHaveLength(2);
    expect(root.tags[0]).toBe("test");

    // Verify mutations work
    root.title = "Updated Title";
    root.tags.push("updated");

    expect(root.title).toBe("Updated Title");
    expect(root.tags).toHaveLength(3);
    expect(root.tags[2]).toBe("updated");
  });

  it("should handle async root promise resolution", async () => {
    const user = new User({
      name: "Jane Doe",
      email: "jane@example.com",
      age: 25
    });

    const { plexus, root } = await initTestPlexus<User>(user);

    // Verify the root promise resolved correctly
    const resolvedRoot = await plexus.rootPromise;
    expect(resolvedRoot).toBe(root);
    expect(resolvedRoot.name).toBe("Jane Doe");
    expect(resolvedRoot.age).toBe(25);
  });

  it("should maintain document-plexus relationship", async () => {
    const user = new User({
      name: "Bob Smith",
      email: "bob@example.com",
      age: 35
    });

    const { plexus, doc } = await initTestPlexus<User>(user);

    // Verify Plexus is associated with document
    expect(plexus.doc).toBe(doc);
  });

  it("should handle entity relationships correctly", async () => {
    const author = new User({
      name: "Author Name",
      email: "author@example.com",
      age: 40
    });

    const post = new Post({
      title: "Related Post",
      content: "Content with relationships",
      author: author,
      tags: ["relationship", "test"]
    });

    const { root } = await initTestPlexus<Post>(post);

    // Verify relationship integrity
    expect(root.author).not.toBeNull();
    expect(root.author!.name).toBe("Author Name");
    expect(root.author!.email).toBe("author@example.com");

    // Verify relationship is maintained through mutations
    root.author!.name = "Updated Author";
    expect(root.author!.name).toBe("Updated Author");
  });
});
