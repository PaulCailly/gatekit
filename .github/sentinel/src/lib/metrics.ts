import { readFile } from "node:fs/promises";
import path from "node:path";

/** One scored threshold violation, as emitted by `scripts/health/analyze.mjs`. */
export interface Finding {
  /** Path relative to `src/`, e.g. `domain/sessions/session.ts`. */
  file: string;
  line: number;
  /** Enclosing function name, or null for file-level rules (e.g. `fileLoc`). */
  fn: string | null;
  /** Rule id: cyclomatic | functionLoc | nesting | params | fileLoc | duplication. */
  rule: string;
  /** Measured value that tripped the rule (e.g. cyclomatic 37, 921 lines). */
  value: number;
  /** Points subtracted from the file's score for this finding. */
  points: number;
  /** elevated | high | extreme. */
  severity: string;
}

/** Per-file code-health from the analyzer: a 0-100 score and its findings. */
export interface FileHealth {
  /** Path relative to `src/`, e.g. `presentation/screens/CoachScreen.tsx`. */
  file: string;
  /** 0-100, where 100 is clean (no findings). */
  score: number;
  /** Points subtracted from 100 to reach `score`. */
  penalty: number;
  sloc: number;
  findings: Finding[];
}

/** Raw, unformatted health data for a scope, shared by the LLM digest (changed
 *  files) and the CI code-quality report (whole tree). */
export interface HealthData {
  /** Files in scope, worst score first. */
  files: FileHealth[];
  /** Sum of in-scope SLOC. */
  totalSloc: number;
  /** Finding counts by rule, across the scope. */
  byRule: Record<string, number>;
  /** Aggregate code-health score (0-100) for the scope, or null when empty. */
  score: number | null;
  /** Score band label (good | moderate | poor), or null when empty. */
  band: string | null;
}

export interface HealthMetrics {
  /** A prose block injected into the reviewer's prompt as deterministic grounding. */
  promptSection: string;
  /** Markdown table rows for the human-facing review comment (no <details> wrapper). */
  commentBody: string;
  /** One-line aggregate code-health score for the changed files (digest header),
   *  or null when there are no per-file metrics to score. */
  scoreLine: string | null;
}

/** The shape of `.health/health.json` written by `scripts/health/index.mjs`. */
interface RawHealth {
  score?: number;
  band?: string;
  totalSloc?: number;
  perFile?: {
    file: string;
    score: number;
    penalty: number;
    sloc: number;
    findings?: Finding[];
  }[];
}

/** Score bands — mirrors `scripts/health/config.mjs` (good ≥85, moderate ≥65). */
export function rating(score: number): string {
  if (score >= 85) return "good";
  if (score >= 65) return "moderate";
  return "poor";
}

/** Normalise any path shape to a `src/`-relative key. Analyzer keys are already
 *  src-relative (`domain/x.ts`); PR changed files are repo-relative (`src/domain/x.ts`). */
