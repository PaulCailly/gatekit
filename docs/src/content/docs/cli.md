---
title: CLI Reference
description: repo-harness CLI commands, repo-harness.json schema, and managed/owned update semantics.
---

## Commands

### `init`

Initialises repo-harness in the current directory. Creates a `repo-harness.json` manifest and detects your package manager.

```bash
npx repo-harness init
```

Prompts you to confirm the detected package manager (`npm`, `pnpm`, or `yarn`) and writes the initial manifest.

---

### `add <feature...>`

Vendors one or more features into the repo.

```bash
npx repo-harness add quality
npx repo-harness add quality compliance review
```

For each feature:
- Managed files (workflows, scripts, bot handlers) are copied into `.github/` and `scripts/`.
- Owned files (`config.mjs`, `controls.mjs`, `QA-MEMORY.md`) are scaffolded once and never overwritten on subsequent runs.
- `repo-harness.json` is updated with the feature entry and per-file SHA records.

---

### `update [feature...]`

Pulls the latest managed files from the registry. Owned files are never touched.

```bash
# Update all installed features
npx repo-harness update

# Update a specific feature
npx repo-harness update quality
```

For each managed file:
- If the file on disk matches the SHA in `repo-harness.json` (unedited), the file is overwritten with the new version.
- If the file has been locally edited (SHA mismatch), the new version is placed alongside as `<filename>.harness-new`. You resolve the conflict manually, then remove the `.harness-new` file.

---

### `diff [feature...]`

Shows a diff between the installed managed files and the current registry versions. Owned files are excluded.

```bash
npx repo-harness diff
npx repo-harness diff quality
```

Prints a unified diff to stdout. Exit code 1 if any managed file is out of date (useful in CI).

---

### `list`

Lists all installed features and their status.

```bash
npx repo-harness list
```

Output includes: feature name, enabled/disabled status, mode (`report` or `block`), and the number of managed/owned files.

---

### `remove <feature>`

Removes a feature from the repo. Deletes managed files and removes the feature entry from `repo-harness.json`. Owned files (your policy) are **not** deleted — they remain in the repo.

```bash
npx repo-harness remove quality
```

---

## `repo-harness.json` schema

The manifest lives at the repo root. A `$schema` field points to the published JSON Schema for editor autocompletion.

```json
{
  "$schema": "https://paulcailly.github.io/repo-harness/schema.json",
  "version": "1",
  "packageManager": "pnpm",
  "paths": {
    "scripts": "scripts/sentinel",
    "sentinel": ".github/sentinel"
  },
  "features": {
    "quality": {
      "enabled": true,
      "mode": "report"
    },
    "compliance": {
      "enabled": true,
      "mode": "block"
    }
  },
  "installed": {
    ".github/workflows/quality.yml": {
      "sha": "abc123",
      "type": "managed",
      "version": "1.2.0"
    },
    "scripts/sentinel/health/config.mjs": {
      "sha": "def456",
      "type": "owned"
    }
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Manifest schema version (currently `"1"`) |
| `packageManager` | `"npm"` \| `"pnpm"` \| `"yarn"` | Package manager used in this repo |
| `paths.scripts` | string | Directory where script files are vendored |
| `paths.sentinel` | string | Directory where sentinel/bot files live |
| `features.<name>.enabled` | boolean | Whether the gate is active |
| `features.<name>.mode` | `"report"` \| `"block"` | `report` → annotate PRs but pass; `block` → fail the check |
| `installed.<path>.sha` | string | SHA-256 of the file as installed (for drift detection) |
| `installed.<path>.type` | `"managed"` \| `"owned"` | Managed = updatable engine; owned = your policy, never overwritten |
| `installed.<path>.version` | string | Registry version at install time (managed files only) |

---

## Update semantics

```
managed file, no local edits  →  overwritten with new version
managed file, locally edited  →  new version placed as <file>.harness-new
owned file                    →  never touched (not even read by `update`)
```

After an update that produced `.harness-new` files, run `npx repo-harness diff` to see what changed upstream. Then manually merge the upstream changes from `<file>.harness-new` into your edited file and delete the `.harness-new` file. Finally, update the `sha` for that file in `repo-harness.json` to match the new on-disk content — once the recorded SHA matches the file on disk, `update` will treat it as unmodified and overwrite cleanly on the next run.
