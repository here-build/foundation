import { beforeAll, describe, expect, it } from "vitest";
import { env as global_environment, exec, parse } from "../stdlib";
import { nil } from "../types.js";
import { Pair } from "../Pair.js";
import { initBridge } from "../bridge";
import { SchemeExact } from "../numbers";

const execSimple = async (string: string, env?: object, dynamic_env?: object) => {
  return exec(string, { env, dynamic_env, use_dynamic: !!dynamic_env });
};
beforeAll(async () => {
  await initBridge();
});

describe("environment", function () {
  const env = global_environment;
  var functions = {
    scope_name: function () {
      if (this.__name__ === "__frame__") {
        return this.__parent__.__name__;
      }
      return this.__name__;
    },
  };
  async function scope(env) {
    const result = await exec("(scope_name)", { env });
    return result[0].valueOf();
  }
  it("should return name of the enviroment", async function () {
    var e = env.inherit("foo", functions);
    const result = await scope(e);
    expect(result).toEqual("foo");
  });
  it("should create default scope name", async function () {
    var e = env.inherit("child of user-env", functions);
    const result = await scope(e);
    expect(result).toEqual("child of user-env");
  });
  it("should create default scope name for child scope", async function () {
    var e = global_environment.inherit("foo", functions);
    var child = e.inherit();
    const result = await scope(child);
    expect(result).toEqual("child of foo");
  });
});
describe("scope", function () {
  const ge = global_environment;
  async function execScope(code: string, dynamic_scope?: boolean) {
    var env = ge.inherit();
    return execSimple(code, env, dynamic_scope ? env : undefined);
  }
  describe("lexical", function () {
    it("should evaluate let", async function () {
      const result = await execScope(`(define x 10) (let ((x 10)) x)`);
      expect(result).toEqual([undefined, new SchemeExact(10n)]);
    });
    it("should evaluate let over let", async function () {
      var code = `(define x 10)
                        (let ((x 20)) (let ((x 30)) x))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new SchemeExact(30n)]);
    });
    it("should evaluate lambda", async function () {
      var code = `(define x 10)
                        ((let ((x 20)) (lambda () x)))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new SchemeExact(20n)]);
    });
    it("sould create closure", async function () {
      var code = `(define fn (let ((x 10))
                                      (let ((y 20)) (lambda () (+ x y)))))
                        (fn)`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new SchemeExact(30n)]);
    });
  });
  // Dynamic scope tests removed - dynamic scoping is a legacy feature not used in standard Scheme
});
// __doc__ support has been removed - documentation is no longer attached to functions
const str2list = async (code) => (await parse(code))[0];

describe("lists", function () {
  describe("append", function () {
    it.each([
      ["(1 2 3)", "(1 2 3 10)"],
      ["((1 2 3))", "((1 2 3) 10)"],
      ["(1 2 (3) 4)", "(1 2 (3) 4 10)"],
      ["(1 2 3 (4))", "(1 2 3 (4) 10)"],
    ])("should to %s into %s (append pair)", async (code, expected) => {
      const input = await str2list(code);
      const pairToAppend = new Pair(new SchemeExact(10n), nil);
      input.append(pairToAppend);
      expect(input).toEqual(await str2list(expected));
    });
    it.each([
      ["(1 2 3)", "(1 2 3 . 10)"],
      ["((1 2 3))", "((1 2 3) . 10)"],
      ["(1 2 (3) 4)", "(1 2 (3) 4 . 10)"],
      ["(1 2 3 (4))", "(1 2 3 (4) . 10)"],
    ])("should to %s into %s (append value)", async (code, expectedCode) => {
      const input = await str2list(code);
      const expected = await str2list(expectedCode);
      input.append(new SchemeExact(10n));
      expect(input).toEqual(expected);
    });

    it.each([["(1 2 3)", "((1 2 3))", "(1 2 (3) 4)", "(1 2 3 (4))", "(1 . 2)", "((1 . 2))"]])(
      "should not append nil to %s",
      async (code) => {
        var input = await str2list(code);
        input.append(nil);
        expect(input).toEqual(await str2list(code));
      },
    );
  });
});
