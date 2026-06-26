# repo-harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `repo-harness` — a shadcn-style CLI + registry that vendors the quality/compliance gate tooling into consumer repos (managed engine, owned policy), plus a Starlight docs site, then roll it out to `featers/monorepo` and the `featers/backresto` main app.

**Architecture:** A public repo `PaulCailly/repo-harness` holds (1) a `registry/` of gate "components" extracted from `atlas`, described by `registry.json`; (2) `packages/cli/` — a TS→JS npm package `repo-harness` that copies registry files into a consumer, tracking each in a `repo-harness.json` manifest with a `managed` (overwrite on update) / `owned` (scaffold-once) split; (3) `docs/` — an Astro Starlight site deployed to GitHub Pages. Consumers run `npx repo-harness add <feature>`.

**Tech Stack:** Node 22, TypeScript (CLI, compiled to ESM JS, no framework), zero-dependency `.mjs` analyzer engines (carried verbatim from atlas), `node:test` + `tsx` for tests, Astro Starlight for docs, GitHub Actions for CI/release/Pages.

## Global Constraints

- Node 22 everywhere (`actions/setup-node` `node-version: 22`).
- Analyzer engines stay **zero-dependency `.mjs`** — never add deps to them, never convert to TS.
- CLI is **TypeScript, no TUI framework** (no Ink). Arg parsing hand-rolled or `commander` only.
- CLI module type is ESM (`"type": "module"`); build target ES2022 / NodeNext, matching the sentinel `tsconfig.json`.
- The registry is **bundled inside the npm tarball**; CLI version **==** registry version (semver). No network/git fetch at `add`/`update` time.
- **`owned` files are never overwritten.** `add` writes an owned file only if absent; `update` never touches owned files.
- **`managed` files are overwritten on `update` only if unedited** (consumer sha == recorded sha); an edited managed file produces a `<file>.harness-new` and a conflict report, never a clobber.
- Default enforcement is **`mode: "report"`** for every gate → workflow runs the engine with `--no-fail`.
- Repo is **public under `PaulCailly`**; no secrets or private per-repo policy ship in the registry (policies live in consumer repos as `owned` files).
- Path tokens `{scripts}` and `{sentinel}` in `registry.json` resolve from the consumer `repo-harness.json` `paths`.
- Spec: `docs/specs/2026-06-27-repo-harness-design.md` (source of truth).

---

## File Structure

```
repo-harness/
  registry.json                       # manifest of all items (Task 11)
  registry/
    quality/{index,analyze}.mjs        # managed engine (Task 11)
    quality/config.mjs                 # owned template (Task 11)
    quality/quality-report.ts          # managed report (Task 11)
    quality/quality-gate.yml           # workflow (Task 11)
    compliance/{index,analyze}.mjs     # managed engine (Task 12)
    compliance/{config,controls}.mjs   # owned templates (Task 12)
    compliance/{compliance-report,compliance-review}.ts
    compliance/{compliance-gate,compliance}.yml
    review/review.ts + code-review.yml          # (Task 13)
    debate/debate.ts + debate.yml                # (Task 13)
    qa/qa.ts + QA-MEMORY.md(owned) + qa.yml      # (Task 13)
    release-notes/release-notes.ts + release.yml # (Task 13)
    _lib/**                            # shared sentinel lib + package.json + tsconfig (Task 13)
  packages/cli/
    package.json  tsconfig.json
    src/
      index.ts        # argv dispatch (Task 1)
      detect.ts       # package-manager + paths detection (Task 2)
      manifest.ts     # repo-harness.json read/write + sha + token resolve (Task 3)
      registry.ts     # load bundled registry.json + read item files (Task 4)
      commands/init.ts add.ts update.ts diff.ts list.ts remove.ts (Tasks 5-10)
    test/             # node:test specs alongside (Tasks 1-10)
    test/fixtures/registry/   # tiny fake registry for CLI tests (Task 4)
  docs/               # Astro Starlight (Task 17)
  .github/workflows/ci.yml release.yml docs.yml   # (Tasks 16-17)
```

---

### Task 1: Scaffold CLI package + argv dispatcher

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Test: `packages/cli/test/index.test.ts`

**Interfaces:**
- Produces: `run(argv: string[]): Promise<number>` — the dispatcher, exported from `src/index.ts`; returns a process exit code. Unknown/`--help` prints usage and returns `0`; `--version` prints the package version and returns `0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/index.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.ts";

test("--version returns 0", async () => {
  assert.equal(await run(["--version"]), 0);
});

test("unknown command prints usage and returns 0", async () => {
  assert.equal(await run(["wat"]), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npm test`
Expected: FAIL — `Cannot find module '../src/index.ts'`.

- [ ] **Step 3: Create package + tsconfig + dispatcher**

```jsonc
// packages/cli/package.json
{
  "name": "repo-harness",
  "version": "0.0.0",
  "type": "module",
  "bin": { "repo-harness": "dist/index.js" },
  "files": ["dist", "registry", "registry.json"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node --import tsx --test 'test/**/*.test.ts'"
  },
  "devDependencies": { "@types/node": "^25.9.3", "tsx": "^4.22.4", "typescript": "^5.9.3" }
}
```

```jsonc
// packages/cli/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "outDir": "dist", "types": ["node"], "rootDir": "src"
  },
  "include": ["src"]
}
```

```ts
// packages/cli/src/index.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const USAGE = `repo-harness <command>

  init                 create repo-harness.json
  add <feature...>     vendor a gate into this repo
  update [feature...]  update managed engine files
  diff [feature...]    show what update would change
  list                 show installed features + drift
  remove <feature>     remove a feature's managed files
`;

const COMMANDS = new Set(["init", "add", "update", "diff", "list", "remove"]);

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version") {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    console.log(pkg.version);
    return 0;
  }
  if (!cmd || !COMMANDS.has(cmd)) {
    console.log(USAGE);
    return 0;
  }
  const mod = await import(`./commands/${cmd}.ts`);
  return mod.default(rest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((c) => process.exit(c));
}
```

Note: the dynamic `import('./commands/${cmd}.ts')` resolves to `.js` after build; keep the literal `.ts` so `tsx` runs sources in tests and `tsc` rewrites the extension. If a runtime extension mismatch appears, switch the dispatch to a static `switch` importing each command module — acceptable and simpler.

- [ ] **Step 4: Make `--version`/usage pass without command modules**

The two tests only exercise `--version` and unknown-command paths, which never import a command module — they pass now. Run: `cd packages/cli && npm install && npm test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): scaffold repo-harness package + argv dispatcher"
```

---

### Task 2: Package-manager + paths detection (`detect.ts`)

**Files:**
- Create: `packages/cli/src/detect.ts`
- Test: `packages/cli/test/detect.test.ts`

**Interfaces:**
- Produces: `detect(cwd: string): { packageManager: "yarn"|"pnpm"|"npm"; paths: { scripts: string; sentinel: string } }`. Detection: `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm. `paths.scripts` = `"scripts"` always; `paths.sentinel` = `".github/sentinel"` always (overridable later by the user editing `repo-harness.json`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/detect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../src/detect.ts";

async function tmp() { return mkdtemp(join(tmpdir(), "rh-")); }

test("detects yarn from yarn.lock", async () => {
  const d = await tmp();
  await writeFile(join(d, "yarn.lock"), "");
  assert.equal(detect(d).packageManager, "yarn");
});

test("detects pnpm from pnpm-lock.yaml", async () => {
  const d = await tmp();
  await writeFile(join(d, "pnpm-lock.yaml"), "");
  assert.equal(detect(d).packageManager, "pnpm");
});

test("defaults to npm and standard paths", async () => {
  const d = await tmp();
  const r = detect(d);
  assert.equal(r.packageManager, "npm");
  assert.deepEqual(r.paths, { scripts: "scripts", sentinel: ".github/sentinel" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/detect.test.ts` (or `npm test`)
Expected: FAIL — `Cannot find module '../src/detect.ts'`.

- [ ] **Step 3: Implement `detect.ts`**

```ts
// packages/cli/src/detect.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Detected {
  packageManager: "yarn" | "pnpm" | "npm";
  paths: { scripts: string; sentinel: string };
}

export function detect(cwd: string): Detected {
  const has = (f: string) => existsSync(join(cwd, f));
  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  return { packageManager, paths: { scripts: "scripts", sentinel: ".github/sentinel" } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/detect.ts packages/cli/test/detect.test.ts
git commit -m "feat(cli): package-manager + paths detection"
```

