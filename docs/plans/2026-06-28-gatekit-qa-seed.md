# QA Pre-Seed Scripting + Crash-Resilience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each `/qa all` shard start from a seeded app state (so the agent can reach data-dependent routes) and survive a Gemini safety-block instead of crashing.

**Architecture:** A managed `qa-seed.ts` lib defines the seam (`SeedFn` + an injectable `runSeed`) and a pure `seedNotesBlock`. `qa.ts` runs an optional owned seed after sign-in and appends its notes to the agent's system prompt. A pure `isSafetyBlock` classifier in `gemini.ts` lets the per-turn loop skip a blocked action and continue.

**Tech Stack:** TypeScript, Node 22, ESM, `node:test`. Spec: `docs/specs/2026-06-28-gatekit-qa-seed.md`.

## Global Constraints

- Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"`).
- ESM `.js` import specifiers in source AND tests.
- Registry: managed lib = `_lib/src/lib/`, qa scripts/owned = `qa/`. Scripts import lib via deployed layout `../src/lib/<x>.js`.
- Managed engine logic must be unit-tested with INJECTED fakes — no Playwright/Gemini network in tests.
- After managed-file changes, bump `packages/cli/registry.json` `version`.
- Sentinel tests: `cd packages/cli/registry/_lib && node --import tsx --test 'src/**/*.test.ts'`. Registry-validate: `cd packages/cli && npm test`.

---

### Task 1: `qa-seed.ts` seam — types, `runSeed`, `seedNotesBlock`

**Files:**
- Create: `packages/cli/registry/_lib/src/lib/qa-seed.ts`
- Test: `packages/cli/registry/_lib/src/lib/qa-seed.test.ts`
- Modify: `packages/cli/registry.json` (add `_lib/src/lib/qa-seed.ts` managed)

**Interfaces:**
- Consumes: `QaMode` from `./qa-core.js`; `Page` type from `playwright`.
- Produces: `SeedCtx`, `SeedResult`, `SeedFn`; `runSeed(seedFn, page, ctx, log): Promise<string[]>`; `seedNotesBlock(notes: string[]): string`.

- [ ] **Step 1: Write the failing test** — `qa-seed.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, verify fail** — `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/qa-seed.test.ts'` → FAIL (module not found).

- [ ] **Step 3: Implement `qa-seed.ts`:**

```ts
/**
 * QA pre-seed seam. An optional OWNED `qa-seed.ts` (scaffolded into the consumer)
 * exports a `SeedFn` that populates the preview app with test data BEFORE the
 * agent explores — so data-dependent routes become reachable. The engine runs it
 * via `runSeed` (which never throws) and surfaces the returned `notes` to the
 * agent through `seedNotesBlock`.
 */
import type { Page } from "playwright";
import type { QaMode } from "./qa-core.js";

export interface SeedCtx {
  baseUrl: string;
  mode: QaMode;
  focus: string | null;
  routes: string[];
}
export interface SeedResult {
  notes: string[];
}
export type SeedFn = (page: Page, ctx: SeedCtx) => Promise<SeedResult>;

/** Run an optional owned seed; NEVER throws — a failure degrades to no-op. */
export async function runSeed(
  seedFn: SeedFn | null,
  page: Page,
  ctx: SeedCtx,
  log: (m: string) => void,
): Promise<string[]> {
  if (!seedFn) return [];
  try {
    const { notes } = await seedFn(page, ctx);
    log(`[qa] seed applied: ${notes.length} note(s)`);
    return notes;
  } catch (e) {
    log(`[qa] seed failed (continuing unseeded): ${(e as Error).message}`);
    return [];
  }
}

/** Render seed notes as a labelled system-prompt block (empty string if none). */
export function seedNotesBlock(notes: string[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => `- ${n}`).join("\n");
  return `\n\nPre-seeded state — this data already exists; reach it via the UI (do not type URLs):\n${lines}`;
}
```

- [ ] **Step 4: Run, verify pass.** Then add to `registry.json` `items._lib.files` (before `_lib/package.json`):
```json
{ "src": "_lib/src/lib/qa-seed.ts", "dest": "{sentinel}/src/lib/qa-seed.ts", "type": "managed" },
```

- [ ] **Step 5: Commit** — `git add ...qa-seed.ts ...qa-seed.test.ts ...registry.json && git commit -m "feat(qa): pre-seed seam — runSeed + seedNotesBlock"`

---

### Task 2: `isSafetyBlock` classifier + crash-resilience

**Files:**
- Modify: `packages/cli/registry/_lib/src/lib/gemini.ts` (add `isSafetyBlock`)
- Test: `packages/cli/registry/_lib/src/lib/gemini.test.ts` (create if absent)

