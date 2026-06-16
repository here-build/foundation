// @here.build/arrival-scheme/srfi — the unified SRFI palette.
//
// Every SRFI we ship as a scheme-bootstrap capability, importable from ONE subpath:
//   import { srfi1, srfi43, allSrfi } from "@here.build/arrival-scheme/srfi";
//
// Each is a module-singleton `EnvCapability` (prelude-only). Assemble individually,
// pick a subset, or assemble the whole set via `allSrfi`.

import srfi1 from "./srfi-1.js";
import srfi2 from "./srfi-2.js";
import srfi8 from "./srfi-8.js";
import srfi26 from "./srfi-26.js";
import srfi43 from "./srfi-43.js";
import srfi128 from "./srfi-128.js";
import srfi189 from "./srfi-189.js";

export { srfi1, srfi2, srfi8, srfi26, srfi43, srfi128, srfi189 };

/** The whole SRFI set — assemble all, or `.filter()` a capability-scoped subset. */
export const allSrfi = [srfi1, srfi2, srfi8, srfi26, srfi43, srfi128, srfi189] as const;
