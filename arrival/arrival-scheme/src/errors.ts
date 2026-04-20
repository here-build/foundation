// -------------------------------------------------------------------------
// :: Source Location Tracking
// -------------------------------------------------------------------------

/**
 * Source location information for AST nodes and errors.
 * Tracks where in the source code a value originated.
 */
export interface SourceLocation {
  /** 1-indexed line number */
  line: number;
  /** 0-indexed column number */
  col: number;
  /** 0-indexed byte offset from start of source */
  offset: number;
  /** Optional source identifier (filename, module, etc.) */
  source?: string;
}

/**
 * Format a source location for display in error messages.
 */
export function formatLocation(loc: SourceLocation): string {
  const source = loc.source ? `${loc.source}:` : "";
  return `${source}${loc.line}:${loc.col}`;
}

// -------------------------------------------------------------------------
// :: Parser-related error classes
// -------------------------------------------------------------------------

/**
 * Error thrown when parsing encounters unterminated expressions
 * (unclosed strings, parentheses, etc.)
 */
export class Unterminated extends Error {
  location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "Unterminated";
    this.location = location;
  }
}

/**
 * Error thrown during parsing with source location context.
 */
export class ParseError extends Error {
  location?: SourceLocation;

  constructor(message: string, location?: SourceLocation) {
    super(location ? `${message} at ${formatLocation(location)}` : message);
    this.name = "ParseError";
    this.location = location;
  }
}

/**
 * Error thrown during evaluation with source location context.
 */
export class EvalError extends Error {
  location?: SourceLocation;
  code?: unknown;

  constructor(message: string, options?: { location?: SourceLocation; code?: unknown }) {
    const loc = options?.location;
    super(loc ? `${message} at ${formatLocation(loc)}` : message);
    this.name = "EvalError";
    this.location = options?.location;
    this.code = options?.code;
  }
}
