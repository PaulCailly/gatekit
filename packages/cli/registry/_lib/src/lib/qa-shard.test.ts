import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeShards, buildAggregateReport, buildShardResult, type ShardResult } from "./qa-shard.js";
import type { QaMap } from "./qa-map.js";

// Inline fixture — keeps engine tests self-contained in the registry (no consumer bible needed).
const map: QaMap = {
  locales: ["en"],
  routes: [
    { path: "/a", section: "a", module: null, domain: "d1", preconditions: [] },
    { path: "/b", section: "b", module: null, domain: "d2", preconditions: [] },
  ],
  domains: [
    { key: "d1", label: "D1", routes: ["/a"], preconditions: [] },
    { key: "d2", label: "D2", routes: ["/b"], preconditions: [] },
  ],
  outOfScope: [],
  enabledModules: [],
};
const dk = map.domains.map((d) => d.key);

function shard(domain: string, visited: string[], findings: any[] = [], ok = true, reason?: string): ShardResult {
  return { domain, ok, reason, visited, findings, coverage: null, turns: 1 };
}

test("mergeShards unions visited and dedups findings", () => {
  const f = { severity: "major", area: dk[0], title: "Broken X", description: "", steps: "", expected: "", actual: "" };
  const merged = mergeShards(map, [
    shard(dk[0], ["/a", "/b"], [f]),
    shard(dk[1], ["/b", "/c"], [{ ...f }]),  // same title+domain → still 2 (different domain key)
    shard(dk[0], ["/a"], [{ ...f }]),         // same domain+title → deduped
  ]);
  assert.deepEqual(merged.visited, ["/a", "/b", "/c"]);
  // f in dk[0] appears twice (shards 1 & 3) → deduped to 1; f in dk[1] is a distinct (domain,title) → kept
  assert.equal(merged.findings.length, 2);
  assert.equal(merged.perDomain.length, 3);
});

test("mergeShards surfaces a failed shard as a row, not dropped", () => {
  const merged = mergeShards(map, [shard(dk[0], [], [], false, "timeout")]);
  const row = merged.perDomain.find((p) => p.domain === dk[0])!;
  assert.equal(row.ok, false);
  assert.equal(row.reason, "timeout");
});

test("mergeShards overall coverage is computed over the union", () => {
  const merged = mergeShards(map, [shard(dk[0], [])]);
  assert.ok(merged.overall.overall.total > 0);
  assert.equal(typeof merged.overall.overall.pct, "number");
});

test("buildShardResult computes per-domain coverage + metrics", () => {
  const dk = map.domains.map((d) => d.key)[0];
  const r = { findings: [], paths: [], turns: 5, inputTokens: 1000, outputTokens: 50, durationMs: 1234 };
  const sr = buildShardResult(map, dk, r, "https://replay", { input: 1, output: 2 });
  assert.equal(sr.domain, dk);
  assert.equal(sr.ok, true);
  assert.equal(sr.turns, 5);
  assert.ok(sr.coverage && sr.coverage.overall.total >= 0);
  assert.equal(sr.metrics!.costUsd, (1000 * 1 + 50 * 2) / 1_000_000);
  assert.equal(sr.replayUrl, "https://replay");
});

test("buildAggregateReport renders a rollup with the failed domain and a finding", () => {
  const f = { severity: "major", area: dk[0], title: "Dropdown dead", description: "", steps: "", expected: "", actual: "" };
  const body = buildAggregateReport(map, [
    shard(dk[0], ["/x"], [f], true),
    shard(dk[1], [], [], false, "timeout"),
  ], { targetUrl: "https://x.app", marker: "<!-- qa:report -->" });
  assert.match(body, /Dropdown dead/);
  assert.match(body, /timeout/);
  assert.match(body, /<!-- qa:report -->/);
});
