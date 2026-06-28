# gatekit QA — pre-seed scripting + shard crash-resilience

**Date:** 2026-06-28
**Status:** Design (approved)
**Repo:** gatekit (`PaulCailly/gatekit`, local `~/repo-harness`) + atlas (consumer)
**Branch:** `feat/qa-seed`

## 1. Problem & goal

`/qa all` fans out one computer-use agent per bible domain. Data-dependent routes
are unreachable because the agent (a) cannot type URLs (`navigate` is excluded) and
(b) cannot reliably build the prerequisite state from scratch within budget. On
atlas, the 5 parametrized routes stayed uncovered even at 120 turns, capping
coverage at 16/22 (73%). A second gap: a shard **crashes** when a model action hits
a Gemini safety-400 (e.g. atlas's *"Erase all data"*), losing that whole domain.

**Goal:** let each shard start from a **seeded app state** (so the agent can reach
data-dependent routes by clicking into pre-existing entities), and make a single
blocked action **not kill the shard** — so atlas's `/qa all` can approach 22/22.

**Non-goals:** changing the divide-and-conquer runtime; a gatekit-provided data
model (each repo owns its seed); seeding server-side state for server-backed apps
(the seam supports it, but atlas seeds client IndexedDB).

## 2. The seam (managed, in the qa lib)

New types (in `_lib/src/lib/qa-seed.ts`, a new managed lib file):
```ts
import type { Page } from "playwright";
import type { QaMode } from "./qa-core.js";

export interface SeedCtx {
  baseUrl: string;        // the resolved preview origin
  mode: QaMode;           // "focus" for /qa all shards
  focus: string | null;   // the domain key this shard runs
  routes: string[];       // route paths in scope for this shard
}
export interface SeedResult { notes: string[]; }   // steering hints for the agent
export type SeedFn = (page: Page, ctx: SeedCtx) => Promise<SeedResult>;

/** Run an optional owned seed; never throws — a seed failure degrades to no-op. */
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
```
`runSeed` is the unit-testable core (inject a fake `seedFn`). The owned `qa-seed.ts`
(below) provides the real `SeedFn`; `qa.ts` imports it dynamically so its absence is
fine.

## 3. Owned scaffold + config

- **Owned `qa-seed.ts`** (scaffolded once into `{sentinel}/src/lib/qa-seed.ts`, never
  clobbered): exports `export const seed: SeedFn = async (page, ctx) => ({ notes: [] });`
  with a banner comment explaining the contract + an example. Each repo fills it in.
- **Config** (owned, `gatekit.json` `qa` block): `"seed": true` to enable. Default
  off. When on but the owned file still returns `{ notes: [] }`, it's a harmless
  no-op.

## 4. Engine integration (`qa.ts`, managed)

After `signIn(...)` and after the preview is loaded, **before the exploration loop**,
for each shard:
1. Build `SeedCtx` from the run (baseUrl, mode, focus, the shard's routes).
2. Resolve the owned seed: dynamic `import("./lib/qa-seed.js")` guarded by
   `existsSync` + the `qa.seed` config flag; `null` if absent/disabled.
3. `const seedNotes = await runSeed(seedFn, page, ctx, log)`.
4. Append `seedNotes` to the agent's **system prompt** under a clear header
   ("Pre-seeded state — already present, reach it via the UI:") so the agent knows
   what exists and how to navigate in.

## 5. Shard crash-resilience (managed)

In the model-call path (`lib/gemini.ts` / the per-turn loop in `qa.ts`), a Gemini
**safety-block 400** (the response/error indicating a blocked action under a safety
policy) must be **caught per-turn**: log it as an info-level note, **skip that
action, and continue the loop** (optionally nudge the agent: "that action was
blocked by a safety policy — try a different path"). It must NOT propagate and fail
the shard. (Distinct from the existing client-side `isDestructiveIntent` guard,
which blocks before the call; this handles the server-side 400 that currently
escapes.)

## 6. atlas implementation (owned `qa-seed.ts`)

Via `page.evaluate`, open atlas's IndexedDB and inject the minimum to light up the
5 routes, then `page.reload()` so the app reads it:
- **A completed Running training session** → `/log/past` lists it → opening it
  reaches `/session/$sessionId`, and its Edit reaches `/session/$sessionId/edit`.
- **A roster athlete** (coach mode) → `/coach` → opening them reaches
  `/students/$studentId`.
- **Profile with a selected sport** → `/log/$sportId` + `/log/live/$sportId`.
- **Body metrics** → `/body` has data.

The exact store names, key paths, and row shapes come from atlas's persistence layer
(`src/infrastructure/**` / the IndexedDB seam). Per atlas CLAUDE.md §5, stored shapes
are a public API — the seed writes the same shapes the app reads. `notes` steer the
agent: *"A completed Running session exists — open it from /log/past. An athlete is in
your roster — open them from /coach. A sport is selected — open it from /log."*

Set atlas `gatekit.json` `qa.seed: true`.

## 7. Testing

- **`qa-seed.test.ts`** (managed, node:test): `runSeed` returns the fake's notes;
  `runSeed` with a throwing `seedFn` returns `[]` and logs (no throw); `runSeed(null)`
  returns `[]`.
- **crash-resilience** (managed): a unit over the safety-400 handler — given a
  blocked-action error, the loop helper returns a "skip + continue" outcome rather
  than throwing. (Pure helper extracted so it's testable without Playwright/Gemini.)
- **Registry validation**: the new managed `qa-seed.ts` + owned scaffold + their
  registry entries resolve; deployed-layout tsc over the scripts/lib.
- **atlas seed**: validated by the real `/qa all` run — success = the 5 `$param`
  routes covered + `user_management` completes.

## 8. Rollout

Ship in gatekit (bump registry version). In atlas: `gatekit add qa` (or copy) to get
the managed seam + scaffold, write the real `qa-seed.ts`, set `qa.seed: true`, merge,
rerun `/qa all`, measure coverage (target 22/22, `user_management` no longer crashing).

## 9. Risks

- **Schema coupling** — atlas's seed writes IndexedDB shapes; a schema change breaks
  it. Mitigation: it's owned + lives beside the app; CLAUDE.md §5 already treats
  shapes as a contract. A failed seed degrades to no-op (run still proceeds unseeded).
- **Agent still may not click in** — seeding makes the route *reachable*; the agent
  must still navigate. The `notes` steer it; if a route is still missed it's an
  exploration gap, not a reachability one (and far cheaper to close).
- **Safety-400 shapes vary** — the catch must match the actual error/response signal;
  pin it from the failed run's log and keep the match narrow so real errors still
  surface.
