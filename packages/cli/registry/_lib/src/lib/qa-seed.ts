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
  return `\n\nPre-seeded state — this data already exists. Navigate to it by clicking through the app; any /path mentioned below is the SCREEN to reach by clicking, never a URL to type:\n${lines}`;
}
