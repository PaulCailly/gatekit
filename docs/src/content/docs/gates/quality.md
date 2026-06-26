---
title: Quality Gate
description: Code-health gate — cyclomatic complexity, LOC, nesting depth, params, and duplication detection.
---

## What it does

The quality gate runs static analysis on every pull request and posts a **sticky Code Quality report** as a PR comment. The report is updated in-place on each new push (no comment spam).

It checks five dimensions:

| Check | What it measures | Default threshold |
|-------|-----------------|-------------------|
| **Cyclomatic complexity** | Number of independent code paths per function | ≤ 10 |
| **Lines of code** | Physical lines per function/method | ≤ 60 |
| **Nesting depth** | Maximum block-nesting level | ≤ 4 |
| **Parameter count** | Number of parameters per function | ≤ 5 |
| **Duplication** | Percentage of duplicated code blocks | ≤ 3% |

Analysis is performed by the `scripts/health/` engine (a Node.js script vendored into your repo). It integrates with your CI via `.github/workflows/quality.yml`.

## Mode semantics

| Mode | Behaviour |
|------|-----------|
| `report` | Gate always passes; violations appear as a PR comment annotation only |
| `block` | Gate fails the CI check if any threshold is exceeded; PR cannot be merged until violations are fixed or thresholds adjusted |

Change the mode in `repo-harness.json`:

```json
{
  "features": {
    "quality": {
      "enabled": true,
      "mode": "block"
    }
  }
}
```

## Owned config

After `add quality`, a stub is scaffolded at `scripts/sentinel/health/config.mjs`. This file is **owned** — `update` never overwrites it.

```js
// scripts/sentinel/health/config.mjs
export default {
  thresholds: {
    cyclomaticComplexity: 10,
    linesOfCode: 60,
    nestingDepth: 4,
    paramCount: 5,
    duplicationPct: 3,
  },
  // Glob patterns to exclude from analysis
  exclude: ['**/*.test.*', '**/*.spec.*', '**/generated/**'],
};
```

Adjust the thresholds and exclusion patterns to match your team's standards. The engine reads this file at runtime, so changes take effect on the next CI run without re-running `update`.

## Sticky PR report

The quality gate posts a single top-level PR comment with a summary table. On each subsequent push to the PR branch, the comment is **edited in place** — the bot finds the existing comment by a hidden marker and updates it. This keeps the PR timeline clean.

Example report structure:

```
## Code Quality Report

| File | Complexity | LOC | Nesting | Params | Duplication |
|------|-----------|-----|---------|--------|-------------|
| src/auth/login.ts | ✅ 6 | ✅ 42 | ✅ 3 | ⚠️ 7 | ✅ 0% |
| src/api/handler.ts | ❌ 14 | ❌ 89 | ✅ 4 | ✅ 3 | ⚠️ 4.2% |

**2 violation(s) found** in 2 file(s).
```

## Install

```bash
npx repo-harness add quality
```

No secrets required — the gate uses only the `GITHUB_TOKEN` automatically provided by GitHub Actions.
