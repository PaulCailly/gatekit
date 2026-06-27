import assert from "node:assert/strict";
import { test } from "node:test";
import { motionFor, parseDebateCommand } from "./debate-core.js";

test("no models named → default panel, default motion", () => {
  const p = parseDebateCommand("/debate");
  assert.deepEqual(p.models.map((m) => m.key), ["opus", "gpt", "gemini"]);
  assert.equal(p.motion, null);
  assert.equal(p.deep, false);
});

test("explicit models, no motion", () => {
  const p = parseDebateCommand("/debate opus gpt");
  assert.deepEqual(p.models.map((m) => m.key), ["opus", "gpt"]);
  assert.equal(p.motion, null);
});

test("all → every registered model", () => {
  const p = parseDebateCommand("/debate all");
  assert.ok(p.models.length >= 5);
});

test("motion text after models is captured", () => {
  const p = parseDebateCommand("/debate opus gpt is the auth flow secure?");
  assert.deepEqual(p.models.map((m) => m.key), ["opus", "gpt"]);
  assert.equal(p.motion, "is the auth flow secure?");
});

test("--deep flag is parsed and stripped from the motion", () => {
  const p = parseDebateCommand("/debate all --deep should we ship this?");
  assert.equal(p.deep, true);
  assert.equal(p.motion, "should we ship this?");
});

test("fewer than two distinct models falls back to the default panel", () => {
  const p = parseDebateCommand("/debate opus");
  assert.deepEqual(p.models.map((m) => m.key), ["opus", "gpt", "gemini"]);
});

test("raw provider/slug is accepted as an ad-hoc model", () => {
  const p = parseDebateCommand("/debate opus vendor/some-model");
  assert.deepEqual(p.models.map((m) => m.key), ["opus", "vendor/some-model"]);
});

test("motionFor: empty → default motion + APPROVE vocabulary", () => {
  const c = motionFor(null);
  assert.equal(c.isDefault, true);
  assert.equal(c.motion, "Should this PR be merged as-is?");
  assert.deepEqual(c.verdicts, ["APPROVE", "REQUEST_CHANGES", "ABSTAIN"]);
});

test("motionFor: custom → FOR/AGAINST vocabulary", () => {
  const c = motionFor("ship it?");
  assert.equal(c.isDefault, false);
  assert.equal(c.motion, "ship it?");
  assert.deepEqual(c.verdicts, ["FOR", "AGAINST", "ABSTAIN"]);
});

import { motionFor as motionFor2, rotate, tally, type Vote } from "./debate-core.js";
import type { ModelSpec } from "./openrouter.js";

const m = (key: string): ModelSpec => ({ key, slug: `v/${key}`, label: key, input: 1, output: 2 });
const vote = (key: string, verdict: string): Vote => ({ model: m(key), verdict, rationale: "r" });

test("tally: clear majority decides", () => {
  const cfg = motionFor2(null);
  const t = tally([vote("a", "APPROVE"), vote("b", "APPROVE"), vote("c", "REQUEST_CHANGES")], cfg);
  assert.equal(t.winner, "APPROVE");
  assert.equal(t.decided, true);
  assert.match(t.outcomeLine, /merge favored/);
});

test("tally: tie at the top → split, no winner", () => {
  const cfg = motionFor2(null);
  const t = tally([vote("a", "APPROVE"), vote("b", "REQUEST_CHANGES")], cfg);
  assert.equal(t.winner, null);
  assert.equal(t.decided, false);
  assert.match(t.outcomeLine, /split — no consensus/);
});

test("tally: abstentions do not win", () => {
  const cfg = motionFor2(null);
  const t = tally([vote("a", "ABSTAIN"), vote("b", "ABSTAIN"), vote("c", "APPROVE")], cfg);
  assert.equal(t.winner, "APPROVE");
});

test("tally: unknown verdict counts as ABSTAIN", () => {
  const cfg = motionFor2(null);
  const t = tally([vote("a", "MAYBE"), vote("b", "APPROVE")], cfg);
  assert.equal(t.counts.ABSTAIN, 1);
  assert.equal(t.winner, "APPROVE");
});

test("rotate shifts the speaking order", () => {
  assert.deepEqual(rotate([1, 2, 3], 0), [1, 2, 3]);
  assert.deepEqual(rotate([1, 2, 3], 1), [2, 3, 1]);
  assert.deepEqual(rotate([1, 2, 3], 2), [3, 1, 2]);
  assert.deepEqual(rotate([1, 2, 3], 3), [1, 2, 3]);
});