---

### Task 3: Manifest read/write + sha + token resolution (`manifest.ts`)

**Files:**
- Create: `packages/cli/src/manifest.ts`
- Test: `packages/cli/test/manifest.test.ts`

**Interfaces:**
- Produces:
  - `interface Manifest { $schema: string; version: string; packageManager: string; paths: { scripts: string; sentinel: string }; features: Record<string, { enabled: boolean; mode?: "report"|"block" }>; installed: Record<string, { sha: string; type: "managed"|"owned"; version: string }> }`
  - `readManifest(cwd): Manifest | null`
  - `writeManifest(cwd, m: Manifest): void`
  - `sha(content: string): string` — sha256 hex of the bytes.
  - `resolveDest(dest: string, paths): string` — replaces `{scripts}` / `{sentinel}` tokens.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/manifest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest, sha, resolveDest } from "../src/manifest.ts";

test("sha is stable", () => {
  assert.equal(sha("a"), sha("a"));
  assert.notEqual(sha("a"), sha("b"));
});

test("resolveDest substitutes tokens", () => {
  const p = { scripts: "src/scripts", sentinel: ".github/sentinel" };
  assert.equal(resolveDest("{scripts}/health/index.mjs", p), "src/scripts/health/index.mjs");
  assert.equal(resolveDest("{sentinel}/src/review.ts", p), ".github/sentinel/src/review.ts");
});

test("round-trips a manifest", async () => {
  const d = await mkdtemp(join(tmpdir(), "rh-"));
  const m = {
    $schema: "x", version: "1.0.0", packageManager: "yarn",
    paths: { scripts: "scripts", sentinel: ".github/sentinel" },
    features: { quality: { enabled: true, mode: "report" as const } },
    installed: {},
  };
  writeManifest(d, m);
  assert.deepEqual(readManifest(d), m);
});

