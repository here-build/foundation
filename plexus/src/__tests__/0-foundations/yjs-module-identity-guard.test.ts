/**
 * Invariant: doc passed to Plexus.bootstrap/connect must be an instance
 * of Plexus's bundled `Y.Doc`. Catches the duplicate-yjs-module-in-
 * node_modules failure mode where binary sync works but observers
 * silently no-op.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { syncing } from "../../decorators.js";
import { Plexus } from "../../Plexus.js";
import { PlexusModel } from "../../PlexusModel.js";

@syncing("YIdentityGuardRoot")
class Root extends PlexusModel {
  @syncing accessor value: string = "";
}

class ForeignDoc { clientID = 1; guid = "foreign"; }

describe("yjs module identity invariant", () => {
  it("accepts a doc from the same yjs", () => {
    expect(() => Plexus.bootstrap(new Root(), undefined, new Y.Doc())).not.toThrow();
  });

  it("bootstrap rejects a doc from a foreign yjs", () => {
    expect(() => Plexus.bootstrap(new Root(), undefined, new ForeignDoc() as unknown as Y.Doc)).toThrow(/duplicate yjs/);
  });

  it("connect rejects a doc from a foreign yjs", () => {
    expect(() => Plexus.connect(new ForeignDoc() as unknown as Y.Doc)).toThrow(/duplicate yjs/);
  });
});
