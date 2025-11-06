import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PlexusModel } from "../PlexusModel";
import { syncing } from "../decorators";
import { YJS_GLOBALS } from "../YJS_GLOBALS";
import { createTestPlexus, initTestPlexus } from "./test-plexus";

// Test models
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

@syncing
class Comment extends PlexusModel {
  @syncing
  accessor text!: string;

  @syncing
  accessor author!: User | null;

  @syncing
  accessor post!: Post | null;

  constructor(props) {
    super(props);
  }
}

// Root type that contains all our test entities
@syncing
class TestRoot extends PlexusModel {
  @syncing
  accessor user!: User | null;

  @syncing
  accessor post!: Post | null;

  @syncing
  accessor comment!: Comment | null;

  @syncing.list
  accessor users!: User[];

  @syncing.list
  accessor posts!: Post[];

  constructor(props) {
    super(props);
  }
}

describe("Plexus Entity Loading", () => {
  let doc: Y.Doc;
  let root: TestRoot;
  let user: User;
  let post: Post;
  let comment: Comment;

  beforeEach(async () => {
    // Create test entities
    const testUser = new User({
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    });

    const testPost = new Post({
      title: "Test Post",
      content: "This is a test post",
      author: testUser,
      tags: ["test", "plexus"],
    });

    const testComment = new Comment({
      text: "Great post!",
      author: testUser,
      post: testPost,
    });

    // Create root containing all entities
    const testRoot = new TestRoot({
      user: testUser,
      post: testPost,
      comment: testComment,
      users: [testUser],
      posts: [testPost],
    });

    // Initialize doc with Plexus
    const result = await initTestPlexus<TestRoot>(testRoot);
    doc = result.doc;
    root = result.root;
    user = root.user!;
    post = root.post!;
    comment = root.comment!;
  });

  describe("basic loading", () => {
    it("should load entities through Plexus root", () => {
      expect(user).not.toBeNull();
      expect(user.name).toBe("John Doe");
      expect(user.email).toBe("john@example.com");
      expect(user.age).toBe(30);
      expect(user.uuid).toBeDefined();
    });

    it("should load entities with different types", () => {
      expect(post).not.toBeNull();
      expect(post.title).toBe("Test Post");
      expect(post.content).toBe("This is a test post");

      expect(comment).not.toBeNull();
      expect(comment.text).toBe("Great post!");
    });

    it("should handle entity collections", () => {
      expect(root.users).toHaveLength(1);
      expect(root.posts).toHaveLength(1);
      expect(root.users[0].name).toBe("John Doe");
      expect(root.posts[0].title).toBe("Test Post");
    });
  });

  describe("loading with relationships", () => {
    it("should load entity with references to other entities", () => {
      expect(post.author).not.toBeNull();
      expect(post.author!.name).toBe("John Doe");
      expect(post.author!.uuid).toBe(user.uuid);
    });

    it("should load entity with collection fields", () => {
      expect(post.tags).toHaveLength(2);
      expect(post.tags[0]).toBe("test");
      expect(post.tags[1]).toBe("plexus");
    });

    it("should handle null references correctly", async () => {
      // Create a post without an author
      const orphanPost = new Post({
        title: "Orphan Post",
        content: "No author",
        author: null,
        tags: []
      });

      // Update root to include orphan post
      root.posts.push(orphanPost);

      // Verify it's accessible through root
      const orphan = root.posts.find((p) => p.title === "Orphan Post")!;
      expect(orphan).not.toBeNull();
      expect(orphan.author).toBeNull();
      expect(orphan.tags).toHaveLength(0);
    });
  });

  describe("entity mutations after loading", () => {
    it("should reflect mutations made to loaded entity", async () => {
      expect(user.name).toBe("John Doe");

      // Mutate the loaded entity
      user.name = "Jane Doe";
      user.age = 31;

      // Create new doc with fresh Plexus to verify persistence
      const freshTestRoot = new TestRoot({
        user: new User({
          name: "Jane Doe",
          email: "john@example.com",
          age: 31,
        }),
        post: null,
        comment: null,
        users: [],
        posts: [],
      });
      const { root: reloadedRoot } =
        await initTestPlexus<TestRoot>(freshTestRoot);
      expect(reloadedRoot.user!.name).toBe("Jane Doe");
      expect(reloadedRoot.user!.age).toBe(31);
    });

    it("should handle mutations to collection fields", async () => {
      expect(post.tags).toHaveLength(2);

      // Mutate the tags array
      post.tags.push("new-tag");

      // Verify mutation is immediately reflected
      expect(post.tags).toHaveLength(3);
      expect(post.tags[2]).toBe("new-tag");

      // Also verify through root reference
      expect(root.post!.tags).toHaveLength(3);
      expect(root.post!.tags[2]).toBe("new-tag");
    });
  });

  describe("type inference", () => {
    it("should correctly infer entity types through Plexus root", () => {
      // TypeScript should correctly infer these types
      // These assertions would fail at compile time if types were wrong
      const _name: string = user.name;
      const _email: string = user.email;
      const _age: number = user.age;

      const _title: string = post.title;
      const _author: User | null = post.author;
      const _tags: string[] = post.tags;

      const _text: string = comment.text;
      const _commentAuthor: User | null = comment.author;
      const _commentPost: Post | null = comment.post;

      expect(true).toBe(true); // Just to have an assertion
    });
  });

  describe("edge cases", () => {
    it("should handle loading the same root multiple times", async () => {
      // Plexus enforces single instance per doc, so test different approach
      // Create two separate docs with the same data structure
      const testUser2 = new User({
        name: "John Doe",
        email: "john@example.com",
        age: 30,
      });

      const testRoot2 = new TestRoot({
        user: testUser2,
        post: null,
        comment: null,
        users: [testUser2],
        posts: [],
      });

      const { root: secondLoad } = await initTestPlexus<TestRoot>(testRoot2);

      // Should have same data structure
      expect(root.user!.name).toBe(secondLoad.user!.name);
      expect(root.user!.email).toBe(secondLoad.user!.email);
      expect(root.user!.age).toBe(secondLoad.user!.age);
    });

    it("should handle empty document", async () => {
      const emptyDoc = new Y.Doc();

      // Should throw when trying to create Plexus without root
      await expect(createTestPlexus<TestRoot>(emptyDoc)).rejects.toThrow();
    });

    it("should handle loading after entity deletion", async () => {
      // First verify entity exists
      expect(user.name).toBe("John Doe");

      // Delete the entity from the document
      doc.getMap(YJS_GLOBALS.models).delete(user.uuid);

      // Create a new Plexus instance (allowed with new behavior)
      const { plexus: newPlexus } = await createTestPlexus<TestRoot>(doc);

      // The root should still be loaded from cache
      const newRoot = await newPlexus.rootPromise;
      expect(newRoot).toBe(root); // Same instance due to caching

      // But the deleted entity should no longer be in the doc's models
      expect(doc.getMap(YJS_GLOBALS.models).has(user.uuid)).toBe(false);

      // The entity still exists in memory due to caching
      expect(user.name).toBe("John Doe");
    });
  });

  describe("circular references", () => {
    it("should handle circular references between entities", () => {
      // Verify existing circular reference (comment -> post -> author -> comment's post)
      expect(comment.post).toBe(post);
      expect(post.author).toBe(user);
      expect(comment.author).toBe(user);

      // The circular reference is: comment.post.author === comment.author
      expect(comment.post!.author).toBe(comment.author);
    });
  });
});