test("readManifest returns null when absent", async () => {
  const d = await mkdtemp(join(tmpdir(), "rh-"));
  assert.equal(readManifest(d), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/manifest.ts'`.

- [ ] **Step 3: Implement `manifest.ts`**

```ts
// packages/cli/src/manifest.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Manifest {
  $schema: string;
  version: string;
  packageManager: string;
  paths: { scripts: string; sentinel: string };
  features: Record<string, { enabled: boolean; mode?: "report" | "block" }>;
  installed: Record<string, { sha: string; type: "managed" | "owned"; version: string }>;
}

const FILE = "repo-harness.json";

export function readManifest(cwd: string): Manifest | null {
  const p = join(cwd, FILE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Manifest) : null;
}

export function writeManifest(cwd: string, m: Manifest): void {
  writeFileSync(join(cwd, FILE), JSON.stringify(m, null, 2) + "\n");
}

export function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function resolveDest(dest: string, paths: Manifest["paths"]): string {
  return dest.replace("{scripts}", paths.scripts).replace("{sentinel}", paths.sentinel);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/manifest.ts packages/cli/test/manifest.test.ts
git commit -m "feat(cli): repo-harness.json manifest + sha + token resolution"
```

---

### Task 4: Registry loader (`registry.ts`) + test fixture registry

**Files:**
- Create: `packages/cli/src/registry.ts`
- Create: `packages/cli/test/fixtures/registry/registry.json`
- Create: `packages/cli/test/fixtures/registry/demo/engine.mjs`
- Create: `packages/cli/test/fixtures/registry/demo/policy.mjs`
- Test: `packages/cli/test/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface FileSpec { src: string; dest: string; type: "managed"|"owned"; mode?: string }`
  - `interface Item { description: string; dependsOn?: string[]; files: FileSpec[]; workflows?: FileSpec[]; scripts?: Record<string,string>; secrets?: string[] }`
  - `interface Registry { version: string; items: Record<string, Item> }`
  - `loadRegistry(root: string): Registry` — reads `<root>/registry.json`.
  - `readItemFile(root: string, src: string): string` — reads `<root>/registry/<src>`.
  - `resolveDeps(reg: Registry, names: string[]): string[]` — topologically expands `dependsOn`, deduped, deps before dependents. Throws on unknown name or cycle.
  - `registryRoot(): string` — the bundled registry dir (package root), `fileURLToPath(new URL("..", import.meta.url))` from `dist/`. In tests, callers pass an explicit root instead.

- [ ] **Step 1: Write the failing test + fixtures**

```jsonc
// packages/cli/test/fixtures/registry/registry.json
{
  "version": "9.9.9",
  "items": {
    "demo": {
      "description": "demo gate",
      "files": [
        { "src": "demo/engine.mjs", "dest": "{scripts}/demo/engine.mjs", "type": "managed" },
        { "src": "demo/policy.mjs", "dest": "{scripts}/demo/policy.mjs", "type": "owned" }
      ]
    },
    "needsdemo": { "description": "depends on demo", "dependsOn": ["demo"], "files": [] }
  }
}
```

```js
// packages/cli/test/fixtures/registry/demo/engine.mjs
export const engine = "v1";
```
```js
// packages/cli/test/fixtures/registry/demo/policy.mjs
export const policy = {};
```

```ts
// packages/cli/test/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadRegistry, readItemFile, resolveDeps } from "../src/registry.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));

test("loads registry.json", () => {
  assert.equal(loadRegistry(ROOT).version, "9.9.9");
});

test("reads an item file", () => {
  assert.match(readItemFile(ROOT, "demo/engine.mjs"), /engine = "v1"/);
});

test("resolveDeps puts deps before dependents", () => {
  const reg = loadRegistry(ROOT);
  assert.deepEqual(resolveDeps(reg, ["needsdemo"]), ["demo", "needsdemo"]);
});

test("resolveDeps throws on unknown", () => {
  const reg = loadRegistry(ROOT);
  assert.throws(() => resolveDeps(reg, ["nope"]), /unknown feature/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/registry.ts'`.

- [ ] **Step 3: Implement `registry.ts`**

```ts
// packages/cli/src/registry.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FileSpec { src: string; dest: string; type: "managed" | "owned"; mode?: string }
export interface Item {
  description: string; dependsOn?: string[]; files: FileSpec[];
  workflows?: FileSpec[]; scripts?: Record<string, string>; secrets?: string[];
}
export interface Registry { version: string; items: Record<string, Item> }

export function registryRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url)); // package root (dist/ -> ..)
}
export function loadRegistry(root: string): Registry {
  return JSON.parse(readFileSync(join(root, "registry.json"), "utf8")) as Registry;
}
export function readItemFile(root: string, src: string): string {
  return readFileSync(join(root, "registry", src), "utf8");
}

export function resolveDeps(reg: Registry, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    if (stack.has(name)) throw new Error(`dependency cycle at ${name}`);
    const item = reg.items[name];
    if (!item) throw new Error(`unknown feature: ${name}`);
    stack.add(name);
    for (const dep of item.dependsOn ?? []) visit(dep);
    stack.delete(name);
    seen.add(name);
    out.push(name);
  };
  for (const n of names) visit(n);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/registry.ts packages/cli/test/registry.test.ts packages/cli/test/fixtures
git commit -m "feat(cli): registry loader + dependency resolution"
```

---

### Task 5: `init` command

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/init.test.ts`

**Interfaces:**
- Consumes: `detect` (Task 2), `Manifest`/`writeManifest`/`readManifest` (Task 3), `registryRoot`/`loadRegistry` (Task 4).
- Produces: `default(args: string[]): Promise<number>` — writes a `repo-harness.json` in `process.cwd()` with all registry features present and `enabled:false`, version = registry version. Idempotent: if a manifest exists, prints a notice and returns `0` without overwriting.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/init.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import init from "../src/commands/init.ts";
import { readManifest } from "../src/manifest.ts";

async function inDir(fn: () => Promise<void>) {
  const d = await mkdtemp(join(tmpdir(), "rh-"));
  const prev = process.cwd();
  process.chdir(d);
  try { await fn(); } finally { process.chdir(prev); }
  return d;
}

test("init writes a manifest with features disabled", async () => {
  await inDir(async () => {
    await writeFile("yarn.lock", "");
    assert.equal(await init([]), 0);
    const m = readManifest(process.cwd())!;
    assert.equal(m.packageManager, "yarn");
    assert.ok("compliance" in m.features);
    assert.equal(m.features.compliance.enabled, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/commands/init.ts'`.

- [ ] **Step 3: Implement `init.ts`**

```ts
// packages/cli/src/commands/init.ts
import { detect } from "../detect.ts";
import { readManifest, writeManifest, type Manifest } from "../manifest.ts";
import { loadRegistry, registryRoot } from "../registry.ts";

const SCHEMA = "https://paulcailly.github.io/repo-harness/schema.json";

export default async function init(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  if (readManifest(cwd)) {
    console.log("repo-harness.json already exists — leaving it untouched.");
    return 0;
  }
  const { packageManager, paths } = detect(cwd);
  const reg = loadRegistry(registryRoot());
  const features: Manifest["features"] = {};
  for (const name of Object.keys(reg.items)) {
    if (name.startsWith("_")) continue; // _lib is a dependency, not a user feature
    features[name] = { enabled: false, mode: "report" };
  }
  writeManifest(cwd, {
    $schema: SCHEMA, version: reg.version, packageManager, paths, features, installed: {},
  });
  console.log(`Wrote repo-harness.json (registry ${reg.version}, ${packageManager}).`);
  console.log("Next: npx repo-harness add <feature>");
  return 0;
}
```

Note: `init` reads the **bundled** registry via `registryRoot()`. CLI unit tests for `init` rely on the real `registry.json` existing at the package root — Tasks 11-13 create it. Until then this test will fail at `loadRegistry`. **Sequencing:** implement Tasks 5-10 against the fixture-injected root by adding an optional `root` param? No — keep `init` simple. Instead, create a minimal real `registry.json` (empty `items: {}`) at package root in Task 1's commit if needed. **Action:** in Step 3 above also create `packages/cli/registry.json` = `{"version":"0.0.0","items":{}}` so `init` resolves; Tasks 11-13 replace it. Add `assert.ok("compliance" in m.features)` only after Task 12 — for now assert `m.features` is an object and `compliance` assertion is added in Task 12's test. Adjust the test to `assert.equal(typeof m.features, "object")` for this task.

- [ ] **Step 4: Create stub registry + run test**

Create `packages/cli/registry.json`:
```json
{ "version": "0.0.0", "items": {} }
```
Run: `npm test`
Expected: PASS (with the `typeof m.features === "object"` assertion).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/init.test.ts packages/cli/registry.json
git commit -m "feat(cli): init command"
```

---

### Task 6: `add` command (the core)

**Files:**
- Create: `packages/cli/src/commands/add.ts`
- Create: `packages/cli/src/apply.ts` (shared file-application helper)
- Test: `packages/cli/test/add.test.ts`

**Interfaces:**
- Consumes: registry loader + `resolveDeps` (Task 4), manifest + `sha` + `resolveDest` (Task 3).
- Produces:
  - In `apply.ts`: `applyFile(opts: { root: string; cwd: string; spec: FileSpec; paths; version: string; manifest: Manifest }): { dest: string; action: "wrote"|"skipped-owned"|"overwrote" }` — copies one registry file. `managed`: write + record sha. `owned`: write **only if the dest does not exist**; either way record sha of whatever is on disk. Creates parent dirs.
  - In `add.ts`: `default(args: string[]): Promise<number>` — expands deps, applies every file + workflow of each requested feature, sets `features[name].enabled = true` (skips `_`-prefixed), bumps `manifest.version` to registry version, writes manifest, prints required secrets and follow-ups.

- [ ] **Step 1: Write the failing test** (uses the fixture registry from Task 4)

```ts
// packages/cli/test/add.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFile } from "../src/apply.ts";
import { loadRegistry } from "../src/registry.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));
const PATHS = { scripts: "scripts", sentinel: ".github/sentinel" };

test("applyFile writes a managed file and records sha", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  const reg = loadRegistry(ROOT);
  const manifest: any = { installed: {} };
  const spec = reg.items.demo.files[0]; // managed engine.mjs
  const r = applyFile({ root: ROOT, cwd, spec, paths: PATHS, version: "9.9.9", manifest });
  assert.equal(r.action, "wrote");
  assert.ok(existsSync(join(cwd, "scripts/demo/engine.mjs")));
  assert.equal(manifest.installed["scripts/demo/engine.mjs"].type, "managed");
});

test("applyFile never overwrites an existing owned file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/policy.mjs"), "MINE");
  const reg = loadRegistry(ROOT);
  const manifest: any = { installed: {} };
  const spec = reg.items.demo.files[1]; // owned policy.mjs
  const r = applyFile({ root: ROOT, cwd, spec, paths: PATHS, version: "9.9.9", manifest });
  assert.equal(r.action, "skipped-owned");
  assert.equal(await readFile(join(cwd, "scripts/demo/policy.mjs"), "utf8"), "MINE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/apply.ts'`.

- [ ] **Step 3: Implement `apply.ts` then `add.ts`**

```ts
// packages/cli/src/apply.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readItemFile, type FileSpec } from "./registry.ts";
import { sha, resolveDest, type Manifest } from "./manifest.ts";

export function applyFile(opts: {
  root: string; cwd: string; spec: FileSpec;
  paths: Manifest["paths"]; version: string; manifest: Manifest;
}): { dest: string; action: "wrote" | "skipped-owned" | "overwrote" } {
  const { root, cwd, spec, paths, version, manifest } = opts;
  const rel = resolveDest(spec.dest, paths);
  const abs = join(cwd, rel);
  const upstream = readItemFile(root, spec.src);
  let action: "wrote" | "skipped-owned" | "overwrote" = "wrote";
  if (spec.type === "owned" && existsSync(abs)) {
    action = "skipped-owned";
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) action = "overwrote";
    writeFileSync(abs, upstream);
  }
  const onDisk = readFileSync(abs, "utf8");
  manifest.installed[rel] = { sha: sha(onDisk), type: spec.type, version };
  return { dest: rel, action };
}
```

```ts
// packages/cli/src/commands/add.ts
import { readManifest, writeManifest } from "../manifest.ts";
import { loadRegistry, registryRoot, resolveDeps } from "../registry.ts";
import { applyFile } from "../apply.ts";

export default async function add(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  if (args.length === 0) { console.error("Usage: repo-harness add <feature...>"); return 1; }

  const root = registryRoot();
  const reg = loadRegistry(root);
  let order: string[];
  try { order = resolveDeps(reg, args); }
  catch (e) { console.error(String((e as Error).message)); return 1; }

  const secrets = new Set<string>();
  for (const name of order) {
    const item = reg.items[name];
    for (const spec of [...item.files, ...(item.workflows ?? [])]) {
      const r = applyFile({ root, cwd, spec, paths: manifest.paths, version: reg.version, manifest });
      console.log(`  ${r.action.padEnd(14)} ${r.dest}`);
    }
    for (const s of item.secrets ?? []) secrets.add(s);
    if (!name.startsWith("_")) {
      manifest.features[name] = { ...(manifest.features[name] ?? {}), enabled: true,
        mode: manifest.features[name]?.mode ?? "report" };
    }
  }
  manifest.version = reg.version;
  writeManifest(cwd, manifest);

  console.log(`\nAdded: ${args.join(", ")}`);
  if (secrets.size) console.log(`Set these repo secrets: ${[...secrets].join(", ")}`);
  console.log("Owned policy files (config.mjs/controls.mjs) are stubs — fill them in.");
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/apply.ts packages/cli/src/commands/add.ts packages/cli/test/add.test.ts
git commit -m "feat(cli): add command (managed copy + owned scaffold-once + deps)"
```

---

### Task 7: `update` command

**Files:**
- Create: `packages/cli/src/commands/update.ts`
- Test: `packages/cli/test/update.test.ts`

**Interfaces:**
- Consumes: `applyFile` is **not** reused here (different semantics). Uses `readItemFile`, `sha`, `resolveDest`, manifest.
- Produces: `default(args: string[]): Promise<number>` — for every installed **managed** file of the targeted features (default: all enabled): read upstream; if on-disk sha == recorded sha → overwrite, update recorded sha+version; if on-disk sha != recorded sha (consumer edited) → write upstream to `<dest>.harness-new`, print a conflict line, leave the original. **owned** files: never touched (report if the upstream template changed). Also exposes `classify(cwd, manifest, reg): Array<{ dest, state }>` where state ∈ `"up-to-date"|"update-available"|"locally-modified"|"owned"` for reuse by `diff`/`list`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/update.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../src/commands/update.ts";
import { loadRegistry } from "../src/registry.ts";
import { sha } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));
const PATHS = { scripts: "scripts", sentinel: ".github/sentinel" };

