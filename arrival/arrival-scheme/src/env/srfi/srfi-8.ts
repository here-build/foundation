// SRFI-8 — receive. Scheme-bootstrap capability.
//
// SINGLE SOURCE: `BOOTSTRAP_SCHEME` (bootstrap.ts) imports `SRFI8_SCM` and
// concatenates it, so this module is the sole definition site.
//
// DIALECT UNIFICATION: the bootstrap historically defined `receive` with
// `define-syntax`/`syntax-rules`, which is FULL-env-only (the sandbox's matcher
// has no `define-syntax`). This module re-expresses it once as `define-macro`
// (the sandbox-supported path, same form the threading/cut packs already use),
// and the bootstrap now single-sources from here — one definition for both envs.
import { EnvCapability } from "../capability.js";

export const SRFI8_SCM = `
;; ============ SRFI-8 receive ============
;; receive (SRFI-8) — bind the values of the producer expr to formals over body.
;;   (receive (q r) (floor/ 7 2) (list q r)) => (3 1)
(define-macro (receive formals expr . body)
  \`(call-with-values (lambda () ,expr) (lambda ,formals ,@body)))
`;

export default new EnvCapability("scheme/srfi-8", { prelude: SRFI8_SCM });
