import { estimateCost, type ModelSpec } from "./openrouter.js";
import type { Finding, ReviewResult, Severity, Usage } from "./types.js";

/** One model's completed review, with the run cost inputs needed to benchmark it. */
export interface ModelRun {
  model: ModelSpec;
  result: ReviewResult;
  usage: Usage;
  turns: number;
}

/** A model that was asked to review but errored (timeout, refusal, non-convergence). */
export interface ModelFailure {
  model: ModelSpec;
  error: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
const SEVERITY_EMOJI: Record<Severity, string> = { error: "🔴", warning: "🟠", info: "🔵" };

/** Findings on the same file within this many lines are treated as the same issue.
 *  Different models rarely land on the exact same line for one bug, so a small
 *  window catches the overlap without merging genuinely separate findings. */
const LINE_WINDOW = 2;

/** A group of findings (across models) judged to describe the same underlying issue. */
interface Cluster {
  path: string;
  /** Representative line (the first/anchor finding's line), or null for file-level. */
  line: number | null;
  /** Representative title — the highest-severity member's (the anchor's, until a more severe one merges in). */
  title: string;
  /** Highest severity any member assigned. */
  severity: Severity;
  /** Model keys that flagged this issue. */
  models: Set<string>;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Cluster every model's findings into shared issues. Two findings on the same
 * file within LINE_WINDOW lines collapse into one cluster; file-level (null-line)
 * findings collapse by normalised title. A cluster's `models` set is the heart of
 * the overlap analysis — `size >= 2` means more than one model agreed.
 */
export function clusterFindings(runs: ModelRun[]): Cluster[] {
  const byPath = new Map<string, { key: string; f: Finding }[]>();
  for (const run of runs) {
    const key = run.model.key;
    for (const f of run.result.findings) {
      const arr = byPath.get(f.path) ?? [];
      arr.push({ key, f });
      byPath.set(f.path, arr);
    }
  }

  const clusters: Cluster[] = [];
  for (const [path, items] of byPath) {
    // Line-anchored findings: sort by line, merge while within the window of the anchor.
    const numbered = items
      .filter((i): i is { key: string; f: Finding & { line: number } } => i.f.line !== null)
      .sort((a, b) => a.f.line - b.f.line);

    let current: Cluster | null = null;
    let anchor = 0;
    for (const { key, f } of numbered) {
      if (current && f.line - anchor <= LINE_WINDOW) {
        current.models.add(key);
        if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[current.severity]) {
          current.severity = f.severity;
          current.title = f.title;
        }
      } else {
        current = { path, line: f.line, title: f.title, severity: f.severity, models: new Set([key]) };
        clusters.push(current);
        anchor = f.line;
      }
    }

    // File-level findings: group by normalised title.
    const fileLevel = new Map<string, Cluster>();
    for (const { key, f } of items) {
      if (f.line !== null) continue;
      const nt = normTitle(f.title);
      let c = fileLevel.get(nt);
      if (!c) {
        c = { path, line: null, title: f.title, severity: f.severity, models: new Set() };
        fileLevel.set(nt, c);
        clusters.push(c);
      }
      c.models.add(key);
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[c.severity]) {
        c.severity = f.severity;
        c.title = f.title;
      }
    }
  }
  return clusters;
}

