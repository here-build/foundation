/*
 * Bootstrap tests written in Scheme using AVA testing framework
 *
 * This file is part of the LIPS - Scheme based Powerful lips in JavaScript
 *
 * Copyright (c) 2018-2020 Jakub T. Jankiewicz <https://jcubic.pl/me>
 * Released under the MIT license
 */

// without this tests stop before running LIPS files

import fs from "fs";
import { describe, expect, test } from "vitest";
import { env, exec, nil } from "../lips";
import * as path from "node:path";

const package_root = path.resolve(import.meta.dirname, "../..");
await exec(`
  (load "${package_root}/lib/bootstrap.scm")
  (load "${package_root}/src/__tests__/schemeSpec/helpers/helpers.scm")
  `);

const specs = fs
  .readdirSync(`${import.meta.dirname}/schemeSpec/`)
  .filter((file) => file.endsWith(".scm") && !file.match(/^\.#|^_/));

describe.each([specs.at(0)])("spec check: %s", async (filename) => {
  const file = fs.readFileSync(`${import.meta.dirname}/schemeSpec/${filename}`, "utf-8");
  // todo use inherited env
  env.set("test", test);
  env.set("Array", Array);
  env.set("RegExp", RegExp);
  env.set("Promise", Promise);
  env.set("setTimeout", setTimeout);
  env.set("expected", expect);
  env.set("error", (v) => {
    throw new Error(v);
  });
  env.set("string=?", (a, b) => {
    return a === b ? env.get("true") : env.get("false");
  });
  env.set("string<=?", (a, b) => {
    return a <= b ? env.get("true") : env.get("false");
  });
  env.set("string>=?", (a, b) => {
    return a >= b ? env.get("true") : env.get("false");
  });
  env.set("string<?", (a, b) => {
    return a < b ? env.get("true") : env.get("false");
  });
  env.set("string>?", (a, b) => {
    return a > b ? env.get("true") : env.get("false");
  });
  env.set("string-ci=?", (a, b) => {
    return a.toLowerCase() === b.toLowerCase() ? env.get("true") : env.get("false");
  });
  env.set("string-ci<=?", (a, b) => {
    return a.toLowerCase() <= b.toLowerCase() ? env.get("true") : env.get("false");
  });
  env.set("string-ci>=?", (a, b) => {
    return a.toLowerCase() >= b.toLowerCase() ? env.get("true") : env.get("false");
  });
  env.set("string-ci<?", (a, b) => {
    return a.toLowerCase() < b.toLowerCase() ? env.get("true") : env.get("false");
  });
  env.set("string-ci>?", (a, b) => {
    return a.toLowerCase() > b.toLowerCase() ? env.get("true") : env.get("false");
  });
  env.set("equal?", (a, b) => {
    return a === b ? env.get("true") : env.get("false");
  });
  env.set("=", (a, b) => {
    return a === b ? env.get("true") : env.get("false");
  });
  env.set("string-append", (...args) => {
    return args.map((arg) => arg.valueOf()).join("");
  });
  env.set("zero?", (val) => {
    return val === 0 || val === 0n;
  });
  env.set("newline", () => {
    return "\n";
  });
  env.set("t.try", (fn, a, b) => {
    try {
      return fn();
    } catch {
      return nil;
    }
  });

  await exec(file, {
    env: env,
    dynamic_env: env,
    use_dynamic: false
  });
});
