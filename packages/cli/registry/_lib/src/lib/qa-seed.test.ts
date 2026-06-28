import { test } from "node:test";
import assert from "node:assert/strict";
import { runSeed, seedNotesBlock, type SeedCtx } from "./qa-seed.js";

const CTX: SeedCtx = { baseUrl: "http://x", mode: "focus", focus: "training_log", routes: ["/log"] };
const fakePage = {} as never;

test("runSeed(null) returns [] (no seed configured)", async () => {
  const out = await runSeed(null, fakePage, CTX, () => {});
  assert.deepEqual(out, []);
});

test("runSeed returns the seed's notes and logs", async () => {
  const logs: string[] = [];
  const out = await runSeed(async () => ({ notes: ["a session exists"] }), fakePage, CTX, (m) => logs.push(m));
  assert.deepEqual(out, ["a session exists"]);
  assert.ok(logs.some((l) => l.includes("seed applied")));
});

test("runSeed swallows a throwing seed (degrades to [], no throw)", async () => {
  const logs: string[] = [];
  const out = await runSeed(async () => { throw new Error("boom"); }, fakePage, CTX, (m) => logs.push(m));
  assert.deepEqual(out, []);
  assert.ok(logs.some((l) => l.includes("seed failed")));
});

test("seedNotesBlock empty -> empty string", () => {
  assert.equal(seedNotesBlock([]), "");
});

test("seedNotesBlock renders a labelled block the agent can read", () => {
  const s = seedNotesBlock(["A completed session exists — open it from /log/past"]);
  assert.match(s, /Pre-seeded state/i);
  assert.match(s, /open it from \/log\/past/);
});
