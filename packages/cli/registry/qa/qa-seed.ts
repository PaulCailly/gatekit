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
