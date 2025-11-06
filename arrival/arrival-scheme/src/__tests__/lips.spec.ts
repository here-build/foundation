import { beforeAll, describe, expect, it } from "vitest";
import { env as global_environment, exec, LNumber, nil, Pair, parse, tokenize } from "../lips";
import * as path from "node:path";


const execSimple = async (string: string, env?: object, dynamic_env?: object) => {
  return exec(string, { env, dynamic_env, use_dynamic: !!dynamic_env });
};
beforeAll(async () => {
  const package_root = path.resolve(import.meta.dirname, "../..");
  await exec(`(load "${package_root}/lib/bootstrap.scm")`);
});

describe("environment", function () {
  const env = global_environment;
  var functions = {
    scope_name: function () {
      if (this.__name__ === "__frame__") {
        return this.__parent__.__name__;
      }
      return this.__name__;
    }
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
    var e = env.inherit(functions);
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
      expect(result).toEqual([undefined, LNumber(10)]);
    });
    it("should evaluate let over let", async function () {
      var code = `(define x 10)
                        (let ((x 20)) (let ((x 30)) x))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, LNumber(30)]);
    });
    it("should evaluate lambda", async function () {
      var code = `(define x 10)
                        ((let ((x 20)) (lambda () x)))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, LNumber(20)]);
    });
    it("sould create closure", async function () {
      var code = `(define fn (let ((x 10))
                                      (let ((y 20)) (lambda () (+ x y)))))
                        (fn)`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, LNumber(30)]);
    });
  });
  describe("dynamic", function () {
    it("should get value from let", async function () {
      var code = `
        (define fn (lambda (x) (* x y)))
        (let ((y 10)) (fn 20))
      `;
      const result = await execScope(code, true);
      expect(result).toEqual([undefined, LNumber(200)]);
    });
    it("should evaluate simple lambda", async function () {
      const result = await execScope(
        `(define y 20)
                        (define (foo x) (* x y))
                        ((lambda (y) (foo 10)) 2)`,
        true
      );
      expect(result).toEqual([undefined, undefined, LNumber(20)]);
    });
    it("should evaluate let over lambda", async function () {
      const result = await execScope(
        `(define y 10)
                        ((let ((y 2)) (lambda () y)))`,
        true
      );
      expect(result).toEqual([undefined, LNumber(10)]);
    });
  });
});
describe("docs", function () {
  it("all functions should have docs", function () {
    // no special reason - just have no idea how to fix in best way
    const exclusions = new Set(["%doc", "sxml-unquote-mapper"]);
    const targetEnv = global_environment;
    for (const key of Object.keys(targetEnv.__env__)) {
      if (exclusions.has(key)) {
        continue;
      }
      const value = targetEnv.__env__[key];
      if (typeof value === "function") {
        const doc = value.__doc__?.valueOf();
        console.log("key:", key, "doc:", doc);
        expect(doc).toBeTypeOf("string");
        expect(doc.length).toBeGreaterThan(0);
      }
    }
  });
});
const str2list = async (code) => (await parse(code))[0];

describe("lists", function () {
  describe("append", function () {
    it.each([
      ["(1 2 3)", "(1 2 3 10)"],
      ["((1 2 3))", "((1 2 3) 10)"],
      ["(1 2 (3) 4)", "(1 2 (3) 4 10)"],
      ["(1 2 3 (4))", "(1 2 3 (4) 10)"]
    ])("should to %s into %s (append pair)", async (code, expected) => {
      const input = await str2list(code);
      const pairToAppend = Pair(LNumber(10), nil);
      input.append(pairToAppend);
      expect(input).toEqual(await str2list(expected));
    });
    it.each([
      ["(1 2 3)", "(1 2 3 . 10)"],
      ["((1 2 3))", "((1 2 3) . 10)"],
      ["(1 2 (3) 4)", "(1 2 (3) 4 . 10)"],
      ["(1 2 3 (4))", "(1 2 3 (4) . 10)"]
    ])("should to %s into %s (append value)", async (code, expectedCode) => {
      const input = await str2list(code);
      const expected = await str2list(expectedCode);
      input.append(LNumber(10));
      expect(input).toEqual(expected);
    });

    it.each([["(1 2 3)", "((1 2 3))", "(1 2 (3) 4)", "(1 2 3 (4))", "(1 . 2)", "((1 . 2))"]])(
      "should not append nil to %s",
      async (code) => {
        var input = await str2list(code);
        input.append(nil);
        expect(input).toEqual(await str2list(code));
      }
    );
  });
});