test("classify flags a locally-modified managed file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "EDITED BY USER");
  const reg = loadRegistry(ROOT);
  const manifest: any = {
    paths: PATHS,
    installed: { "scripts/demo/engine.mjs": { sha: sha("export const engine = \"v0\";"), type: "managed", version: "0" } },
  };
  const rows = classify(ROOT, cwd, manifest, reg);
  const row = rows.find((r) => r.dest === "scripts/demo/engine.mjs")!;
  assert.equal(row.state, "locally-modified");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/commands/update.ts'`.

- [ ] **Step 3: Implement `update.ts`**

```ts
// packages/cli/src/commands/update.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest, sha, resolveDest, type Manifest } from "../manifest.ts";
import { loadRegistry, registryRoot, readItemFile, type Registry } from "../registry.ts";

type State = "up-to-date" | "update-available" | "locally-modified" | "owned";

/** Map every installed file to its update state vs the registry. */
export function classify(root: string, cwd: string, manifest: Manifest, reg: Registry):
  Array<{ dest: string; state: State; src?: string }> {
  // Build dest -> src/type from the registry for resolution.
  const byDest = new Map<string, { src: string; type: "managed" | "owned" }>();
  for (const item of Object.values(reg.items))
    for (const f of [...item.files, ...(item.workflows ?? [])])
      byDest.set(resolveDest(f.dest, manifest.paths), { src: f.src, type: f.type });

  const rows: Array<{ dest: string; state: State; src?: string }> = [];
  for (const [dest, rec] of Object.entries(manifest.installed)) {
    const meta = byDest.get(dest);
    if (rec.type === "owned") { rows.push({ dest, state: "owned", src: meta?.src }); continue; }
    const abs = join(cwd, dest);
    const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const upstream = meta ? readItemFile(root, meta.src) : "";
    if (sha(onDisk) !== rec.sha) rows.push({ dest, state: "locally-modified", src: meta?.src });
    else if (sha(upstream) !== rec.sha) rows.push({ dest, state: "update-available", src: meta?.src });
    else rows.push({ dest, state: "up-to-date", src: meta?.src });
  }
  return rows;
}

export default async function update(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const root = registryRoot();
  const reg = loadRegistry(root);
  let conflicts = 0;
  for (const row of classify(root, cwd, manifest, reg)) {
    if (row.state === "owned" || row.state === "up-to-date") continue;
    const abs = join(cwd, row.dest);
    const upstream = readItemFile(root, row.src!);
    if (row.state === "update-available") {
      writeFileSync(abs, upstream);
      manifest.installed[row.dest] = { sha: sha(upstream), type: "managed", version: reg.version };
      console.log(`  updated   ${row.dest}`);
    } else {
      writeFileSync(`${abs}.harness-new`, upstream);
      conflicts++;
      console.log(`  CONFLICT  ${row.dest} (edited locally; upstream written to ${row.dest}.harness-new)`);
    }
  }
  manifest.version = reg.version;
  writeManifest(cwd, manifest);
  if (conflicts) console.log(`\n${conflicts} locally-modified file(s) need a manual merge.`);
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/update.ts packages/cli/test/update.test.ts
git commit -m "feat(cli): update command with drift detection + conflict guard"
```

---

### Task 8: `diff` command

**Files:**
- Create: `packages/cli/src/commands/diff.ts`
- Test: `packages/cli/test/diff.test.ts`

**Interfaces:**
- Consumes: `classify` (Task 7), manifest + registry loaders.
- Produces: `default(args: string[]): Promise<number>` — prints each installed file's state (from `classify`) without writing anything; returns `0`. Returns `2` if any `update-available` or `locally-modified` rows exist (so CI can detect drift). Exposes nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/diff.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import diff from "../src/commands/diff.ts";
import { writeManifest, sha } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));

test("diff returns 2 when an engine update is available", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  // On-disk file equals recorded sha (unedited) but recorded sha is stale vs upstream.
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "OLD");
  writeManifest(cwd, {
    $schema: "x", version: "0", packageManager: "npm",
    paths: { scripts: "scripts", sentinel: ".github/sentinel" },
    features: {}, installed: { "scripts/demo/engine.mjs": { sha: sha("OLD"), type: "managed", version: "0" } },
  });
  const prev = process.cwd(); process.chdir(cwd);
  try {
    process.env.REPO_HARNESS_ROOT = ROOT; // diff honors override for tests
    assert.equal(await diff([]), 2);
  } finally { process.chdir(prev); delete process.env.REPO_HARNESS_ROOT; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/commands/diff.ts'`.

- [ ] **Step 3: Implement `diff.ts` + add the test override to `registryRoot`**

In `src/registry.ts`, make `registryRoot()` honor a test override (one-line change):
```ts
export function registryRoot(): string {
  if (process.env.REPO_HARNESS_ROOT) return process.env.REPO_HARNESS_ROOT;
  return fileURLToPath(new URL("..", import.meta.url));
}
```

```ts
// packages/cli/src/commands/diff.ts
import { readManifest } from "../manifest.ts";
import { loadRegistry, registryRoot } from "../registry.ts";
import { classify } from "./update.ts";

export default async function diff(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const root = registryRoot();
  const rows = classify(root, cwd, manifest, loadRegistry(root));
  let drift = 0;
  for (const r of rows) {
    console.log(`  ${r.state.padEnd(18)} ${r.dest}`);
    if (r.state === "update-available" || r.state === "locally-modified") drift++;
  }
  return drift ? 2 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/diff.ts packages/cli/src/registry.ts packages/cli/test/diff.test.ts
git commit -m "feat(cli): diff command (drift report, exit 2 on drift)"
```

---

### Task 9: `list` command

**Files:**
- Create: `packages/cli/src/commands/list.ts`
- Test: `packages/cli/test/list.test.ts`

**Interfaces:**
- Consumes: manifest, registry, `classify` (Task 7).
- Produces: `default(args: string[]): Promise<number>` — prints a table: feature, enabled, mode, synced version, and a per-feature drift count derived from `classify`. Returns `0`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/list.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import list from "../src/commands/list.ts";
import { writeManifest } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));

test("list returns 0 and runs against a manifest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  writeManifest(cwd, {
    $schema: "x", version: "9.9.9", packageManager: "npm",
    paths: { scripts: "scripts", sentinel: ".github/sentinel" },
    features: { demo: { enabled: true, mode: "report" } }, installed: {},
  });
  const prev = process.cwd(); process.chdir(cwd);
  try { process.env.REPO_HARNESS_ROOT = ROOT; assert.equal(await list([]), 0); }
  finally { process.chdir(prev); delete process.env.REPO_HARNESS_ROOT; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/commands/list.ts'`.

- [ ] **Step 3: Implement `list.ts`**

```ts
// packages/cli/src/commands/list.ts
import { readManifest } from "../manifest.ts";
import { loadRegistry, registryRoot } from "../registry.ts";
import { classify } from "./update.ts";

export default async function list(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const root = registryRoot();
  const rows = classify(root, cwd, manifest, loadRegistry(root));
  const drift = rows.filter((r) => r.state === "update-available" || r.state === "locally-modified").length;
  console.log(`registry synced: ${manifest.version}   drifted files: ${drift}\n`);
  for (const [name, f] of Object.entries(manifest.features)) {
    console.log(`  ${name.padEnd(14)} ${f.enabled ? "on " : "off"}  ${f.mode ?? "-"}`);
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/list.ts packages/cli/test/list.test.ts
git commit -m "feat(cli): list command"
```

---

### Task 10: `remove` command

**Files:**
- Create: `packages/cli/src/commands/remove.ts`
- Test: `packages/cli/test/remove.test.ts`

**Interfaces:**
- Consumes: manifest, registry, `resolveDest`.
- Produces: `default(args: string[]): Promise<number>` — for the named feature, delete its **managed** files + workflows from disk and from `installed`; **leave owned files** in place with a warning; set `features[name].enabled = false`. Does not remove `_lib` (shared) even if depended-on. Returns `1` on unknown feature.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/remove.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import remove from "../src/commands/remove.ts";
import { writeManifest, readManifest, sha } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));

