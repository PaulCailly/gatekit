/**
 * GitHub only accepts an inline review comment when its line is part of the
 * diff. For `side: "RIGHT"` that means added (`+`) or context (` `) lines —
 * i.e. lines that exist in the new version of the file. This parses a unified
 * diff patch (as returned by `pulls.listFiles`) into the set of new-file line
 * numbers we are allowed to anchor a comment to.
 */
export function commentableLines(patch?: string): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) {
      // removed line: advances the old file only, not commentable on RIGHT
      continue;
    }
    // added (`+`) and context (` `) lines both exist in the new file
    lines.add(newLine);
    newLine++;
  }
  return lines;
}
