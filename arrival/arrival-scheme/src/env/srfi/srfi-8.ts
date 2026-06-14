// SRFI-8 — receive. The bootstrap defines this with `define-syntax`, which is
// FULL-env-only (the sandbox's LIPS matcher has no `define-syntax`). Re-expressed
// here as `define-macro` (the sandbox-supported path) — same semantics.
import { EnvCapability } from "../capability.js";

export default new EnvCapability("scheme/srfi-8", {
  prelude: `
(define-macro (receive formals expr . body)
  \`(call-with-values (lambda () ,expr) (lambda ,formals ,@body)))
`,
});
