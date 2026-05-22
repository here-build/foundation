import "@here.build/plexus/mobx/register";

import { PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import type { Project } from "./project.js";

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
 * A file in the project. Holds the version log; the cache lives on the
 * Project (cross-file content-addressed).
 *
 * `program.run()` runs the latest version.
 */
@syncing("ArrivalChainProgram")
export class Program extends PlexusModel<Project> {
  @syncing.child.list
  accessor versions: ProgramVersion[] = [];

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
