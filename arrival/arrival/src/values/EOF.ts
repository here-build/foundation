/** R7RS end-of-file object. Compared by identity against the {@link eof} singleton, so the reader can
 *  signal "input exhausted" with a sentinel distinguishable from any datum (`#f`, `nil`, etc.). */
export class EOF {
  toString(): string {
    return "#<eof>";
  }
}

/** The one EOF value — identity-compared everywhere; never construct another. */
export const eof = new EOF();
