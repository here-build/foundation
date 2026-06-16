// Bracket-matching predicate for partial input — the REPL uses it to decide whether an expression is
// complete or needs a continuation line. Lexer-driven, so it agrees with the real reader's tokenizer.
// TODO: have the Parser reuse this Stack rather than its own parentheses counter.
import { tokenize } from "../stdlib.js";
import { TokenMeta } from "../reader/Formatter.js";
import { Parser } from "../reader/Parser.js";
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
      // An unterminated string/comment IS unbalanced input — report it as such rather than throwing,
      // so the REPL keeps prompting for more instead of erroring mid-entry.
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
