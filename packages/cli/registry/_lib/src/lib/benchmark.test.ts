import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBenchmark, clusterFindings, type ModelRun } from "./benchmark.js";
import type { ModelSpec } from "./openrouter.js";
import type { Finding, Severity } from "./types.js";

const model = (key: string, priced = true): ModelSpec => ({
  key,
  slug: `vendor/${key}`,
  label: key.toUpperCase(),
  input: priced ? 1 : NaN,
  output: priced ? 2 : NaN,
});

const usage = (i: number, o: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

const find = (path: string, line: number | null, severity: Severity, title: string): Finding => ({
  path,
  line,
  severity,
  confidence: 80,
  category: "bug",
  title,
  description: "d",
  impact: "i",
});

const run = (m: ModelSpec, findings: Finding[]): ModelRun => ({
  model: m,
  result: { summary: "s", walkthrough: "", findings },
  usage: usage(100_000, 5_000),
  turns: 3,
});

test("findings on nearby lines from different models cluster as one consensus issue", () => {
  const clusters = clusterFindings([
    run(model("a"), [find("src/x.ts", 10, "warning", "off by one")]),
    run(model("b"), [find("src/x.ts", 11, "error", "index out of bounds")]),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual([...clusters[0].models].sort(), ["a", "b"]);
  // Highest severity wins, and the title tracks it.
  assert.equal(clusters[0].severity, "error");
  assert.equal(clusters[0].title, "index out of bounds");
});

test("findings far apart on the same file stay separate", () => {
  const clusters = clusterFindings([
    run(model("a"), [find("src/x.ts", 10, "info", "one")]),
    run(model("b"), [find("src/x.ts", 50, "info", "two")]),
  ]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.models.size === 1));
});

test("file-level findings cluster by normalised title", () => {
  const clusters = clusterFindings([
    run(model("a"), [find("src/x.ts", null, "info", "File too long")]),
    run(model("b"), [find("src/x.ts", null, "info", "file too long!")]),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].models.size, 2);
});

test("buildBenchmark reports converge rate, consensus, and a failed-model row", () => {
  const md = buildBenchmark(
    [
      run(model("a"), [find("src/x.ts", 10, "error", "bug")]),
      run(model("b"), [find("src/x.ts", 10, "error", "bug")]),
    ],
    [{ model: model("c"), error: "did not converge" }],
  );
  assert.match(md, /2\/3\*\* models converged/);
  assert.match(md, /1\*\* corroborated by ≥2 models/);
  assert.match(md, /did not converge/);
});

test("run cost discloses unpriced models instead of silently dropping them", () => {
  // 100k input × $1/1M + 5k output × $2/1M = $0.110.
  const priced = buildBenchmark([run(model("a"), [])], []);
  assert.match(priced, /run cost \*\*\$0\.110\*\*\./);

  const mixed = buildBenchmark([run(model("a"), []), run(model("z", false), [])], []);
  assert.match(mixed, /\+ 1 unpriced model\(s\)/);
});

test("cell escaping neutralises backticks and pipes in titles", () => {
  const md = buildBenchmark(
    [
      run(model("a"), [find("src/x.ts", 10, "error", "broken `foo()` | bar")]),
      run(model("b"), [find("src/x.ts", 10, "error", "broken `foo()` | bar")]),
    ],
    [],
  );
  assert.ok(md.includes("broken \\`foo()\\` \\| bar"));
});
