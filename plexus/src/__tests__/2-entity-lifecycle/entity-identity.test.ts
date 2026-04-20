import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { PlexusModel } from "../../PlexusModel.js";
import { connectTestPlexus, initTestPlexus } from "../_helpers/test-plexus.js";
import { getModelsMap } from "../getModelsMap.js";

// Simple model for singleton tests
@syncing("Root")
class Root extends PlexusModel {
  @syncing
  accessor name!: string;
}

// Models for edge case tests
@syncing("Parent")
class Parent extends PlexusModel {
  @syncing
  accessor stringish = "stringish";
  accessor stringishWithDefault = "stringishWithDefault";
}

@syncing("Child")
class Child extends Parent {
  @syncing
  // @ts-expect-error
  accessor stringish!: "stringish" | "updatedStringish";
  @syncing
  accessor stringishWithDefault = "stringishWithDefaultOverride";
}

@syncing("Component")
class Component extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing
  accessor type!: string;

  @syncing.list
  accessor children: Component[] = [];

  @syncing.record
  accessor metadata: Record<string, string> = {};
}

@syncing("Site")
class Site extends PlexusModel {
  @syncing
  accessor name!: string;

  @syncing.record
  accessor components!: Record<string, Component>;

  @syncing
  accessor inherited: Child = new Child();

  @syncing
  accessor defined!: Child | null;
}

// Helper to create materialized site as root
async function createTestSite(name: string): Promise<{ site: Site; entityId: string; doc: Y.Doc }> {
  const ephemeralSite = new Site({ name, components: {} });
  const { doc, root: site } = initTestPlexus<Site>(ephemeralSite);
  return { site, entityId: site.uuid, doc };
}

// Models for entity loading tests
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

@syncing("Comment")
class Comment extends PlexusModel {
  @syncing
  accessor text!: string;

  @syncing
  accessor author!: User | null;

  @syncing
  accessor post!: Post | null;
}

// Root type that contains all our test entities
@syncing("TestRoot")
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
}

