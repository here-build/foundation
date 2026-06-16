import "@here.build/plexus/mobx/register";
import { PlexusModel, syncing } from "@here.build/plexus";
import invariant from "tiny-invariant";

import { Draft } from "./draft.js";
import type { ExecBudget, Project } from "./project.js";
import type { Run } from "./run.js";

/** Directory portion of a project-relative path; "" for a root-level file. Matches
 *  the loader's own path math (a leading-slash key has no parent → ""). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * One source-of-the-program at a point in time. Append a new version
 * with `Program.publish(source)`; `version.run()` executes THIS exact
 * source against the doc's task cache.
 */
@syncing("ArrivalChainProgramVersion")
export class ProgramVersion extends PlexusModel<Program> {
  @syncing
  accessor source: string = "";

  async run(opts: ExecBudget & { dirname?: string } = {}): Promise<unknown> {
    const program = this.parent;
    invariant(program, "ProgramVersion: not attached to a Program");
    const project = program.parent;
    invariant(project, "Program: not attached to a Project");
    // Relative `(require …)` in the entry file resolves against the entry's OWN
    // directory. The entry is evaluated directly (not through `require`, the only
    // place that pushes a dir onto the resolver stack), so its dir must be supplied
    // as `dirname` — otherwise it falls back to the project root and a sibling
    // `(require "config.scm")` mis-resolves. Derive it from this program's path so
    // every caller of `.run()` gets correct resolution for free; an explicit
    // `opts.dirname` still wins.
    const path = project.findFilePath(program);
    const dirname = path !== undefined ? dirOf(path) : undefined;
    return project.run(this.source, { ...opts, dirname: opts.dirname ?? dirname });
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

  async run(opts: ExecBudget & { dirname?: string } = {}): Promise<unknown> {
    const latest = this.versions.at(-1);
    invariant(latest, "Program has no versions");
    return latest.run(opts);
  }
}
