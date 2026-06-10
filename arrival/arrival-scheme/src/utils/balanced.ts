// ----------------------------------------------------------------------
// Stack used in balanced function
// TODO: use it in parser
// ----------------------------------------------------------------------
import { tokenize } from "../stdlib.js";
import { TokenMeta } from "../Formatter.js";
import { Parser } from "../Parser.js";
import invariant from "tiny-invariant";

class Stack<T = string> {
  data: T[] = [];

  push(item: T): void {
    this.data.push(item);
  }

  top(): T | undefined {
    return this.data.at(-1);
  }

  pop(): T | undefined {
    return this.data.pop();
  }

  is_empty(): boolean {
    return this.data.length === 0;
  }
}

const maching_pairs: Record<string, string> = {
  "[": "]",
  "(": ")",
};
const open_tokens = Object.keys(maching_pairs);
const brackets = new Set([...Object.values(maching_pairs), ...open_tokens]);

export function balanced(code: string | TokenMeta[]): boolean {
  let tokens: string[];
  if (typeof code === "string") {
    try {
      tokens = tokenize(code) as string[];
    } catch (error) {
      if (error instanceof Parser.Unterminated) {
        return false;
      }
      throw error;
    }
  } else {
    tokens = code.map((x) => (typeof x === "object" && x !== null ? x.token : String(x)));
  }

  const stack = new Stack<string>();
  for (const token of tokens.filter((token) => brackets.has(token))) {
    if (open_tokens.includes(token)) {
      stack.push(token);
    } else if (stack.is_empty()) {
      // closing bracket without opening
      invariant(false, `Syntax error: not matched closing ${token}`);
    } else {
      // closing token
      const last = stack.top()!;
      // last on stack need to match
      const closing_token = maching_pairs[last];
      invariant(token === closing_token, `Syntax error: missing closing ${closing_token}`);
      stack.pop();
    }
  }
  return stack.is_empty();
}
