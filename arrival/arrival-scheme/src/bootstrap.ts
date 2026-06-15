/**
 * Bootstrap Scheme Code
 *
 * This module contains the essential Scheme macros and functions
 * that cannot be implemented in TypeScript (primarily macros).
 *
 * Previously loaded from lib/bootstrap.scm, now embedded directly
 * for faster startup and no file I/O dependency.
 *
 * Every body lives in its own observable pack module (src/env/core.ts,
 * src/env/{polyglot,r7rs,arrival-extensions}.ts, src/env/srfi/*) as an exported
 * `*_SCM` const + an `EnvCapability`; BOOTSTRAP_SCHEME concatenates them so each
 * has a single definition site. This string is the legacy (concatenated) base —
 * the same bodies the base packs carry, assembled here in dependency order.
 */

import { CORE_SCM } from "./env/core.js";
import { POLYGLOT_SCM } from "./env/polyglot.js";
import { R7RS_SCM } from "./env/r7rs.js";
import { ARRIVAL_EXTENSIONS_SCM } from "./env/arrival-extensions.js";
import { SRFI1_SCM } from "./env/srfi/srfi-1.js";
import { SRFI2_SCM } from "./env/srfi/srfi-2.js";
import { SRFI8_SCM } from "./env/srfi/srfi-8.js";
import { SRFI26_SCM } from "./env/srfi/srfi-26.js";
import { SRFI43_SCM } from "./env/srfi/srfi-43.js";
import { SRFI128_SCM } from "./env/srfi/srfi-128.js";
import { SRFI189_SCM } from "./env/srfi/srfi-189.js";

export const BOOTSTRAP_SCHEME = `${CORE_SCM}
${POLYGLOT_SCM}

${SRFI26_SCM}

${R7RS_SCM}

${ARRIVAL_EXTENSIONS_SCM}

;; ================================================================
;; SRFI libraries (pure procedures — added 2026-06-11). All exec-verified.
;; arrival is immutable by design (no vector-set!), so only PURE ops are here.
;; ================================================================
${SRFI1_SCM}
${SRFI43_SCM}

${SRFI189_SCM}
${SRFI128_SCM}

;; ============ SRFI-8 receive + SRFI-2 and-let* (expression macros) ============
;; (let-values / let*-values already live above as define-macro forms.)
${SRFI8_SCM}
${SRFI2_SCM}
`;
