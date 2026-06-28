---
title: QA Bible
description: Standard bible format, generate-your-bible workflow, and divide-and-conquer /qa all sweep.
---

The **QA bible** is the per-repo description of your app's route surface. It tells the QA agent where to look, what each area is about, what state a user must be in to reach it, and what to skip. Without a bible the agent explores blindly; with one it fans out by domain and reports coverage.

---

## The two source artifacts

### `qa-map.generated.json` — auto-generated skeleton

Produced by `npm run qa:gen-map`. This file is deterministic and cheap (no LLM). It records every route the extractor finds:

```json
{
  "generatedAt": "2024-11-15T10:00:00.000Z",
  "locales": ["en", "fr", "ar"],
  "routes": [
    { "path": "/", "section": "root", "module": null },
    { "path": "/dashboard", "section": "app", "module": null },
    { "path": "/settings/profile", "section": "app", "module": null }
  ]
}
```

The full JSON Schema is published at [`/gatekit/qa-map.schema.json`](/gatekit/qa-map.schema.json). Commit the generated file — a CI freshness check re-runs the extractor on every PR and fails if the committed copy is stale.

### `qa-map.overlay.ts` — the OWNED semantic layer

Scaffolded once, never overwritten by `gatekit update`. This is where you express meaning:

| Field | Purpose |
|-------|---------|
| `domains` | Logical groupings of routes — each domain becomes one focused agent in a `/qa all` sweep |
| `routePreconditions` | Per-route setup the agent must know before navigating (auth state, feature flags, seed data) |
| `outOfScope` | Routes excluded from coverage counting and agent steering |
| `enabledModules` | Which module prefix sub-trees to include; empty means all |

A minimal overlay with two domains looks like this:

```ts
export const OVERLAY: QaOverlay = {
  domains: [
    {
      key: "auth",
      label: "Authentication",
      routes: ["/login", "/signup", "/forgot-password"],
      preconditions: [],
    },
    {
      key: "dashboard",
      label: "Dashboard & settings",
      routes: ["/dashboard", "/settings/profile", "/settings/billing"],
      preconditions: ["logged-in"],
    },
  ],
  routePreconditions: {
    "/settings/billing": ["logged-in", "org-with-billing"],
  },
  outOfScope: ["/500", "/maintenance"],
  enabledModules: [],
};
```

### Runtime merge → `QaMap`

At runtime `mergeQaMap()` validates the overlay against the generated skeleton and throws on any mismatch (a route renamed without regenerating the map). The merged `QaMap` drives both agent steering and coverage reporting.

---

## `gatekit.json` `qa` config block

Add a `qa` block to your root `gatekit.json` to control how routes are extracted and which model drafts the overlay:

```json
{
  "features": {
    "qa": {
      "enabled": true
    }
  },
  "qa": {
    "routing": "next-pages",
    "pagesDir": "src/pages",
    "localesDir": "public/locales",
    "modulePrefix": "/modules",
    "bibleModel": "anthropic/claude-opus-4",
    "docsForBible": ["docs/architecture.md", "docs/features.md"]
  }
}
```

| Key | Values | Notes |
|-----|--------|-------|
| `routing` | `auto` · `next-pages` · `next-app` · `glob` · `code-router` · `llm` | Extractor strategy for `qa:gen-map` |
| `pagesDir` | path | Used with `next-pages` (default: `"pages"`) |
| `appDir` | path | Used with `next-app` |
| `glob` | glob pattern | Used with `glob` strategy |
| `routerFiles` | file paths | Used with `code-router`: files containing route definitions |
| `pathPattern` | regex | `code-router`: capture group 1 = route path (default `path: "…"`) |
| `exclude` | regexes | `code-router`: drop paths matching any of these |
| `localesDir` | path | Sub-directory names become locale codes |
| `modulePrefix` | path prefix | Routes under this prefix get a module tag |
| `bibleModel` | OpenRouter model slug | Model used by `qa:gen-bible`; defaults to `anthropic/claude-opus-4` |
| `docsForBible` | file paths | Extra context files sent to Opus when drafting the overlay |

### `routing: "auto"` — adaptive detection (recommended starting point)

`auto` is a **one-time bootstrap**. On the first `qa:gen-bible`, Opus analyzes the
stack (`package.json`, file tree, candidate router files) and **rewrites the `qa`
block** in `gatekit.json` to a concrete strategy it detected — which you can review
and tweak. Every subsequent `qa:gen-map` then runs that concrete strategy
deterministically (free, CI-freshness-checked). When no deterministic rule fits an
irregular router, detection persists `routing: "llm"` with the LLM-derived
routes (the freshness gate is skipped for that mode).

