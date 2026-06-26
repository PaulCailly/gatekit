/**
 * Pure, side-effect-free helpers for the release changelog (parsing git output,
 * rendering the deterministic fallback list, assembling the CHANGELOG.md
 * section). Kept separate from release-notes.ts — which does git/network/file
 * I/O — so this logic is unit-testable without a repo or secrets, mirroring
 * debate-core.ts.
 */

export interface Commit {
  hash: string;
  subject: string;
}

/**
 * Parse `git log --pretty=format:%H%x09%s` output into commits, dropping the
 * bot's own [skip ci] noise. Returns [] for empty/whitespace input.
 */
export function parseCommitLog(out: string): Commit[] {
  if (!out.trim()) return [];
  return out
    .split("\n")
    .map((line) => {
      const [hash, ...rest] = line.split("\t");
      return { hash, subject: rest.join("\t") };
    })
    .filter((c) => c.subject && !c.subject.includes("[skip ci]"));
}

/** Plain bullet list of commit subjects — the deterministic fallback body. */
export function rawCommitList(commits: Commit[]): string {
  return commits.map((c) => `- ${c.subject} (${c.hash.slice(0, 7)})`).join("\n");
}

/**
 * Prepend a dated `## tag — date` section for `tag` just after the changelog's
 * top-level title (so newest is first), creating the title if `existing` is
 * empty. Collapses any run of 3+ newlines so repeated runs stay tidy.
 */
export function prependChangelogSection(
  existing: string,
  tag: string,
  notes: string,
  date: string,
): string {
  const section = `## ${tag} — ${date}\n\n${notes}\n`;
  const base = existing.trim() ? existing : "# Changelog\n";
  const lines = base.split("\n");
  const titleIdx = lines.findIndex((l) => l.startsWith("# "));
  const insertAt = titleIdx === -1 ? 0 : titleIdx + 1;
  const head = lines.slice(0, insertAt).join("\n");
  const tail = lines.slice(insertAt).join("\n");
  const next = `${head}\n\n${section}${tail.replace(/^\n+/, "\n")}`;
  return next.replace(/\n{3,}/g, "\n\n");
}