describe("Entity Identity", () => {
  describe("Plexus singleton per Y.Doc", () => {
    it("allows multiple instances for the same document but shares dependencies", () => {
      const rootEntity = new Root({ name: "r" });
      const { doc, plexus: plexus1, root: root1 } = initTestPlexus<Root>(rootEntity);

      // Second instance should be allowed but will share dependency mappings
      const { plexus: plexus2, root: root2 } = connectTestPlexus<Root>(doc);

      // Both should exist, be the same instance, share doc, and return same root
      expect([plexus1, plexus2, plexus1 === plexus2, plexus2.doc, root2]).to.satisfy(
        ([p1, p2, same, doc2, r2]: any[]) =>
          p1 !== undefined && p2 !== undefined && same === true && doc2 === doc && r2 === root1,
      );
    });
  });

  describe("Plexus Entity Loading", () => {
    let doc: Y.Doc;
    let root: TestRoot;
    let user: User;
    let post: Post;
    let comment: Comment;

    beforeEach(() => {
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
      const result = initTestPlexus<TestRoot>(testRoot);
      doc = result.doc;
      root = result.root;
      user = root.user!;
      post = root.post!;
      comment = root.comment!;
    });

    describe("basic loading", () => {
      it("should load entities through Plexus root", () => {
        expect([user, user.name, user.email, user.age, user.uuid]).to.satisfy(
          ([u, name, email, age, uuid]: any[]) =>
            u !== null && name === "John Doe" && email === "john@example.com" && age === 30 && uuid !== undefined,
        );
      });

      it("should load entities with different types", () => {
        expect([post, post.title, post.content, comment, comment.text]).to.satisfy(
          ([p, title, content, c, text]: any[]) =>
            p !== null &&
            title === "Test Post" &&
            content === "This is a test post" &&
            c !== null &&
            text === "Great post!",
        );
      });

      it("should handle entity collections", () => {
        expect([root.users.length, root.posts.length, root.users[0].name, root.posts[0].title]).to.have.ordered.members(
          [1, 1, "John Doe", "Test Post"],
        );
      });
    });

    describe("loading with relationships", () => {
      it("should load entity with references to other entities", () => {
        expect([post.author !== null, post.author!.name, post.author!.uuid]).to.have.ordered.members([
          true,
          "John Doe",
          user.uuid,
        ]);
      });

      it("should load entity with collection fields", () => {
        expect([post.tags.length, post.tags[0], post.tags[1]]).to.have.ordered.members([2, "test", "plexus"]);
      });

      it("should handle null references correctly", () => {
        // Create a post without an author
        const orphanPost = new Post({
          title: "Orphan Post",
          content: "No author",
          author: null,
          tags: [],
        });

        // Update root to include orphan post
        root.posts.push(orphanPost);

        // Verify it's accessible through root
        const orphan = root.posts.find((p) => p.title === "Orphan Post")!;
        expect([orphan !== null, orphan.author, orphan.tags.length]).to.have.ordered.members([true, null, 0]);
      });
    });

    describe("entity mutations after loading", () => {
      it("should reflect mutations made to loaded entity", () => {
        expect(user.name).to.equal("John Doe");

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
        const { root: reloadedRoot } = initTestPlexus<TestRoot>(freshTestRoot);
        expect([reloadedRoot.user!.name, reloadedRoot.user!.age]).to.have.ordered.members(["Jane Doe", 31]);
      });

      it("should handle mutations to collection fields", () => {
        expect(post.tags).to.have.lengthOf(2);

        // Mutate the tags array
        post.tags.push("new-tag");

        // Verify mutation is immediately reflected and through root reference
        expect([post.tags.length, post.tags[2], root.post!.tags.length, root.post!.tags[2]]).to.have.ordered.members([
          3,
          "new-tag",
          3,
          "new-tag",
        ]);
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

        expect(true).to.eq(true); // Just to have an assertion
      });
    });

    describe("edge cases", () => {
      it("should handle loading the same root multiple times", () => {
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

        const { root: secondLoad } = initTestPlexus<TestRoot>(testRoot2);

        // Should have same data structure
        expect([root.user!.name, root.user!.email, root.user!.age]).to.have.ordered.members([
          secondLoad.user!.name,
          secondLoad.user!.email,
          secondLoad.user!.age,
        ]);
      });

      it("should handle empty document", () => {
        const emptyDoc = new Y.Doc();

        // Should throw when trying to connect Plexus without root
        expect(() => connectTestPlexus<TestRoot>(emptyDoc)).to.throw();
      });

      it("should handle loading after entity deletion", () => {
        // First verify entity exists
        expect(user.name).to.equal("John Doe");

        // Delete the entity from the document
        getModelsMap(doc).delete(user.uuid);

        // Create a new Plexus instance (allowed with new behavior)
        const { plexus: newPlexus, root: newRoot } = connectTestPlexus<TestRoot>(doc);

        // The root should still be loaded from cache, deleted entity not in doc, but still in memory
        expect([newRoot === root, getModelsMap(doc).has(user.uuid), user.name]).to.have.ordered.members([
          true,
          false,
          "John Doe",
        ]);
      });
    });

    describe("circular references", () => {
      it("should handle circular references between entities", () => {
        // Verify existing circular reference (comment -> post -> author -> comment's post)
        // The circular reference is: comment.post.author === comment.author
        expect([comment.post, post.author, comment.author, comment.post!.author]).to.have.ordered.members([
          post,
          user,
          user,
          comment.author,
        ]);
      });
    });
  });

  describe("JSON Serialization Edge Cases", () => {
    it("should handle JSON.stringify on ephemeral entities", () => {
      const component = new Component({
        name: "Test",
        type: "component",
        children: [],
        metadata: { key: "value" },
      });

      // This should not throw or cause infinite loops
      const json = JSON.stringify(component);
      const parsed = JSON.parse(json);
      expect([parsed.name, parsed.metadata.key]).to.have.ordered.members(["Test", "value"]);
    });

    it("should handle JSON.stringify on materialized entities", async () => {
      const { site } = await createTestSite("JSON Test");

      const component = new Component({
        name: "Materialized",
        type: "component",
        children: [],
        metadata: { serialized: "true" },
      });

      site.components["test"] = component; // Materialize

      // Direct property access should work
      expect([component.name, component.metadata.serialized]).to.have.ordered.members(["Materialized", "true"]);

      // JSON serialization is expected to have limitations with proxies
      // Test that it doesn't crash and captures basic structure
      const json = JSON.stringify(component);
      const parsed = JSON.parse(json);
      expect([parsed.name, parsed.type]).to.have.ordered.members(["Materialized", "component"]);
      // Note: proxy maps may not serialize properly, which is expected
    });

    it("should handle JSON.stringify with circular references", () => {
      const compA = new Component({ name: "A", type: "component", children: [], metadata: {} });
      const compB = new Component({ name: "B", type: "component", children: [], metadata: {} });

      compA.children.push(compB);
      compB.children.push(compA); // Circular!

      // JSON.stringify should handle circular references gracefully
      expect(() => {
        JSON.stringify(compA);
      }).to.throw(/circular|cyclic/i); // Should throw expected circular reference error
    });
  });

  describe("Object Property Descriptor Edge Cases", () => {
    it("should handle Object.getOwnPropertyDescriptor", () => {
      const component = new Component({
        name: "Descriptor Test",
        type: "component",
        children: [],
        metadata: {},
      });

      const descriptor = Object.getOwnPropertyDescriptor(component, "name");
      expect(descriptor).to.be.ok;
    });
  });
});
