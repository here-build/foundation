import { expect } from "vitest";

import { execSerialized } from "../execSerialized";

declare module "vitest" {
  interface Assertion {
    toExecuteInto(...expectedResults: string[]): Promise<void>;
  }
  interface AsymmetricMatchersContaining {
    toExecuteInto(...expectedResults: string[]): any;
  }
}

expect.extend({
  async toExecuteInto(received: string, ...expectedResults: string[]) {
    try {
      const actualResults = await execSerialized(received);

      const pass =
        actualResults.length === expectedResults.length &&
        actualResults.every((result, index) => result === expectedResults[index]);

      return pass
        ? {
            message: () => `expected ${received} not to execute into [${expectedResults.join(", ")}], but it did`,
            pass: true
          }
        : {
            message: () =>
              `expected ${received} to execute into [${expectedResults.join(", ")}], but got [${actualResults.join(", ")}]`,
            pass: false
          };
    } catch (error: any) {
      return {
        message: () => `expected ${received} to execute successfully, but got error: ${error.message}`,
        pass: false
      };
    }
  }
});
