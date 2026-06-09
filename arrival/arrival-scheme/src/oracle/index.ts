// oracle/index.ts — Track O assembly point (the local module export).
//
// This is the public face of the constraint-kernel oracle (Track A of
// sift/docs/CONSTRAINT-KERNEL-SPEC.md). It assembles the Layer-S structural reader (scanner.ts)
// behind the contract interfaces (contract.ts). The package-level public export is the deferred
// `Ocontract`/`A3` node (it adds this through src/index.ts's explicit allowlist) — this file is the
// module-local boundary that node will re-export; do NOT edit src/index.ts here.
//
// Σ (O2) and T (O3) layers attach to this assembly later; today the scanner degrades them
// gracefully per the contract (validSymbols/expectedType → null, produces → true).

export type {
  CursorPosition,
  EvalResult,
  FormKind,
  OracleEnv,
  OracleScanner,
  OracleSession,
  OracleState,
  TokenClass,
  TypeTag,
} from "./contract.js";

export { scan, structuralScanner, validNextClasses } from "./scanner.js";

import { structuralScanner } from "./scanner.js";
import type { OracleScanner } from "./contract.js";

/**
 * The assembled Layer-S oracle. Today this is the structural scanner; as O2/O3 land they wrap this
 * with Σ/T refinement behind the same `OracleScanner` surface, so consumers never change.
 */
export function makeOracle(): OracleScanner {
  return structuralScanner;
}