### `code-router` — code-defined routers (TanStack, React Router)

For apps whose routes are declared in code rather than the filesystem:

```jsonc
"qa": {
  "routing": "code-router",
  "routerFiles": ["src/presentation/app/router.tsx"],
  "pathPattern": "path:\\s*['\"]([^'\"]+)['\"]",   // default; override if needed
  "exclude": ["^/api", "^/auth"]
}
```

It scans each `routerFiles` entry with `pathPattern` (capture group 1 = the route
path), drops paths matching any `exclude` regex, and derives `section`/`module`
the same way as the other strategies. Deterministic — so the CI freshness check
applies. This is what `auto` resolves to for a TanStack/React-Router app.

---

## Generate-your-bible workflow

### Step 1 — extract routes (free, deterministic)

```bash
npm run qa:gen-map
```

Scans your app and writes `src/lib/qa-map.generated.json`. Commit this file. Rerun it whenever routes change.

### Step 2 — draft the overlay (Opus, one-time)

```bash
OPENROUTER_API_KEY=sk-or-… npm run qa:gen-bible
```

Sends your route list and `gatekit.json` config to **Opus** (via OpenRouter) which reasons about the app's structure and drafts a populated `qa-map.overlay.ts`: real domain groupings, realistic preconditions, and a curated out-of-scope list.

- If no overlay exists yet, the file is written directly.
- If an overlay already exists, the draft is written as `qa-map.overlay.draft.ts` so you can diff and cherry-pick.
- The file is validated and route-checked before write — gatekit will never write a broken bible.

### Step 3 — refine

Review the draft, adjust domain boundaries, add missing preconditions, trim the out-of-scope list. The overlay is **your** file — update it by hand whenever the app's structure changes.

---

## Pre-seeding test data

When your bible's preconditions assume data that must exist (a user session, a completed task, a roster entry), the QA agent cannot reach those routes unless the app is populated first. The **pre-seed hook** lets each shard populate the preview app **once per run**, before exploration begins.

### Owned `qa-seed.ts` contract

Scaffold a one-time `src/qa-seed.ts` in your sentinel:

```ts
import type { SeedFn } from "./lib/qa-seed.js";

export const seed: SeedFn = async (page, ctx) => {
  // page is already authenticated and on the preview.
  // Populate your app (e.g., via page.evaluate + IndexedDB, or drive the UI).
  // Example:
  //   await page.evaluate(() => { /* write to app's IndexedDB */ });
  //   await page.reload();
  return { notes: ["A completed session exists — open it from /log/past"] };
};
```

The `page` is a Playwright `Page` already logged in at the preview URL. The `ctx` contains `baseUrl`, `mode`, `focus` target, and `routes` in scope. Return `notes` — human-readable hints the agent will read in its steering. These notes replace hardcoded preconditions and tell the agent exactly how to navigate to data-dependent routes via the UI (the agent cannot type URLs directly).

### Enable in `gatekit.json`

```json
{
  "qa": {
    "seed": true
  }
}
```

### Execution and resilience

- Runs **once per shard**, immediately after sign-in and before the exploration loop starts.
- If the seed throws, the failure is logged and the run proceeds unseeded — the agent still works, just without the pre-populated data.
- **Gemini safety-policy blocks** (a 400 when the model's action triggers a content filter) are now **skipped, not fatal**. The agent is notified the action was blocked and automatically tries a different approach. The shard continues normally.

---

## `/qa all` — divide-and-conquer sweep

When a bible is present, `/qa all` fans out into a **parallel matrix** of focused agents — one per domain — via GitHub Actions:

1. The gate step reads the domain list and posts a "fanning out" status comment.
2. Each shard job runs a focused agent against its domain's routes using the browser budget for `focus` mode.
3. The aggregate step collects all shard results, merges coverage, and posts a single rollup report with per-domain breakdowns and replay links.

Without a bible, `/qa all` falls back to a single-agent full sweep (same as `/qa` with an extended budget).

The CI freshness check (`qa-map-freshness.yml`) runs on every PR, re-executes `qa:gen-map`, and fails if the committed skeleton differs — so coverage numbers never drift silently after a route rename.

---

## Respecting each project's specifics

The QA engine (workflows, browser driver, report format) is **managed** — `gatekit update` keeps it current. The bible (`qa-map.generated.json`, `qa-map.overlay.ts`, and the `qa` block in `gatekit.json`) is **owned** — update never touches it. This split lets the engine improve without clobbering your domain knowledge.

## Install

```bash
npx gatekit add qa
```

**Required secrets:**

```
GEMINI_API_KEY          # browser agent (all /qa modes)
OPENROUTER_API_KEY      # qa:gen-bible + optional /qa offline probe
```
