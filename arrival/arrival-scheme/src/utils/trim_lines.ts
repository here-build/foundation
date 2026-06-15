/** Strip leading/trailing whitespace from every line independently, preserving line breaks. */
export function trim_lines(string) {
  return string
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .join("\n");
}
