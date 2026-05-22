import { Plexus } from "@here.build/plexus";

import type { Project } from "./project.js";

/**
 * The Plexus instance that owns a `Project` root. Use `ArrivalChain.bootstrap`
 * to start a new doc (server-side or in-process) and `ArrivalChain.connect`
 * to attach to a doc that has already received the bootstrap state via the
 * relay (clients).
 *
 *   const chain = ArrivalChain.bootstrap(new Project());
 *   const project = chain.root;
 *
 *   const chain = ArrivalChain.connect(doc);
 *   const project = chain.root;
 */
export class ArrivalChain extends Plexus<Project> {}