**Interfaces:**
- Produces: `isSafetyBlock(err: unknown): boolean` — true when an error/response is a Gemini safety-policy block (the kind that 400s a flagged action), so the loop can skip + continue.

- [ ] **Step 1: Write the failing test** — append/create `gemini.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafetyBlock } from "./gemini.js";

test("isSafetyBlock: true for a 400 safety-policy block (observed shape)", () => {
  const err = new Error(
    "got status: 400. Input blocked: The action to 'Erase all data' involves potential permanent loss of user information and falls under sensitive data management which requires explicit user confirmation.",
  );
  assert.equal(isSafetyBlock(err), true);
});

test("isSafetyBlock: true when status+message split across fields", () => {
  assert.equal(isSafetyBlock({ status: 400, message: "Input blocked under a safety policy" }), true);
});

test("isSafetyBlock: false for an unrelated 500 / network error", () => {
  assert.equal(isSafetyBlock(new Error("got status: 500. internal error")), false);
  assert.equal(isSafetyBlock(new Error("socket hang up")), false);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `isSafetyBlock` in `gemini.ts`** (add near the top-level exports):

```ts
/** True when an error is a Gemini safety-policy block on a flagged action — a 400
 *  whose message indicates the input was blocked under a safety policy. Such a
 *  block must skip the action and continue, not crash the shard. Kept narrow so
 *  genuine errors (auth, 500s, network) still surface. */
