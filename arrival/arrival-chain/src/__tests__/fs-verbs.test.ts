import { describe, expect, it } from "vitest";

import { ArrivalChain } from "../arrival-chain.js";
import { Project } from "../project.js";

const newProject = (): Project => ArrivalChain.bootstrap(new Project()).root;

describe("Project fs verbs — renamePath / removePath over a flat path map", () => {
  it("renamePath on a file re-keys the SAME Program, preserving version history", () => {
    const project = newProject();
    const program = project.addFile("a.scm", "(define x 1)");
    program.publish("(define x 2)");
    expect(program.versions.length).toBe(2);

    project.renamePath("a.scm", "b.scm");

    expect(project.files.has("a.scm")).toBe(false);
    // Same instance, same history — not a clone.
    expect(project.files.get("b.scm")).toBe(program);
    expect(program.versions.length).toBe(2);
  });

  it("renamePath on a folder re-keys every descendant under the new prefix", () => {
    const project = newProject();
    const p1 = project.addFile("src/a.scm", "1");
    const p2 = project.addFile("src/nested/b.scm", "2");
    project.addFile("README.md", "keep");

    project.renamePath("src", "lib");

    expect(project.files.get("lib/a.scm")).toBe(p1);
    expect(project.files.get("lib/nested/b.scm")).toBe(p2);
    expect(project.files.has("src/a.scm")).toBe(false);
    expect(project.files.has("README.md")).toBe(true); // untouched
  });

  it("renamePath rejects a file→existing collision", () => {
    const project = newProject();
    project.addFile("a.scm", "1");
    project.addFile("b.scm", "2");
    expect(() => project.renamePath("a.scm", "b.scm")).toThrow(/already exists/);
  });

  it("renamePath rejects a file→occupied-folder collision (no file/dir name clash)", () => {
    const project = newProject();
    project.addFile("a.scm", "1");
    project.addFile("b/c.scm", "2");
    expect(() => project.renamePath("a.scm", "b")).toThrow(/already exists/);
  });

  it("renamePath rejects moving a folder into its own descendant (cycle)", () => {
    const project = newProject();
    project.addFile("src/a.scm", "1");
    expect(() => project.renamePath("src", "src/inner")).toThrow(/into itself/);
  });

  it("renamePath throws on a missing source", () => {
    const project = newProject();
    expect(() => project.renamePath("nope", "x")).toThrow(/no such file or folder/);
  });

  it("renamePath is a no-op when from === to", () => {
    const project = newProject();
    const program = project.addFile("a.scm", "1");
    project.renamePath("a.scm", "a.scm");
    expect(project.files.get("a.scm")).toBe(program);
  });

  it("removePath deletes a single file", () => {
    const project = newProject();
    project.addFile("a.scm", "1");
    project.addFile("b.scm", "2");
    project.removePath("a.scm");
    expect(project.files.has("a.scm")).toBe(false);
    expect(project.files.has("b.scm")).toBe(true);
  });

  it("removePath deletes a folder and all descendants, leaving siblings", () => {
    const project = newProject();
    project.addFile("src/a.scm", "1");
    project.addFile("src/nested/b.scm", "2");
    project.addFile("src.txt", "prefix-lookalike, not under src/");
    project.addFile("README.md", "keep");

    project.removePath("src");

    expect(project.files.has("src/a.scm")).toBe(false);
    expect(project.files.has("src/nested/b.scm")).toBe(false);
    expect(project.files.has("src.txt")).toBe(true); // not a descendant of src/
    expect(project.files.has("README.md")).toBe(true);
  });

  it("removePath is a no-op on a missing path", () => {
    const project = newProject();
    project.addFile("a.scm", "1");
    project.removePath("nope");
    expect(project.files.size).toBe(1);
  });
});
