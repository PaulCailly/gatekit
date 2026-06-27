import { coverageFor, type Coverage, type QaMap } from "./qa-map.js";
import { buildReport, type RunMetrics } from "./qa-core.js";
import type { QaFinding } from "./qa-core.js";

export interface ShardResult {
  domain: string;
  ok: boolean;
  reason?: string;
  visited: string[];
  findings: QaFinding[];
  coverage: Coverage | null;
  turns: number;
  metrics?: RunMetrics;
  replayUrl?: string | null;
}

export interface MergedShards {
  visited: string[];
  findings: QaFinding[];
  overall: Coverage;
  perDomain: Array<{ domain: string; coverage: Coverage | null; ok: boolean; reason?: string }>;
}

export function mergeShards(map: QaMap, shards: ShardResult[]): MergedShards {
  const visited = [...new Set(shards.flatMap((s) => s.visited))].sort();

  const seen = new Set<string>();
  const findings: QaFinding[] = [];
  for (const s of shards) {
    for (const f of s.findings) {
      const key = `${s.domain}/${f.area}/${f.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }

  const perDomain = [...shards]
    .sort((a, b) => a.domain.localeCompare(b.domain, "en"))
    .map((s) => ({ domain: s.domain, coverage: s.coverage, ok: s.ok, reason: s.reason }));

  return { visited, findings, overall: coverageFor(map, visited), perDomain };
}

export function buildShardResult(
  map: QaMap,
  domain: string,
  r: { findings: QaFinding[]; paths: string[]; turns: number; inputTokens: number; outputTokens: number; durationMs: number },
  replayUrl: string | null,
  pricing: { input: number; output: number },
): ShardResult {
  const coverage = coverageFor(map, r.paths, { domain });
  const costUsd = (r.inputTokens * pricing.input + r.outputTokens * pricing.output) / 1_000_000;
  return {
    domain,
    ok: true,
    visited: r.paths,
    findings: r.findings,
    coverage,
    turns: r.turns,
    metrics: {
      steps: r.turns,
      budget: 0,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd,
      durationMs: r.durationMs,
    },
    replayUrl,
  };
}

export function buildAggregateReport(
  map: QaMap,
  shards: ShardResult[],
  opts: { targetUrl: string; marker: string; metrics?: RunMetrics; replayLinks?: Array<{ domain: string; url: string }> },
): string {
  const merged = mergeShards(map, shards);
  const completed = shards.filter((s) => s.ok).length;
  const turns = shards.reduce((n, s) => n + (s.turns || 0), 0);
  const replay = (opts.replayLinks ?? []).map((r) => `- \`${r.domain}\`: [recording](${r.url})`).join("\n");
  const summary =
    `Full-app sweep, fanned out across ${shards.length} domain(s) (${completed} completed). ` +
    `Overall coverage ${merged.overall.overall.covered}/${merged.overall.overall.total} ` +
    `(${merged.overall.overall.pct}%).` + (replay ? `\n\n**Per-domain recordings:**\n${replay}` : "");
  return buildReport({
    mode: "full",
    targetUrl: opts.targetUrl,
    findings: merged.findings,
    turns,
    summary,
    marker: opts.marker,
    metrics: opts.metrics,
    coverage: merged.overall,
    domainStatus: merged.perDomain.map((p) => ({ domain: p.domain, ok: p.ok, reason: p.reason })),
  });
}
