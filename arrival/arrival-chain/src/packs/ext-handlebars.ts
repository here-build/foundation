// ext/handlebars — the `.hbs` file-type resolver as an opt-in capability.
//
// A `.hbs` module evaluates to a SCHEME lambda `(lambda args (template/handlebars <src> args))`
// — the resolver just emits those forms (kind: "eval"); the actual templating is the
// `template/handlebars` verb from `arrival/utils`. So this pack is PURE (no handlebars dep
// of its own) and `deps: [utils]` — the verb its resolved lambda calls. utils is also in the
// base root-set, so this is a genuine diamond; C3 linearization dedups + orders it.
//
// Registration is via the `prelude` (bootstrap-only `require/register-extension`); the
// resolver is bound as a `{ value }` so `require` gets the raw fn back (no rosetta
// marshalling) and calls it `(contents, {path}) → ResolverResult`.

import { parseGenerator as parse } from "@here.build/arrival-scheme";
import { EnvCapability } from "@here.build/arrival-scheme/capability";

import { type ResolverResult } from "../loader.js";
import { arrivalUtilsCapability } from "./utils.js";

const RESOLVE = "ext/handlebars/resolve";

/** `.hbs` → `{ kind: "eval", forms }` for `(lambda args (template/handlebars <src> args))`. */
const resolveHandlebars = async (contents: unknown): Promise<ResolverResult> => ({
  kind: "eval",
  forms: await parse(`(lambda args (template/handlebars ${JSON.stringify(String(contents))} args))`),
});

export const arrivalHandlebarsCapability = new EnvCapability("ext/handlebars", {
  deps: [arrivalUtilsCapability],
  symbols: { [RESOLVE]: { value: resolveHandlebars } },
  prelude: `(require/register-extension ".hbs" "${RESOLVE}")`,
});
