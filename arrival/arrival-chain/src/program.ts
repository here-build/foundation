import "@here.build/plexus/mobx/register";
import { PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { Draft } from "./draft.js";
import type { Project } from "./project.js";
import type { Run } from "./run.js";

/**
 * One source-of-the-program at a point in time. Append a new version
 * with `Program.publish(source)`; `version.run()` executes THIS exact
 * source against the doc's task cache.
 */
@syncing("ArrivalChainProgramVersion")
export class ProgramVersion extends PlexusModel<Program> {
  @syncing
  accessor source: string = "";

  async run(): Promise<unknown> {
    const program = this.parent;
    invariant(program, "ProgramVersion: not attached to a Program");
    const project = program.parent;
    invariant(project, "Program: not attached to a Project");
    return project.run(this.source);
  }
}

/**
 * A deployed .scm file. Read-only view of the latest published version;
 * edits go through `Program.draft` (a separate mutable head).
 *
 *   versions[] — deployment timeline. Grows on `promoteDraft`; never on plain edit.
 *   apiCalls   — external invocations against deployed versions.
 *   draft      — at most one in-flight editable fork. Sandbox runs live under it.
 */
@syncing("ArrivalChainProgram")
export class Program extends PlexusModel<Project> {
  @syncing.child.list
  accessor versions: ProgramVersion[] = [];

  /** Reverse-membrane: external invocation Runs, keyed by client-supplied id. */
  @syncing.child.map accessor apiCalls: Map<string, Run> = new Map();

  /** At most one in-flight draft. Null = no edits in progress; editor is read-only. */
  @syncing.child accessor draft: Draft | null = null;

  publish(source: string): ProgramVersion {
    const version = new ProgramVersion({ source });
    this.versions.push(version);
    return version;
  }

  async run(): Promise<unknown> {
    const latest = this.versions.at(-1);
    invariant(latest, "Program has no versions");
    return latest.run();
  }
}
