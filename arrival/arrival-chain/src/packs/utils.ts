// arrivalUtilsCapability — the pure-function floor: no config, no resource, no deps, so any
// scope can root it in isolation (e.g. a compute sandbox with no infer/effects). It's also why
// `ext/handlebars` deps on THIS — `template/handlebars` is the verb its resolved lambda calls.

import dedent from "dedent";

import { EnvCapability } from "@here.build/arrival/capability";
import { renderTemplateCall } from "../infer-kernel.js";

// No `json/parse`: arrival-scheme is platonic — a value inside the program is already a value,
// never a string awaiting a parse. Data enters pre-parsed across the membrane (`require "x.json"`
// parses at the loader; API args bind already-parsed). There is no raw-JSON-string-in-program case
// left to serve, so the verb would only invite re-introducing the boundary we removed.
export const arrivalUtilsCapability = new EnvCapability("arrival/utils", {
  symbols: {
    "string-dedent": { fn: (s: unknown) => dedent(String(s)), type: "(s: SStr): SStr" },
    "template/handlebars": {
      fn: (source: unknown, args: unknown) => renderTemplateCall(String(source), Array.isArray(args) ? args : [args]),
      type: "(source: SStr, args: unknown): SStr",
    },
  },
});
