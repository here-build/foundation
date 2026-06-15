// The file-type resolver registry behind (require/register-extension): by-name mapping,
// longest-suffix match, idempotent register / conflict-throw, and the prelude-only stub.
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetExtensionRegistryForTest,
  defineRegisterExtensionRosetta,
  lookupExtensionResolver,
  REGISTER_EXTENSION_VERB,
  registerExtension,
  sealRegisterExtension,
} from "../loader-extensions.js";

afterEach(() => __resetExtensionRegistryForTest());

describe("registerExtension / lookupExtensionResolver", () => {
  it("maps a suffix to a resolver verb NAME and looks it up by path", () => {
    registerExtension(".hbs", "handlebars/lambda");
    expect(lookupExtensionResolver("templates/card.hbs")).toBe("handlebars/lambda");
    expect(lookupExtensionResolver("data/x.json")).toBeUndefined();
  });

  it("normalizes a dot-less suffix", () => {
    registerExtension("toml", "toml/parse");
    expect(lookupExtensionResolver("config.toml")).toBe("toml/parse");
  });

  it("longest matching suffix wins (.spec.json beats .json)", () => {
    registerExtension(".json", "data/json");
    registerExtension(".spec.json", "spec/parse");
    expect(lookupExtensionResolver("a.json")).toBe("data/json");
    expect(lookupExtensionResolver("a.spec.json")).toBe("spec/parse");
  });

  it("re-registering the SAME mapping is an idempotent no-op", () => {
    registerExtension(".prompt", "prompt/compile");
    expect(() => registerExtension(".prompt", "prompt/compile")).not.toThrow();
    expect(lookupExtensionResolver("x.prompt")).toBe("prompt/compile");
  });

  it("a CONFLICTING name for an already-claimed suffix throws", () => {
    registerExtension(".prompt", "prompt/compile");
    expect(() => registerExtension(".prompt", "other/compile")).toThrow(/already handled by "prompt\/compile"/);
  });
});

describe("the (require/register-extension) verb — bootstrap-only", () => {
  it("the bound verb mutates the registry", () => {
    const defs = new Map<string, { fn: (...a: unknown[]) => unknown }>();
    const host = { defineRosetta: (n: string, c: { fn: (...a: unknown[]) => unknown }) => void defs.set(n, c), set: () => undefined };
    defineRegisterExtensionRosetta(host);
    defs.get(REGISTER_EXTENSION_VERB)!.fn(".hbs", "handlebars/lambda");
    expect(lookupExtensionResolver("a.hbs")).toBe("handlebars/lambda");
  });

  it("sealRegisterExtension replaces it with a throwing stub (prelude-only enforcement)", () => {
    let stub: ((...a: unknown[]) => unknown) | undefined;
    const host = { defineRosetta: () => undefined, set: (_n: string, v: unknown) => void (stub = v as typeof stub) };
    sealRegisterExtension(host);
    expect(() => stub!(".hbs", "x")).toThrow(/bootstrap-only/);
  });
});
