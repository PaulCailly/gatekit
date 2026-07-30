---
title: Bots
description: PR bots — /review, /debate, /qa, and release-notes.
---

## Overview

gatekit ships four bot features that respond to slash commands posted as PR comments. Each bot is a GitHub Actions workflow triggered by `issue_comment` events.

---

## `/review`

Posts an automated LLM code review of the PR diff.

**What it does:** Fetches the PR diff, sends it to an OpenRouter model with a structured code-review prompt, and posts the review as a PR comment. Covers correctness, security, readability, and test coverage gaps.

**Trigger:** Post `/review` (or `/review opus` to use a more capable model) as a PR comment.

**Required secrets:**

```
OPENROUTER_API_KEY
```

**Install:**

```bash
npx @paulcailly/gatekit add review
```

### Ways to fix this

Every `/review` finding includes a **"Ways to fix this"** block with three genuinely-distinct fix approaches:

| Field | Description |
|-------|-------------|
| **Title** | Short name for the strategy (e.g. "Extract helper", "Inline guard", "Redesign interface") |
| **Description** | One-sentence rationale — why this approach fits and what trade-off it carries |
| **Snippet** | Concrete code change illustrating the approach |
| **Copy-as-prompt** | Collapsible block containing a ready-to-paste Claude Code prompt that implements the fix |

The three approaches are **schema-forced**: the LLM receives a strict JSON schema and must return exactly three entries. The review prompt explicitly asks for strategies that differ in kind — not minor variations — so you get at least one conservative fix, one moderate refactor, and one more structural alternative to compare before acting.

---

## `/debate`

Runs a multi-perspective adversarial review — one agent argues for the approach, another argues against it — then synthesises a recommendation.

**What it does:** Two LLM calls with opposing system prompts, followed by a synthesis call. Useful for architectural decisions or large refactors where blind spots matter.

**Trigger:** Post `/debate` as a PR comment.

**Required secrets:**

```
OPENROUTER_API_KEY
```

**Install:**

```bash
npx @paulcailly/gatekit add debate
```

---

## `/qa`

Runs exploratory QA against the PR — generating test scenarios, checking edge cases, and posting a QA report with pass/fail findings.

**What it does:** Uses Gemini to generate QA test scenarios from the PR description and diff, executes checks where possible, and posts a structured QA report. Persistent QA memory (`QA-MEMORY.md`, an owned file) lets the bot accumulate knowledge about your app's quirks across PRs.

**Trigger:** Post `/qa` as a PR comment. Supports focus modes: `/qa focus=auth`, `/qa mobile`, `/qa i18n`, `/qa offline`.

**Required secrets:**

```
GEMINI_API_KEY
OPENROUTER_API_KEY
BLOB_READ_WRITE_TOKEN
BLOB_STORE_ID
```

`BLOB_READ_WRITE_TOKEN` and `BLOB_STORE_ID` are used to persist QA state across runs (Vercel Blob or compatible).

**Owned file:** `QA-MEMORY.md` — scaffolded once, never overwritten. Edit it to give the bot context about your app (tech stack, known flaky areas, testing conventions).

**Install:**

```bash
npx @paulcailly/gatekit add qa
```

---

## `release-notes`

Automatically generates release notes on merge to main (or on tag push) by summarising the commits and PR descriptions since the last release.

**What it does:** On trigger (merge to main or new tag), collects all merged PR titles and descriptions since the last tag, sends them to an LLM, and posts the generated release notes as a GitHub Release or as a comment on the merge commit.

**Trigger:** Automatic — fires on `push` to `main` or on `create` of a tag matching `v*`. No slash command needed.

**Required secrets:**

```
OPENROUTER_API_KEY
```

**Install:**

```bash
npx @paulcailly/gatekit add release-notes
```

---

## Secrets summary

| Feature | `OPENROUTER_API_KEY` | `GEMINI_API_KEY` | `BLOB_READ_WRITE_TOKEN` | `BLOB_STORE_ID` |
|---------|---------------------|-----------------|------------------------|-----------------|
| review | ✅ | — | — | — |
| debate | ✅ | — | — | — |
| qa | ✅ | ✅ | ✅ | ✅ |
| release-notes | ✅ | — | — | — |

Add secrets at: **Settings → Secrets and variables → Actions → New repository secret**.