test("remove deletes managed but keeps owned", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "E");
  await writeFile(join(cwd, "scripts/demo/policy.mjs"), "P");
  writeManifest(cwd, {
    $schema: "x", version: "9.9.9", packageManager: "npm",
    paths: { scripts: "scripts", sentinel: ".github/sentinel" },
    features: { demo: { enabled: true, mode: "report" } },
    installed: {
      "scripts/demo/engine.mjs": { sha: sha("E"), type: "managed", version: "9.9.9" },
      "scripts/demo/policy.mjs": { sha: sha("P"), type: "owned", version: "9.9.9" },
    },
  });
  const prev = process.cwd(); process.chdir(cwd);
  try {
    process.env.REPO_HARNESS_ROOT = ROOT;
    assert.equal(await remove(["demo"]), 0);
    assert.equal(existsSync(join(cwd, "scripts/demo/engine.mjs")), false);
    assert.equal(existsSync(join(cwd, "scripts/demo/policy.mjs")), true);
    assert.equal(readManifest(cwd)!.features.demo.enabled, false);
  } finally { process.chdir(prev); delete process.env.REPO_HARNESS_ROOT; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/commands/remove.ts'`.

- [ ] **Step 3: Implement `remove.ts`**

```ts
// packages/cli/src/commands/remove.ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest, resolveDest } from "../manifest.ts";
import { loadRegistry, registryRoot } from "../registry.ts";

export default async function remove(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const name = args[0];
  const reg = loadRegistry(registryRoot());
  const item = reg.items[name];
  if (!item) { console.error(`unknown feature: ${name}`); return 1; }

  for (const spec of [...item.files, ...(item.workflows ?? [])]) {
    const rel = resolveDest(spec.dest, manifest.paths);
    if (spec.type === "owned") { console.log(`  kept (owned)  ${rel}`); continue; }
    const abs = join(cwd, rel);
    if (existsSync(abs)) rmSync(abs);
    delete manifest.installed[rel];
    console.log(`  removed       ${rel}`);
  }
  if (manifest.features[name]) manifest.features[name].enabled = false;
  writeManifest(cwd, manifest);
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/remove.ts packages/cli/test/remove.test.ts
git commit -m "feat(cli): remove command (managed only; owned preserved)"
```

---

### Task 11: Extract the `quality` registry item

**Files:**
- Create: `registry/quality/index.mjs` (copy of `~/atlas/scripts/health/index.mjs`)
- Create: `registry/quality/analyze.mjs` (copy of `~/atlas/scripts/health/analyze.mjs`)
- Create: `registry/quality/config.mjs` (owned template — see Step 1)
- Create: `registry/quality/quality-report.ts` (copy of `~/atlas/.github/sentinel/src/quality-report.ts`)
- Create: `registry/quality/quality-gate.yml` (new workflow — see Step 2)
- Modify: `packages/cli/registry.json` (add the `quality` item; bump version to `0.1.0`)
- Test: `packages/cli/test/registry-validate.test.ts` (Task 14 creates it; this task adds the `quality` rows it validates)

**Interfaces:**
- Produces: registry item `quality` with managed engine (`{scripts}/health/index.mjs`, `analyze.mjs`), managed report (`{sentinel}/src/quality-report.ts`), owned `{scripts}/health/config.mjs`, workflow `quality-gate.yml`. `dependsOn: ["_lib"]`.

- [ ] **Step 1: Copy the engine + write the owned config template**

```bash
mkdir -p registry/quality
cp ~/atlas/scripts/health/index.mjs   registry/quality/index.mjs
cp ~/atlas/scripts/health/analyze.mjs registry/quality/analyze.mjs
cp ~/atlas/.github/sentinel/src/quality-report.ts registry/quality/quality-report.ts
```
Create `registry/quality/config.mjs` from `~/atlas/scripts/health/config.mjs` **with the comment header changed** to mark it a template a consumer owns. Keep the thresholds identical (they are stack-agnostic): cyclomatic/functionLoc/nesting/params/fileLoc/duplication/bands and `include: /\.(ts|tsx)$/`, `exclude: /(\.test\.|\.spec\.|\.d\.ts$)/`. Prepend:
```js
/**
 * OWNED FILE — repo-harness scaffolds this once; edit freely. Tune the thresholds
 * to your repo. The analyzer engine (index.mjs/analyze.mjs) is managed by
 * repo-harness and updated via `npx repo-harness update`.
 */
```

- [ ] **Step 2: Write the `quality-gate.yml` workflow**

```yaml
# registry/quality/quality-gate.yml
# Code-health gate — deterministic, dependency-free. Scores src/ and posts a
# sticky "Code Quality" PR comment. Informational by default (never blocks);
# set features.quality.mode = "block" in repo-harness.json to fail on regressions.
name: Quality gate
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Code-health metrics
        run: node scripts/health/index.mjs src --json .health/health.json | tee -a "$GITHUB_STEP_SUMMARY"
      - name: Install report deps
        working-directory: .github/sentinel
        run: npm ci --no-audit --no-fund
      - name: Code quality report
        working-directory: .github/sentinel
        run: npm run quality-report
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HEALTH_REPORT_DIR: ${{ github.workspace }}/.health
          COVERAGE_SUMMARY: ${{ github.workspace }}/coverage/coverage-summary.json
```
Note: the report tolerates a missing `COVERAGE_SUMMARY` (it reads `process.env.COVERAGE_SUMMARY ?? "coverage/coverage-summary.json"` and degrades) — so this works on repos without vitest coverage. Coverage wiring stays per-repo and is **not** shipped here (Global Constraint: stack-agnostic quality by default).

- [ ] **Step 3: Add the `quality` item to `registry.json`**

```jsonc
// packages/cli/registry.json — replace the stub
{
  "version": "0.1.0",
  "items": {
    "_lib": { "description": "shared sentinel lib", "files": [] },
    "quality": {
      "description": "Code-health gate + sticky Code Quality PR report",
      "dependsOn": ["_lib"],
      "files": [
        { "src": "quality/index.mjs",   "dest": "{scripts}/health/index.mjs",   "type": "managed" },
        { "src": "quality/analyze.mjs",  "dest": "{scripts}/health/analyze.mjs",  "type": "managed" },
        { "src": "quality/config.mjs",   "dest": "{scripts}/health/config.mjs",   "type": "owned" },
        { "src": "quality/quality-report.ts", "dest": "{sentinel}/src/quality-report.ts", "type": "managed" }
      ],
      "workflows": [
        { "src": "quality/quality-gate.yml", "dest": ".github/workflows/quality-gate.yml", "type": "managed", "mode": "gate" }
      ]
    }
  }
}
```
The registry under `registry/` lives at the repo root, but the CLI package needs it bundled. **Build step (added in Task 16):** the `release`/`ci` build copies the root `registry/` + `registry.json` into `packages/cli/` before publish. For local dev, symlink or copy: `cp -r registry registry.json packages/cli/`. Keep `packages/cli/registry.json` as the canonical edited copy and have a root-level `registry/` of files; OR keep everything under `packages/cli/`. **Decision (lock it):** put `registry/` and `registry.json` **inside `packages/cli/`** so no copy step is needed; the repo-root paths in this plan become `packages/cli/registry/...`. Update all `cp` destinations accordingly.

- [ ] **Step 4: Verify the copied engine still self-tests**

```bash
cp ~/atlas/scripts/health/analyze.test.mjs packages/cli/registry/quality/analyze.test.mjs
node --test packages/cli/registry/quality/analyze.test.mjs
```
Expected: PASS (atlas's own health analyzer suite, unchanged). Keep this file in the registry dir but exclude it from `files` (it is not vendored into consumers).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/registry packages/cli/registry.json
git commit -m "feat(registry): extract quality (code-health) gate from atlas"
```

---

### Task 12: Extract the `compliance` registry item

**Files:**
- Create: `packages/cli/registry/compliance/{index,analyze}.mjs` (copies of atlas `scripts/compliance/{index,analyze}.mjs`)
- Create: `packages/cli/registry/compliance/{config,controls}.mjs` (owned templates)
- Create: `packages/cli/registry/compliance/{compliance-report,compliance-review}.ts` (copies of atlas sentinel files)
- Create: `packages/cli/registry/compliance/{compliance-gate,compliance}.yml`
- Create: `packages/cli/registry/compliance/analyze.test.mjs` (copy; self-test only)
- Modify: `packages/cli/registry.json` (add `compliance`; bump to `0.2.0`)
- Test: extends `registry-validate.test.ts`

**Interfaces:**
- Produces: registry item `compliance`, `dependsOn: ["_lib"]`, secrets `["OPENROUTER_API_KEY"]`, managed engine + reports, owned `config.mjs`/`controls.mjs`, workflows `compliance-gate.yml` (blocking/report PR gate) + `compliance.yml` (`/compliance` audit).

- [ ] **Step 1: Copy engine + reports + self-test**

```bash
mkdir -p packages/cli/registry/compliance
cp ~/atlas/scripts/compliance/index.mjs        packages/cli/registry/compliance/index.mjs
cp ~/atlas/scripts/compliance/analyze.mjs       packages/cli/registry/compliance/analyze.mjs
cp ~/atlas/scripts/compliance/analyze.test.mjs  packages/cli/registry/compliance/analyze.test.mjs
cp ~/atlas/.github/sentinel/src/compliance-report.ts  packages/cli/registry/compliance/compliance-report.ts
cp ~/atlas/.github/sentinel/src/compliance-review.ts  packages/cli/registry/compliance/compliance-review.ts
```

- [ ] **Step 2: Write the owned `config.mjs` + `controls.mjs` templates**

Base them on `~/work/featers-monorepo/scripts/compliance/{config,controls}.mjs` (already a *generic* port, not atlas-specific) rather than atlas's app-specific policy. Reduce to a **minimal starter**: keep the structure and comments, but trim the allowlist to an empty array with one worked example comment, keep `secretPatterns` (universal), set `roots: ['src']`, and replace `structuralChecks` with `[]`. Prepend the OWNED-FILE banner (as in Task 11 Step 1). `controls.mjs` ships a minimal register skeleton (one example control) with a banner instructing the consumer to fill it.

- [ ] **Step 3: Copy the two workflows, generalized**

```bash
cp ~/work/featers-monorepo/.github/workflows/compliance-gate.yml packages/cli/registry/compliance/compliance-gate.yml
cp ~/atlas/.github/workflows/compliance-review.yml packages/cli/registry/compliance/compliance.yml
```
Edit `compliance-gate.yml`: keep it dependency-free Node; ensure the run line is `node scripts/compliance/index.mjs --json .compliance/compliance.json` and add a commented `--no-fail` note. Edit `compliance.yml`: strip atlas-specific `FONTAWESOME_NPM_AUTH_TOKEN` / pnpm install steps; the audit only needs Node 22 + `.github/sentinel` `npm ci` + `npm run compliance-review` with `GITHUB_TOKEN` + `OPENROUTER_API_KEY` + `COMPLIANCE_REPORT` env. (The deterministic grounding step `node scripts/compliance/index.mjs pr-head --json ... --no-fail` stays.)

- [ ] **Step 4: Add `compliance` to `registry.json` + verify self-test**

```jsonc
"compliance": {
  "description": "Privacy & compliance gate (egress/secret/telemetry) + /compliance audit",
  "dependsOn": ["_lib"],
  "secrets": ["OPENROUTER_API_KEY"],
  "files": [
    { "src": "compliance/index.mjs",   "dest": "{scripts}/compliance/index.mjs",   "type": "managed" },
    { "src": "compliance/analyze.mjs",  "dest": "{scripts}/compliance/analyze.mjs",  "type": "managed" },
    { "src": "compliance/config.mjs",   "dest": "{scripts}/compliance/config.mjs",   "type": "owned" },
    { "src": "compliance/controls.mjs", "dest": "{scripts}/compliance/controls.mjs", "type": "owned" },
    { "src": "compliance/compliance-report.ts", "dest": "{sentinel}/src/compliance-report.ts", "type": "managed" },
    { "src": "compliance/compliance-review.ts", "dest": "{sentinel}/src/compliance-review.ts", "type": "managed" }
  ],
  "workflows": [
    { "src": "compliance/compliance-gate.yml", "dest": ".github/workflows/compliance-gate.yml", "type": "managed", "mode": "gate" },
    { "src": "compliance/compliance.yml",      "dest": ".github/workflows/compliance.yml",      "type": "managed" }
  ]
}
```
Bump `"version": "0.2.0"`. Run: `node --test packages/cli/registry/compliance/analyze.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/registry packages/cli/registry.json
git commit -m "feat(registry): extract compliance gate + /compliance audit from atlas"
```

---

### Task 13: Extract `_lib`, `review`, `debate`, `qa`, `release-notes`

**Files:**
- Create: `packages/cli/registry/_lib/**` (copy of `~/atlas/.github/sentinel/src/lib/**`, excluding `*.test.ts`) + `packages/cli/registry/_lib/package.json` + `tsconfig.json` (copies of atlas sentinel's)
- Create: `packages/cli/registry/review/review.ts` + `code-review.yml`
- Create: `packages/cli/registry/debate/debate.ts` + `debate.yml`
- Create: `packages/cli/registry/qa/qa.ts` + `QA-MEMORY.md` (owned) + `qa.yml`
- Create: `packages/cli/registry/release-notes/release-notes.ts` + `release.yml`
- Modify: `packages/cli/registry.json` (flesh out `_lib`; add the four bot items; bump to `0.3.0`)

**Interfaces:**
- Produces: `_lib` item with all shared lib files + sentinel `package.json`/`tsconfig.json` as managed, dest under `{sentinel}/`. Each bot item `dependsOn: ["_lib"]`, ships its `*.ts` (managed) under `{sentinel}/src/` + its workflow. `review`/`debate` secrets `["OPENROUTER_API_KEY"]`; `qa` secrets `["GEMINI_API_KEY","OPENROUTER_API_KEY","BLOB_READ_WRITE_TOKEN","BLOB_STORE_ID"]`; `qa` owns `QA-MEMORY.md`.

- [ ] **Step 1: Copy lib + bot sources + workflows**

```bash
mkdir -p packages/cli/registry/_lib/src/lib
cp ~/atlas/.github/sentinel/src/lib/*.ts packages/cli/registry/_lib/src/lib/
rm -f packages/cli/registry/_lib/src/lib/*.test.ts          # tests not vendored
cp ~/atlas/.github/sentinel/package.json  packages/cli/registry/_lib/package.json
cp ~/atlas/.github/sentinel/tsconfig.json packages/cli/registry/_lib/tsconfig.json
for b in review debate qa release-notes; do mkdir -p packages/cli/registry/$b; done
cp ~/atlas/.github/sentinel/src/review.ts        packages/cli/registry/review/review.ts
cp ~/atlas/.github/sentinel/src/debate.ts        packages/cli/registry/debate/debate.ts
cp ~/atlas/.github/sentinel/src/qa.ts            packages/cli/registry/qa/qa.ts
cp ~/atlas/.github/sentinel/QA-MEMORY.md         packages/cli/registry/qa/QA-MEMORY.md
cp ~/atlas/.github/sentinel/src/release-notes.ts packages/cli/registry/release-notes/release-notes.ts
cp ~/atlas/.github/workflows/code-review.yml packages/cli/registry/review/code-review.yml
cp ~/atlas/.github/workflows/debate.yml      packages/cli/registry/debate/debate.yml
cp ~/atlas/.github/workflows/qa.yml          packages/cli/registry/qa/qa.yml
cp ~/atlas/.github/workflows/release.yml     packages/cli/registry/release-notes/release.yml
```

- [ ] **Step 2: Generalize the workflows**

In each copied workflow, remove atlas-specific install steps (`FONTAWESOME_NPM_AUTH_TOKEN`, pnpm-only setup) that the bots don't need — the bots run from `.github/sentinel` with `npm ci`. Keep the `issue_comment` trigger + `if: startsWith(comment.body, '/review'|'/debate'|'/qa')` gating and the secret env wiring verbatim. Leave app-specific `qa.yml` login secrets (`QA_LOGIN_PHONE`/`QA_LOGIN_OTP`) as `${{ secrets.* }}` references (owned per repo).

- [ ] **Step 3: Build `_lib` file list + add bot items to `registry.json`**

Enumerate each lib file explicitly into `_lib.files` with `dest: "{sentinel}/src/lib/<name>.ts"` (managed), plus `{ "src": "_lib/package.json", "dest": "{sentinel}/package.json", "type": "managed" }` and the tsconfig. Add:
```jsonc
"review":  { "description": "/review multi-model PR review", "dependsOn": ["_lib"], "secrets": ["OPENROUTER_API_KEY"],
  "files": [{ "src": "review/review.ts", "dest": "{sentinel}/src/review.ts", "type": "managed" }],
  "workflows": [{ "src": "review/code-review.yml", "dest": ".github/workflows/code-review.yml", "type": "managed" }] },
"debate":  { "description": "/debate two-model PR debate", "dependsOn": ["_lib"], "secrets": ["OPENROUTER_API_KEY"],
  "files": [{ "src": "debate/debate.ts", "dest": "{sentinel}/src/debate.ts", "type": "managed" }],
  "workflows": [{ "src": "debate/debate.yml", "dest": ".github/workflows/debate.yml", "type": "managed" }] },
"qa":      { "description": "/qa exploratory computer-use QA", "dependsOn": ["_lib"],
  "secrets": ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID"],
  "files": [
    { "src": "qa/qa.ts", "dest": "{sentinel}/src/qa.ts", "type": "managed" },
    { "src": "qa/QA-MEMORY.md", "dest": "{sentinel}/QA-MEMORY.md", "type": "owned" }],
  "workflows": [{ "src": "qa/qa.yml", "dest": ".github/workflows/qa.yml", "type": "managed" }] },
"release-notes": { "description": "AI release notes on tag", "dependsOn": ["_lib"],
  "files": [{ "src": "release-notes/release-notes.ts", "dest": "{sentinel}/src/release-notes.ts", "type": "managed" }],
  "workflows": [{ "src": "release-notes/release.yml", "dest": ".github/workflows/release.yml", "type": "managed" }] }
```
Bump `"version": "0.3.0"`.

- [ ] **Step 4: Type-check the vendored sentinel sources compile**

```bash
cd packages/cli/registry/_lib && npm i && npx tsc -p tsconfig.json && cd -
```
Expected: no type errors (the lib + bots are atlas's, already type-clean). If `tsconfig.json` `include` is `["src"]`, temporarily copy the bot `.ts` files next to `_lib/src/` for the check, or run `npx tsc --noEmit` over a combined dir. PASS = bots compile against the lib.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/registry packages/cli/registry.json
git commit -m "feat(registry): extract _lib + review/debate/qa/release-notes bots"
```

---

### Task 14: Registry validation test

**Files:**
- Create: `packages/cli/test/registry-validate.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `resolveDeps`, `readItemFile` (Task 4), against the **real** bundled `registry.json`.

- [ ] **Step 1: Write the test**

```ts
// packages/cli/test/registry-validate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, resolveDeps } from "../src/registry.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // packages/cli

test("every registry file src exists on disk", () => {
  const reg = loadRegistry(ROOT);
  for (const [name, item] of Object.entries(reg.items)) {
    for (const f of [...item.files, ...(item.workflows ?? [])]) {
      assert.ok(existsSync(join(ROOT, "registry", f.src)), `${name}: missing ${f.src}`);
      assert.match(f.dest, /^(\{scripts\}|\{sentinel\}|\.github)\//, `${name}: bad dest ${f.dest}`);
      assert.ok(["managed", "owned"].includes(f.type), `${name}: bad type`);
    }
  }
});

test("dependency graph resolves for every feature", () => {
  const reg = loadRegistry(ROOT);
  for (const name of Object.keys(reg.items)) {
    assert.doesNotThrow(() => resolveDeps(reg, [name]));
  }
});

test("expected features are present", () => {
  const reg = loadRegistry(ROOT);
  for (const f of ["quality", "compliance", "review", "debate", "qa", "release-notes", "_lib"])
    assert.ok(f in reg.items, `missing ${f}`);
});
```

- [ ] **Step 2: Run test to verify it passes** (registry is fully populated after Task 13)

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/registry-validate.test.ts
git commit -m "test(registry): validate every item's files, deps, and dests"
```

---

### Task 15: End-to-end golden test (`add` into a fixture repo)

**Files:**
- Create: `packages/cli/test/e2e.test.ts`

**Interfaces:**
- Consumes: `init` + `add` against the real bundled registry.

- [ ] **Step 1: Write the test**

```ts
// packages/cli/test/e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import init from "../src/commands/init.ts";
import add from "../src/commands/add.ts";
import { readManifest } from "../src/manifest.ts";

test("init + add quality compliance produces the expected tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-e2e-"));
  const prev = process.cwd(); process.chdir(cwd);
  try {
    await writeFile("yarn.lock", "");
    assert.equal(await init([]), 0);
    assert.equal(await add(["quality", "compliance"]), 0);
    for (const f of [
      "scripts/health/index.mjs", "scripts/health/config.mjs",
      "scripts/compliance/index.mjs", "scripts/compliance/config.mjs",
      ".github/sentinel/src/quality-report.ts",
      ".github/workflows/quality-gate.yml", ".github/workflows/compliance-gate.yml",
      ".github/sentinel/src/lib/openrouter.ts", // pulled via _lib
    ]) assert.ok(existsSync(join(cwd, f)), `missing ${f}`);
    const m = readManifest(cwd)!;
    assert.equal(m.features.compliance.enabled, true);
    assert.equal(m.installed["scripts/compliance/config.mjs"].type, "owned");
  } finally { process.chdir(prev); }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS — exercises deps (`_lib`), managed copy, owned scaffold, workflows.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e.test.ts
git commit -m "test(cli): end-to-end add quality+compliance golden"
```

---

### Task 16: Repo CI + npm release workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `packages/cli/.npmignore` (publish `dist` + `registry` + `registry.json` only)

**Interfaces:** none (infra).

- [ ] **Step 1: Write `ci.yml`**

```yaml
# .github/workflows/ci.yml
name: CI
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  cli:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: packages/cli } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npm run build
      - run: npm test
```

- [ ] **Step 2: Write `release.yml`** (publishes on a `v*` tag)

```yaml
# .github/workflows/release.yml
name: Release
on: { push: { tags: ['v*'] } }
permissions: { contents: write, id-token: write }
jobs:
  publish:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: packages/cli } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: npm install
      - run: npm run build
      - run: npm test
      - run: npm version --no-git-tag-version "${GITHUB_REF_NAME#v}"
      - run: npm publish --provenance --access public
        env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }
      - uses: softprops/action-gh-release@v2
```

- [ ] **Step 3: Verify build + test locally**

Run: `cd packages/cli && npm install && npm run build && npm test`
Expected: build emits `dist/`, all suites PASS. Confirm `package.json` `files` includes `registry` + `registry.json` so they ship in the tarball: `npm pack --dry-run` lists them.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml packages/cli/.npmignore
git commit -m "ci: build/test CLI + tag-driven npm publish"
```

---

### Task 17: Docs site (Astro Starlight → GitHub Pages)

**Files:**
- Create: `docs/` (Astro Starlight project)
- Create: `docs/src/content/docs/{index.mdx, cli.md, gates/quality.md, gates/compliance.md, gates/bots.md, policy-authoring.md}`
- Create: `.github/workflows/docs.yml`
- Create: `docs/public/schema.json` (the `repo-harness.json` JSON Schema)

**Interfaces:** none (docs). Site base path `/repo-harness`.

- [ ] **Step 1: Scaffold Starlight**

```bash
npm create astro@latest docs -- --template starlight --no-install --no-git --yes
```
Set `astro.config.mjs`: `site: "https://paulcailly.github.io"`, `base: "/repo-harness"`, Starlight `title: "repo-harness"`, sidebar linking the pages below.

- [ ] **Step 2: Write the content pages**

- `index.mdx` — the copy-paste-drift problem + shadcn model + `npx repo-harness init` quickstart.
- `cli.md` — `init/add/update/diff/list/remove`, each with an example + the `repo-harness.json` shape.
- `gates/quality.md`, `gates/compliance.md`, `gates/bots.md` — per-gate: what it checks, required secrets, `mode: report|block`, copy-paste `npx repo-harness add <feature>`.
- `policy-authoring.md` — how to write `compliance/config.mjs` (egress allowlist, server-only secrets, telemetry seam, structural checks) + `controls.mjs`, using atlas + monorepo as worked examples.
- `public/schema.json` — JSON Schema for `repo-harness.json` (the `$schema` target).

- [ ] **Step 3: Write `docs.yml`**

```yaml
# .github/workflows/docs.yml
name: Docs
on: { push: { branches: [main], paths: ['docs/**', '.github/workflows/docs.yml'] } }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: docs } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: docs/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deploy.outputs.page_url }} }
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Build the site locally**

Run: `cd docs && npm install && npm run build`
Expected: `docs/dist/` produced, no broken-link errors.

- [ ] **Step 5: Commit**

```bash
git add docs .github/workflows/docs.yml
git commit -m "docs: Starlight site + GitHub Pages deploy"
```

After pushing: enable Pages (Settings → Pages → Source: GitHub Actions) — a one-time manual repo setting.

---

### Task 18: Roll out to `featers/monorepo` (reconcile existing port)

**Files (in `~/work/featers-monorepo`):**
- Create: `repo-harness.json`
- Modify/add: register existing `scripts/compliance/*` + add `scripts/health/*` via the CLI.

**Interfaces:** uses the built CLI (`node ~/repo-harness/packages/cli/dist/index.js` or `npx repo-harness@latest` once published).

- [ ] **Step 1: Init + inspect**

```bash
cd ~/work/featers-monorepo
node ~/repo-harness/packages/cli/dist/index.js init
node ~/repo-harness/packages/cli/dist/index.js list
```
Confirm `repo-harness.json` detects `pnpm` and standard paths. Expected: features all `off` initially.

- [ ] **Step 2: Reconcile compliance (already present)**

The repo already has `scripts/compliance/{index,analyze,config,controls}.mjs` + `compliance-gate.yml` + `compliance.yml`. Run `add compliance`; because `config.mjs`/`controls.mjs` exist they are **kept (owned)**; `index.mjs`/`analyze.mjs` are overwritten with the registry engine (verify they were identical first with `diff`):
```bash
node ~/repo-harness/packages/cli/dist/index.js add compliance
node ~/repo-harness/packages/cli/dist/index.js diff
git -C ~/work/featers-monorepo diff --stat
```
Expected: owned policy untouched; engine files match (no behavioral change); workflows match or are updated to the harness templates. Resolve any `*.harness-new` by hand-merging if the monorepo had local engine edits.

- [ ] **Step 3: Add the missing quality gate**

```bash
node ~/repo-harness/packages/cli/dist/index.js add quality
node scripts/health/index.mjs apps packages --json .health/health.json   # smoke-run on real source
```
Expected: a `health.json` score is produced over the monorepo source (adjust the `quality-gate.yml` scan dir from `src` to the monorepo's `apps packages` — record this as an owned tweak). Keep `mode: report`.

- [ ] **Step 4: Verify on a branch + open a draft PR**

```bash
cd ~/work/featers-monorepo
git checkout -b chore/adopt-repo-harness
git add repo-harness.json scripts .github/workflows .github/sentinel
git commit -m "chore: adopt repo-harness for quality + compliance gates"
git push -u origin chore/adopt-repo-harness
```
Open a draft PR; confirm the quality + compliance gate workflows run and post sticky comments. Do **not** merge without review.

- [ ] **Step 5: Commit the plan-side record** (in repo-harness repo, note rollout done in a CHANGELOG entry).

---

### Task 19: Roll out to `featers/backresto` main app + author real compliance policy

**Files (in `~/work/backresto/backresto`):**
- Create: `repo-harness.json`
- Create via CLI: `scripts/health/*`, `scripts/compliance/*`, sentinel files, workflows.
- Author: `scripts/compliance/config.mjs` + `controls.mjs` (the real policy).

**Interfaces:** built CLI.

- [ ] **Step 1: Init + add (report mode)**

```bash
cd ~/work/backresto/backresto
node ~/repo-harness/packages/cli/dist/index.js init      # detects yarn
node ~/repo-harness/packages/cli/dist/index.js add quality compliance review
```
Note: the repo already has `.github/sentinel/src/{compliance-report,quality-report,review,...}.ts`; treat first sync as a reconcile (engine/bot files overwrite to the registry versions; verify with `diff`; resolve `*.harness-new` if the repo had local edits). The existing `code-review.yml` is replaced/aligned with the harness `review` workflow.

- [ ] **Step 2: Investigate real data flows for the policy**

Enumerate the app's actual egress + secrets to write the allowlist. Sources to read:
```bash
grep -rEn "https?://[a-z0-9.-]+" src services amplify --include=*.ts --include=*.tsx | grep -vE "w3.org|schema.org|localhost|example\." | sort -u | head -80
grep -rEn "process\.env\.[A-Z_]+|amplify|AppSync|Sentry|Resend|openrouter|blulog|Brother" src services amplify | head -80
```
Map each real destination (AWS AppSync/Amplify `eu-west-3` IAM, Sentry ingest, Resend, OpenRouter for the sentinel, blulog consumer endpoint, Brother print) into `egressAllowlist` entries with `service`/`scope`/`data`/`lawfulBasis`/`note`, mirroring the atlas/monorepo structure. Populate `serverOnlySecrets` from the real server-only env names; keep universal `secretPatterns`; set `roots` to the app's real source roots (`src`, `services`, `amplify/backend` functions); set `serverScope` to match (e.g. `^(amplify\/backend\/function\/|services\/server\/)`).

- [ ] **Step 3: Author `controls.mjs`**

Write the GDPR/processing register reflecting the real sub-processors found in Step 2 (AWS, Sentry, Resend, OpenRouter) — `standardsCovered`, `subProcessors`, and the `controls` array, mirroring the monorepo's `controls.mjs` shape.

- [ ] **Step 4: Run the gate locally in report mode**

```bash
node scripts/compliance/index.mjs --json .compliance/compliance.json --no-fail
node scripts/health/index.mjs src --json .health/health.json
```
Expected: compliance prints a score + any findings (informational, exit 0); iterate the allowlist until no **spurious** `unsanctioned-egress` violations remain (real ones stay flagged for follow-up). Keep `features.*.mode = "report"`.

- [ ] **Step 5: Branch, PR, verify, hand off**

```bash
git checkout -b chore/adopt-repo-harness
git add repo-harness.json scripts .github
git commit -m "chore: adopt repo-harness (quality + compliance + review), report mode"
git push -u origin chore/adopt-repo-harness
```
Open a draft PR; set repo secret `OPENROUTER_API_KEY`; confirm the gate workflows run and post sticky Code Quality + Privacy & Compliance comments. Leave blocking-mode flip (`mode: "block"`) as a documented follow-up once the policy is clean. Do not merge without review.

---

## Self-Review notes (addressed inline)

- **Spec coverage:** registry+CLI (Tasks 1-10, 14-16), each extracted gate (11-13), docs site (17), both rollouts incl. real policy (18-19), versioning/release (16), testing strategy (4,14,15 + carried `analyze.test.mjs`). All §-sections of the spec map to a task.
- **Registry location ambiguity resolved:** registry lives **inside `packages/cli/`** (Task 11 Step 3) — no copy step; all paths use `packages/cli/registry/...`.
- **`init` test ordering resolved:** stub `registry.json` created in Task 5; real items land in Tasks 11-13; `compliance`-specific assertions deferred to those tasks.
- **`registryRoot()` test override** added in Task 8 Step 3 (`REPO_HARNESS_ROOT`), used by diff/list/remove tests.
- **Stack-agnostic quality** (Global Constraint) honored: Task 11 ships only the health analyzer + report; no knip/vitest/esm-guard coupling; coverage env is optional and degrades.
- **owned-never-clobbered** enforced in `applyFile` (Task 6) and verified (Task 6 Step 1, Task 18 Step 2, Task 19 Step 1).
