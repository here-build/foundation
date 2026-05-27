/**
 * Draft — one in-flight mutable edit on a deployed file.
 *
 * Stateless head: `source` is the only mutable surface; there is no
 * draft-version history. Sandbox runs against the draft snapshot
 * `source` at the moment they fire, and pin to the basedOn version
 * for provenance (so a hypothesis off a sandbox run knows which
 * deployed version it diverged from).
 *
 * Promoting a draft appends a new ProgramVersion to the parent
 * Program's `versions[]` and clears `Program.draft` — at most one
 * draft per file at a time.
 */
import "@here.build/plexus/mobx/register";
import { PlexusModel, syncing } from "@here.build/plexus";

import type { Program } from "./program.js";
import type { Run } from "./run.js";

@syncing("ArrivalChainDraft")
export class Draft extends PlexusModel<Program> {
  @syncing accessor source: string = "";
  /** Version index in parent Program.versions[] this draft was forked from. */
  @syncing accessor basedOnVersion: number = -1;
  /** Sandbox runs against this draft, keyed by mint-time id. */
  @syncing.child.map accessor sandbox: Map<string, Run> = new Map();
}
