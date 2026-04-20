import { createSandbox } from "./src/sandbox";
import { Pair } from "./src/Pair";
import { LSymbol } from "./src/LSymbol";

(async () => {
  const sandbox = await createSandbox();

  console.log("=== Environment chain ===");
  let env: any = sandbox;
  while (env) {
    console.log("  -", env.__name__, "| bindings:", Object.keys(env.__env__).length);
    env = env.__parent__;
  }

  console.log("\n=== Testing list ===");
  const hasListBinding = sandbox.get("list", { throwError: false });
  console.log("Has list binding?", hasListBinding !== undefined);
  console.log("list type:", typeof hasListBinding, hasListBinding?.constructor?.name);

  console.log("\n=== Testing eval ===");
  const result = await sandbox.eval("(+ 1 2 3)");
  console.log("(+ 1 2 3) =", result);
  console.log("result type:", result?.constructor?.name);

  const listResult = await sandbox.eval("(list 1 2 3)");
  console.log("(list 1 2 3) =", listResult);
  console.log("Is Pair?", listResult instanceof Pair);
  console.log("car is LSymbol?", (listResult as any)?.car instanceof LSymbol);
  if ((listResult as any)?.car instanceof LSymbol) {
    console.log("car symbol name:", (listResult as any).car.__name__);
  }
})().catch(console.error);
