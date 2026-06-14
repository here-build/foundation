import dedent from "dedent";

import type { EnvPack } from "@here.build/arrival-scheme/env";
import { type ArrivalEnv, renderTemplateCall } from "../infer-kernel.js";

/** Pure string/json/template utilities — no deps, no arming. */
export function arrivalUtilsPack(): EnvPack<ArrivalEnv> {
  return {
    name: "arrival/utils",
    apply: (env) => {
      env.defineRosetta("json/parse", { fn: (s: unknown) => JSON.parse(String(s)), type: "(s: SStr): unknown" });
      env.defineRosetta("string-dedent", { fn: (s: unknown) => dedent(String(s)), type: "(s: SStr): SStr" });
      env.defineRosetta("template/handlebars", {
        fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
        type: "(source: SStr, args: unknown): SStr",
      });
    },
  };
}
