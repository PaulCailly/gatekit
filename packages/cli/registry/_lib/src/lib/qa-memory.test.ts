import assert from "node:assert/strict";
import { test } from "node:test";

// qa-memory.ts → gh.js constructs an Octokit and reads context.repo at import,
// both of which throw without these env vars. Set them before the dynamic import.
process.env.GITHUB_TOKEN ||= "test-token";
process.env.GITHUB_REPOSITORY ||= "owner/repo";
const { upsertLedger, parseLedger } = await import("./qa-memory.js");

test("upsertLedger creates a qa-coverage block when none exists", () => {
  const out = upsertLedger("# QA memory\n\nsome notes\n", ["/modules/cooling", "/home"], "2026-06-26");
  assert.match(out, /```qa-coverage/);
  const data = JSON.parse(/```qa-coverage\s*([\s\S]*?)```/.exec(out)![1]);
  assert.equal(data.routes["/modules/cooling"], "2026-06-26");
  assert.equal(data.routes["/home"], "2026-06-26");
  assert.match(out, /some notes/); // preserves existing content
});

test("upsertLedger with seedRoutes preserves history even when memory has no qa-coverage block", () => {
  // Memory with NO fenced block — simulates LLM having dropped it
  const memory = "# QA memory\n\nsome prose without any coverage block\n";
  const out = upsertLedger(memory, ["/new"], "2026-06-26", { "/old": "2026-01-01" });
  const data = JSON.parse(/```qa-coverage\s*([\s\S]*?)```/.exec(out)![1]);
  assert.equal(data.routes["/old"], "2026-01-01"); // seed route preserved
  assert.equal(data.routes["/new"], "2026-06-26"); // new covered path added
});

test("parseLedger extracts the routes map, or {} when absent/malformed", () => {
  assert.deepEqual(parseLedger("no block here"), {});
  assert.deepEqual(parseLedger("a\n```qa-coverage\n{\"routes\":{\"/x\":\"2026-01-01\"}}\n```\nb"), { "/x": "2026-01-01" });
  assert.deepEqual(parseLedger("```qa-coverage\nnot json\n```"), {});
});

test("upsertLedger merges new paths and refreshes dates", () => {
  const seed = "intro\n\n```qa-coverage\n{\"routes\":{\"/home\":\"2026-01-01\",\"/old\":\"2026-01-01\"}}\n```\n";
  const out = upsertLedger(seed, ["/home", "/modules/freezing"], "2026-06-26");
  const data = JSON.parse(/```qa-coverage\s*([\s\S]*?)```/.exec(out)![1]);
  assert.equal(data.routes["/home"], "2026-06-26"); // refreshed
  assert.equal(data.routes["/old"], "2026-01-01"); // preserved
  assert.equal(data.routes["/modules/freezing"], "2026-06-26"); // added
  assert.equal((out.match(/```qa-coverage/g) ?? []).length, 1); // exactly one block
});
