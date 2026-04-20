import { exec, global_env, env as global_environment, parse, evaluate } from "./src/lips";
import { initBridge, applyToEnvironment, wrappedOps } from "./src/bridge";
import { is_function, is_pair } from "./src/guards";
import { LSymbol } from "./src/LSymbol";
import { Pair as PairFromSource } from "./src/Pair";
import { Pair as PairFromLips } from "./src/lips";
import * as path from "node:path";

// Initialize like the test does
async function main() {
  console.log("=== Debug initBridge ===");
  console.log("global_environment before initBridge:", global_environment);
  console.log("wrappedOps has +?:", "+" in wrappedOps);
  console.log("wrappedOps[+]:", wrappedOps["+"]);

  // Try createRequire
  console.log("\n=== Testing createRequire ===");
  try {
    const { createRequire } = await import("node:module");
    const esmRequire = createRequire(import.meta.url);
    const lipsModule = esmRequire("./src/lips");
    console.log("require lips returned:", typeof lipsModule);
    console.log("lipsModule.env:", lipsModule.env?.__name__);
    console.log("Same as import?:", lipsModule.env === global_environment);

    // Test if setting value in one shows in the other
    lipsModule.env.set("__test_value__", 123);
    console.log(
      "After setting in CJS env, value in ESM env:",
      global_environment.get("__test_value__", { throwError: false }),
    );
  } catch (e) {
    console.log("require error:", e);
  }

  console.log("\n=== Initializing ===");
  initBridge();
  console.log("After initBridge, + in env?:", global_environment.get("+", { throwError: false }));

  // Try applying manually
  console.log("\n=== Manual apply ===");
  applyToEnvironment(global_environment);
  console.log("After manual apply, + in env?:", global_environment.get("+", { throwError: false }));

  const package_root = path.resolve(import.meta.dirname, "./");
  console.log("\nLoading bootstrap from:", package_root);
  await exec(`(load "${package_root}/lib/bootstrap.scm")`);

  console.log("\n=== Environment check ===");
  console.log("global_env type:", typeof global_environment);
  console.log("global_env name:", global_environment?.__name__);

  // Check if + exists and what it is
  const plusFn = global_environment.get("+", { throwError: false });
  console.log("+ value:", plusFn);
  console.log("+ type:", typeof plusFn);
  console.log("is_function(+)?:", is_function(plusFn));

  console.log("\n=== Testing Pair identity ===");
  console.log("PairFromSource === PairFromLips?:", PairFromSource === PairFromLips);

  console.log("\n=== Testing parse ===");
  const parsed = await parse("(+ 1 2)");
  console.log("parsed:", parsed);
  console.log("parsed[0]:", parsed[0]);
  console.log("parsed[0].car:", parsed[0].car);
  console.log("parsed[0].car is LSymbol?:", parsed[0].car instanceof LSymbol);
  console.log("parsed[0].car.__name__:", parsed[0].car.__name__);
  console.log("is_pair(parsed[0])?:", is_pair(parsed[0]));
  console.log("parsed[0] instanceof PairFromSource?:", parsed[0] instanceof PairFromSource);
  console.log("parsed[0] instanceof PairFromLips?:", parsed[0] instanceof PairFromLips);

  console.log("\n=== Testing evaluate step by step ===");
  const code = parsed[0];
  const first = code.car;
  console.log("first:", first);
  console.log("first is LSymbol?:", first instanceof LSymbol);

  if (first instanceof LSymbol) {
    const value = global_environment.get(first);
    console.log("env.get(first):", value);
    console.log("is_function(value)?:", is_function(value));
  }

  console.log("\n=== Testing evaluate directly ===");
  try {
    const evaluated = await evaluate(parsed[0], { env: global_environment });
    console.log("evaluated:", evaluated);
    console.log("evaluated valueOf:", evaluated?.valueOf?.());
  } catch (e) {
    console.log("Error during evaluate:", e);
  }

  console.log("\n=== Testing exec directly ===");
  try {
    const execResult = await exec("(+ 1 2 3)", { env: global_environment });
    console.log("exec result:", execResult);
    console.log("exec result[0]:", execResult[0]);
    console.log("exec result[0] valueOf:", execResult[0]?.valueOf?.());
  } catch (e) {
    console.log("Error during exec:", e);
  }
}

main().catch(console.error);