export function isSafetyBlock(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  const is400 = status === 400 || /\bstatus:?\s*400\b/i.test(msg);
  const blocked = /input blocked|safety pol(icy|icies)|sensitive data management|blocked by .*safety/i.test(msg);
  return is400 && blocked;
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Wire it into the loop in `qa.ts`** — find the per-turn call that advances the interaction (the `continueInteraction(...)`/`startInteraction(...)` await INSIDE the `for (; turn < budget; turn++)` loop that fetches the next model turn). Wrap THAT call:

```ts
let next;
try {
  next = await continueInteraction(interaction, results, [REPORT_FINDING_TOOL]);
} catch (err) {
  if (isSafetyBlock(err)) {
    core.info(`Turn ${turn}: action blocked by a Gemini safety policy — skipping it and continuing.`);
    // Feed the block back as a function result so the agent picks a different path.
    next = await continueInteraction(
      interaction,
      [...results, { type: "text", text: "That action was blocked by a safety policy. Do not retry it; explore a different part of the app." } as never],
      [REPORT_FINDING_TOOL],
    );
  } else {
    throw err;
  }
}
interaction = next;
```
(Adapt names to the file's actual continuation function + result type. Import `isSafetyBlock` from `../src/lib/gemini.js`. If the retry itself safety-blocks again, the outer loop's normal flow still applies — keep the retry single-shot to avoid a tight loop.)

- [ ] **Step 6: Verify** — sentinel suite green; `cd packages/cli && npm test` green. Bump `registry.json` version.

- [ ] **Step 7: Commit** — `git commit -m "fix(qa): catch Gemini safety-block per turn — skip + continue, don't crash the shard"`

---

### Task 3: Engine seed integration + owned scaffold + config

**Files:**
- Modify: `packages/cli/registry/qa/qa.ts` (run seed after `signIn`; append notes to system prompt)
- Create: `packages/cli/registry/qa/qa-seed.ts` (owned scaffold stub)
- Modify: `packages/cli/registry.json` (add owned `qa/qa-seed.ts` + bump version)

**Interfaces:**
- Consumes: `runSeed`, `seedNotesBlock`, `SeedFn`, `SeedCtx` from `../src/lib/qa-seed.js`.

- [ ] **Step 1: Create the owned scaffold** `packages/cli/registry/qa/qa-seed.ts`:

```ts
/**
 * OWNED — QA pre-seed hook. Scaffolded once; gatekit never overwrites it.
 *
 * Populate the preview app with the test data your bible's preconditions assume,
 * so the QA agent can reach data-dependent routes. You get a Playwright `page`
 * already on the preview and authenticated; do whatever fits your app (inject
 * IndexedDB/localStorage via page.evaluate, or drive the UI), then `page.reload()`.
 * Return `notes` that tell the agent what exists and how to navigate to it.
 *
 * Enable with `"qa": { "seed": true }` in gatekit.json. A throwing seed degrades
 * to no-op (the run proceeds unseeded), so fail loudly here only while developing.
 */
import type { SeedFn } from "./lib/qa-seed.js";

export const seed: SeedFn = async (_page, _ctx) => {
  // Example:
  //   await _page.evaluate(() => { /* write rows into the app's IndexedDB */ });
  //   await _page.reload();
  //   return { notes: ["A completed session exists — open it from /log/past"] };
  return { notes: [] };
};
```

- [ ] **Step 2: Integrate into `qa.ts`** — right AFTER `if (creds) await signIn(page, creds);` (≈ line 403) and BEFORE `const first = await captureState(page);`, insert:

```ts
// Optional owned pre-seed: populate app state so data-dependent routes are
// reachable. Enabled by gatekit.json `qa.seed`; the owned qa-seed.ts is loaded
// dynamically so its absence is fine. Never throws (runSeed swallows failures).
let seedNotes: string[] = [];
if (qaSeedEnabled) {
  const seedFn = await loadOwnedSeed();   // returns SeedFn | null
  const seedCtx: SeedCtx = { baseUrl: targetUrl, mode, focus, routes: routesInScope };
  seedNotes = await runSeed(seedFn, page, seedCtx, (m) => core.info(m));
}
```
Add the import: `import { runSeed, seedNotesBlock, type SeedCtx, type SeedFn } from "../src/lib/qa-seed.js";`

Define `loadOwnedSeed` near the top of qa.ts (dynamic import, guarded):
```ts
async function loadOwnedSeed(): Promise<SeedFn | null> {
  try {
    const mod = (await import("./qa-seed.js")) as { seed?: SeedFn };
    return typeof mod.seed === "function" ? mod.seed : null;
  } catch {
    return null;   // no owned seed present
  }
}
```
Resolve `qaSeedEnabled` from the same gatekit.json `qa` config the run already
reads (the `qa.seed === true` flag); `routesInScope` is the route list the shard
already computes for `focus` (reuse it; fall back to `[]`).

- [ ] **Step 3: Append the seed notes to the system prompt** — where `steering` is built (≈ line 408-414), after computing `steering`, append:
```ts
steering += seedNotesBlock(seedNotes);
```
(So `systemInstruction(mode, scopeLine, creds, memory, steering, prContext)` carries
the seeded-state block — no signature change needed.)

- [ ] **Step 4: Add the owned scaffold to `registry.json`** `items.qa.files` as OWNED:
```json
{ "src": "qa/qa-seed.ts", "dest": "{sentinel}/src/qa-seed.ts", "type": "owned" },
```
Bump `registry.json` version.

- [ ] **Step 5: Verify** — `cd packages/cli/registry/_lib && node --import tsx --test 'src/**/*.test.ts'` green; `cd packages/cli && npm test` green; assemble a `{sentinel}`-shaped temp dir (scripts + src/lib + qa-seed.ts at src/) and `npx tsc --noEmit` over `qa.ts` to confirm the new imports + dynamic import resolve in the deployed layout.

- [ ] **Step 6: Commit** — `git commit -m "feat(qa): run owned pre-seed before exploring + steer the agent with seed notes"`

---

### Task 4: Docs

**Files:**
- Modify: `docs/src/content/docs/gates/qa-bible.md`

- [ ] **Step 1: Document the seed hook** — add a "Pre-seeding test data" section: the owned `qa-seed.ts` contract (`SeedFn`, the `page` is authed + on the preview, return `notes`), enabling via `qa.seed: true`, that it runs per shard after auth, that a failure degrades to no-op, and that the agent still reaches routes via the UI (the notes steer it). Note the safety-block resilience (a blocked action is skipped, not fatal).

- [ ] **Step 2: Build docs** — `cd docs && npm run build` → 0 broken links.

- [ ] **Step 3: Commit** — `git commit -m "docs(qa): document the pre-seed hook + safety-block resilience"`

---

## Rollout (not a gatekit task — execution step)

In atlas: `gatekit add qa` (pull the managed seam + owned scaffold), write the real
`src/qa-seed.ts` that `page.evaluate`-injects atlas's IndexedDB (a completed Running
session, a roster athlete, a profile sport, body metrics — shapes read from
`src/infrastructure/**`), `page.reload()`, return steering notes; set
`gatekit.json` `qa.seed: true`; merge; rerun `/qa all`; confirm the 5 `$param`
routes covered + `user_management` completes.

## Self-Review notes
- **Spec coverage:** §2 seam → Task 1; §4 engine integration → Task 3; §5 crash-resilience → Task 2; §3 scaffold+config → Task 3; §7 testing → Tasks 1-2 tests; §6/§8 atlas+rollout → Rollout section. Covered.
- **Type consistency:** `SeedCtx`/`SeedResult`/`SeedFn`/`runSeed`/`seedNotesBlock`/`isSafetyBlock` consistent across tasks; owned `seed: SeedFn` matches `loadOwnedSeed`'s `{ seed?: SeedFn }`.
- **Deployed-layout:** owned scaffold dest is `{sentinel}/src/qa-seed.ts`; it imports `./lib/qa-seed.js` (managed lib at `{sentinel}/src/lib/`) — matches. qa.ts dynamic-imports `./qa-seed.js` (sibling in `{sentinel}/src/`). Verify with the Task 3 Step 5 tsc.
