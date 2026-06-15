// arrivalUtilsCapability — the pure-function floor: no config, no resource, no deps, so any
// scope can root it in isolation (e.g. a compute sandbox with no infer/effects). It's also why
// `ext/handlebars` deps on THIS — `template/handlebars` is the verb its resolved lambda calls.

import dedent from "dedent";

import { EnvCapability } from "@here.build/arrival-scheme/capability";
import { renderTemplateCall } from "../infer-kernel.js";

export const arrivalUtilsCapability = new EnvCapability("arrival/utils", {
  symbols: {
    "json/parse": { fn: (s: unknown) => JSON.parse(String(s)), type: "(s: SStr): unknown" },
    "string-dedent": { fn: (s: unknown) => dedent(String(s)), type: "(s: SStr): SStr" },
    "template/handlebars": {
      fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
      type: "(source: SStr, args: unknown): SStr",
    },
  },
});
