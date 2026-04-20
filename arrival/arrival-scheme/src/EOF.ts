// -------------------------------------------------------------------------
export class EOF {
  toString(): string {
    return "#<eof>";
  }
}

/** Singleton EOF instance */
export const eof = new EOF();
