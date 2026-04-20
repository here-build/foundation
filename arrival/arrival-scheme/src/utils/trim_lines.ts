// ----------------------------------------------------------------------
export function trim_lines(string) {
  return string
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .join("\n");
}
