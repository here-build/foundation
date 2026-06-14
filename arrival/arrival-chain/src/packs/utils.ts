// arrivalUtilsCapability — pure string/json/template utilities as an EnvCapability.
//
// Same verbs as `arrivalUtilsPack`, reshaped onto the capability surface: no config,
// no deps; the json/string/template verbs are plain rosetta-spec `methods`.

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
