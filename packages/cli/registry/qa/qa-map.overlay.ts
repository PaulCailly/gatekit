// ============================================================
// OWNED FILE — scaffolded once, never overwritten by gatekit update.
//
// This file is your team's QA overlay: it maps your app's routes into
// domains, adds per-route preconditions, marks out-of-scope paths,
// and controls which feature modules are tested.
//
// Quick start:
//   1. Run `npm run qa:gen-map`  — scans your routes into
//      src/lib/qa-map.generated.json (also owned, commit it).
//   2. Run `npm run qa:gen-bible` — calls Opus to draft this overlay
//      from your routes + gatekit.json qa config.  Review and commit.
//   3. Refine by hand whenever routes change or coverage drifts.
//
// gatekit.json qa config block (add to your repo root gatekit.json):
//
//   "qa": {
//     "routing": "next-pages",   // next-pages | next-app | glob | opus-infer
//     "pagesDir":   "src/pages", // for next-pages (default: "pages")
//     "appDir":     "app",       // for next-app
//     "localesDir": "public/locales", // optional; sub-dirs = locale codes
//     "modulePrefix": "/modules", // routes under this prefix get a module tag
//     "bibleModel": "anthropic/claude-opus-4", // OpenRouter model for gen-bible
//     "docsForBible": ["docs/architecture.md"] // extra context for Opus
//   }
//
// After Opus drafts this file you will see filled-in domains, realistic
// preconditions, and a curated out-of-scope list.  The empty defaults
// below are valid for a cold start (zero domains = full coverage scan).
// ============================================================

import type { QaOverlay } from "./qa-map.js";

export const OVERLAY: QaOverlay = {
  /**
   * Logical test domains grouping related routes.
   * Each domain gets its own coverage breakdown in QA reports.
   *
   * Example:
   *   { key: "auth",    label: "Authentication",  routes: ["/login", "/signup"], preconditions: [] },
   *   { key: "profile", label: "User profile",    routes: ["/profile/:id"],      preconditions: ["logged-in"] },
   */
  domains: [],

  /**
   * Per-route preconditions (login state, feature flags, seed data…).
   * The agent receives these before navigating to the route.
   *
   * Example:
   *   "/dashboard": ["logged-in", "org-with-billing"],
   *   "/admin":     ["logged-in", "admin-role"],
   */
  routePreconditions: {},

  /**
   * Routes excluded from coverage counting and agent steering.
   * Typical candidates: maintenance pages, API proxy routes, redirects.
   *
   * Example: ["/500", "/maintenance", "/api/:path*"]
   */
  outOfScope: [],

  /**
   * Module keys (second path segment under modulePrefix) to include in
   * coverage.  Leave empty to include ALL modules.
   *
   * Example: ["billing", "analytics"]
   */
  enabledModules: [],
};