// Escape the characters that would break a markdown table cell: pipes (column
// separators) and backticks (LLM titles often mention `foo()`), and collapse
// whitespace so a multi-line value can't spill across rows.
const cell = (s: string) => s.replace(/[|`]/g, "\\$&").replace(/\s+/g, " ").trim();

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`;
}

/** Per-model scorecard: finding counts, consensus agreement, tokens, cost, status. */
function scorecard(runs: ModelRun[], failures: ModelFailure[], clusters: Cluster[]): string {
  const consensus = clusters.filter((c) => c.models.size >= 2);
  const hits = new Map<string, number>();
  for (const c of consensus) for (const k of c.models) hits.set(k, (hits.get(k) ?? 0) + 1);

  const rows = [
    "| Model | 🔴 | 🟠 | 🔵 | Total | Consensus hits | Agreement | Tokens (in/out) | Cost | Turns | Status |",
    "| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-- |",
  ];

  for (const run of runs) {
    const key = run.model.key;
    const f = run.result.findings;
    const c = (s: Severity) => f.filter((x) => x.severity === s).length;
    const hit = hits.get(key) ?? 0;
    const cost = estimateCost(run.usage, run.model);
    const tok = `${(run.usage.input_tokens / 1000).toFixed(1)}k / ${(run.usage.output_tokens / 1000).toFixed(1)}k`;
    rows.push(
      `| \`${run.model.key}\` ${run.model.label} | ${c("error")} | ${c("warning")} | ${c("info")} | ${f.length} | ` +
        `${hit}/${consensus.length} | ${pct(hit, consensus.length)} | ${tok} | ` +
        `${cost === null ? "n/a" : `$${cost.toFixed(3)}`} | ${run.turns} | ✅ |`,
    );
  }
  for (const fail of failures) {
    rows.push(`| \`${fail.model.key}\` ${fail.model.label} | — | — | — | — | — | — | — | — | — | ❌ ${cell(fail.error.slice(0, 80))} |`);
  }

  return rows.join("\n");
}

/** Overlap matrix: one row per issue ≥2 models flagged, a ✓/· column per model. */
function overlapMatrix(runs: ModelRun[], clusters: Cluster[]): string {
  const consensus = clusters
    .filter((c) => c.models.size >= 2)
    .sort((a, b) => b.models.size - a.models.size || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  if (consensus.length === 0) {
    return "_No issue was flagged by more than one model — every finding was unique to a single reviewer._";
  }

  const keys = runs.map((r) => r.model.key);
  const header = ["Issue", "Sev", "n", ...keys];
  const rows = [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, i) => (i < 3 ? "---" : ":-:")).join(" | ")} |`,
  ];

  for (const c of consensus) {
    const loc = c.line === null ? c.path : `${c.path}:${c.line}`;
    const marks = keys.map((k) => (c.models.has(k) ? "✓" : "·"));
    rows.push(`| \`${cell(loc)}\` — ${cell(c.title)} | ${SEVERITY_EMOJI[c.severity]} | ${c.models.size} | ${marks.join(" | ")} |`);
  }

  return rows.join("\n");
}

/**
 * Render the full benchmark section: a run-level success line, the per-model
 * scorecard, and the cross-model overlap matrix. Pure — caller decides where to
 * post it. The clustering is a deterministic heuristic (see `clusterFindings`),
 * so the overlap numbers are approximate by design.
 */
export function buildBenchmark(runs: ModelRun[], failures: ModelFailure[]): string {
  const clusters = clusterFindings(runs);
  const consensus = clusters.filter((c) => c.models.size >= 2).length;
  const totalModels = runs.length + failures.length;

  // Sum only the priced runs, and disclose how many were unpriced so the total
  // is never a precise-looking figure that silently omits unknown spend.
  let knownCost = 0;
  let unpriced = 0;
  for (const r of runs) {
    const c = estimateCost(r.usage, r.model);
    if (c === null) unpriced++;
    else knownCost += c;
  }
  const costLabel =
    unpriced === 0 ? `**$${knownCost.toFixed(3)}**` : `**$${knownCost.toFixed(3)}** + ${unpriced} unpriced model(s)`;

  return [
    "### 📊 Model benchmark",
    "",
    `**${runs.length}/${totalModels}** models converged · **${clusters.length}** distinct issues · ` +
      `**${consensus}** corroborated by ≥2 models · run cost ${costLabel}.`,
    "",
    "_“Consensus hits” = issues this model raised that another model also raised; “Agreement” = those as a share of all corroborated issues (a recall-style proxy — higher means the model caught what the pack caught)._",
    "",
    scorecard(runs, failures, clusters),
    "",
    "#### Finding overlap",
    "",
    "_Each row is an issue flagged by ≥2 models. ✓ = that model raised it. Findings within "
      + `${LINE_WINDOW} lines on the same file are treated as the same issue, so overlap is approximate._`,
    "",
    overlapMatrix(runs, clusters),
  ].join("\n");
}