function canon(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/src/");
  const rel = idx >= 0 ? norm.slice(idx + 5) : norm.replace(/^src\//, "");
  return rel.replace(/^\.?\//, "");
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** A compact "fileLoc, functionLoc×4, cyclomatic" summary of a file's findings,
 *  worst-count first. */
export function summarizeFindings(findings: Finding[]): string {
  if (findings.length === 0) return "—";
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => (n > 1 ? `${r}×${n}` : r))
    .join(", ");
}

/** Collect raw health metrics for a scope. `changedFiles === null` means the
 *  whole tree (CI code-quality report); a list scopes to those files (LLM
 *  digest). Returns null when the report is missing or nothing is in scope. */
export async function collectHealth(
  reportDir: string,
  changedFiles: string[] | null,
): Promise<HealthData | null> {
  const raw = (await readJson(path.join(reportDir, "health.json"))) as RawHealth | null;
  if (!raw || !Array.isArray(raw.perFile)) return null;

  const changed = changedFiles ? new Set(changedFiles.map(canon)) : null;

  const all: FileHealth[] = raw.perFile.map((f) => ({
    file: canon(f.file),
    score: f.score,
    penalty: f.penalty,
    sloc: f.sloc,
    findings: (f.findings ?? []).map((fd) => ({ ...fd, file: canon(fd.file) })),
  }));

  const files = (changed ? all.filter((f) => changed.has(f.file)) : all).sort(
    (a, b) => a.score - b.score,
  );
  if (files.length === 0) return null;

  const byRule: Record<string, number> = {};
  for (const f of files)
    for (const fd of f.findings) byRule[fd.rule] = (byRule[fd.rule] ?? 0) + 1;

  const totalSloc = files.reduce((s, f) => s + f.sloc, 0);

  // Whole-tree: trust the analyzer's aggregate. Scoped (changed files): the
  // overall number is meaningless, so report a SLOC-weighted average of just
  // those files' scores.
  let score: number | null;
  let band: string | null;
  if (changed) {
    const weighted = files.reduce((s, f) => s + f.score * f.sloc, 0) / (totalSloc || 1);
    score = Math.round(weighted);
    band = rating(score);
  } else {
    score = raw.score ?? null;
    band = raw.band ?? (score !== null ? rating(score) : null);
  }

  return { files, totalSloc, byRule, score, band };
}

/** Build a deterministic-metrics digest scoped to the PR's changed files.
 *  Returns null when no report exists or none of the changed files appear in it,
 *  so the reviewer degrades gracefully to its diff-only behaviour. */
export async function buildHealthMetrics(
  reportDir: string,
  changedFiles: string[],
): Promise<HealthMetrics | null> {
  const data = await collectHealth(reportDir, changedFiles);
  if (!data) return null;
  const { files, byRule, score, band } = data;

  // Aggregate score line heading the digest; the table below carries detail.
  let scoreLine: string | null = null;
  if (score !== null && band !== null) {
    const ruleNote = Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`)
      .join(", ");
    scoreLine =
      `**📊 Code health: ${score} / 100** (${band}) — ` +
      `across ${files.length} changed file(s)${ruleNote ? ` · ${ruleNote}` : ""}.`;
  }

  // Human-facing markdown table.
  const commentParts: string[] = [
    "| File | Score | SLOC | Findings |",
    "| --- | --- | --- | --- |",
    ...files.map(
      (f) =>
        `| \`${f.file}\` | ${f.score} (${rating(f.score)}) | ${f.sloc} | ${summarizeFindings(f.findings)} |`,
    ),
    "",
    "<sub>Score starts at 100; concrete violations (long/complex functions, big files, duplication) subtract points. Bands: ≥85 good · 65–85 moderate · <65 poor. Generated by `scripts/health`.</sub>",
  ];

  // LLM-facing prose grounding.
  const promptParts: string[] = [
    "These are deterministic static-analysis metrics (scripts/health) for the files this PR changes. Each file starts at 100 and loses points for concrete, fixable violations. Use them as objective grounding — do NOT restate a number as a finding on its own. Raise a finding only when the change makes a file materially worse: it drops a file into the poor band (<65), adds a high/extreme-severity function (cyclomatic/length/nesting), or introduces duplication. A pre-existing low score on a file the PR barely touches is not the PR's fault.",
    "",
    "Per-file health (score out of 100, then the specific findings):",
  ];
  for (const f of files) {
    promptParts.push(`- ${f.file}: ${f.score}/100 (${rating(f.score)}), ${f.sloc} sloc`);
    for (const fd of f.findings) {
      const where = fd.fn ? ` in \`${fd.fn}\`` : "";
      promptParts.push(
        `    - L${fd.line} ${fd.rule}=${fd.value} (${fd.severity}, −${fd.points})${where}`,
      );
    }
  }

  return {
    promptSection: promptParts.join("\n"),
    commentBody: commentParts.join("\n"),
    scoreLine,
  };
}
