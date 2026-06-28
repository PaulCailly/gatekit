# Adaptive Route Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gatekit QA bible generator framework-agnostic via an Opus stack-analysis pass that detects how routes are defined and either configures a deterministic extractor or falls back to an LLM-derived route list.

**Architecture:** Add a deterministic `code-router` strategy + an `auto` bootstrap to the route extractor; a new pure `stack-detect.ts` module (signal gathering + Opus prompt/parse + resolve, LLM injected via a `complete` seam); wire `auto` resolution + config persistence into `qa:gen-bible`; make `qa:gen-map` no-op on unresolved `auto`.

**Tech Stack:** TypeScript, Node 22, ESM, `node:test`. Spec: `docs/specs/2026-06-28-gatekit-adaptive-route-detection.md`.

## Global Constraints

- Node 22 (`export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"`); node 20 silently passes 0 tests.
- ESM `.js` import specifiers in source AND tests (never `.ts`).
- Registry source under `packages/cli/registry/`; sentinel lib is `_lib/src/lib/`, qa scripts are `qa/scripts/`. Scripts import the lib via the DEPLOYED layout `../src/lib/<x>.js`.
- The LLM call is always injected as a `complete` parameter so unit tests never hit the network (mirror `bible-gen.ts`).
- After any managed-file change, bump `packages/cli/registry.json` `version`.
- Run registry sentinel tests with: `cd packages/cli/registry/_lib && node --import tsx --test 'src/**/*.test.ts'`. Run registry-validate with: `cd packages/cli && npm test`.

---

### Task 1: `code-router` deterministic strategy + QaConfig extensions

**Files:**
- Modify: `packages/cli/registry/_lib/src/lib/route-extract.ts`
- Test: `packages/cli/registry/_lib/src/lib/route-extract.test.ts`

**Interfaces:**
- Consumes: existing `GeneratedRoute`, `GeneratedFile`, `sectionAndModule(routePath, modulePrefix)`, `getLocales(rootDir, localesDir)`.
- Produces: `extractCodeRouter(rootDir, cfg): GeneratedRoute[]`; `QaConfig.routing` now includes `"code-router" | "auto"`; new optional `QaConfig` fields `routerFiles?: string[]`, `pathPattern?: string`, `exclude?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `route-extract.test.ts` (use the file's existing fixture-tree helper; if it writes temp dirs, follow that pattern — otherwise create a temp dir under `node:os` tmpdir and write a router file):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractRoutes } from "./route-extract.js";

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "gk-coderouter-"));
}

test("code-router: extracts path: literals, derives section, dedups + sorts", () => {
  const root = tmpRepo();
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src/router.tsx"),
    `createRoute({ path: "/log" }); createRoute({ path: '/log/live' });
     createRoute({ path: "/" }); createRoute({ path: "/log" });`,
  );
  const out = extractRoutes(root, { routing: "code-router", routerFiles: ["src/router.tsx"] });
  assert.deepEqual(out.routes.map((r) => r.path), ["/", "/log", "/log/live"]);
  assert.equal(out.routes.find((r) => r.path === "/")!.section, "home");
  assert.equal(out.routes.find((r) => r.path === "/log/live")!.section, "log");
});

test("code-router: exclude filters drop non-app paths", () => {
  const root = tmpRepo();
  writeFileSync(
    path.join(root, "router.tsx"),
    `path: "/coach"; path: "/api/coach"; path: "/auth/v1/token";`,
  );
  const out = extractRoutes(root, {
    routing: "code-router",
    routerFiles: ["router.tsx"],
    exclude: ["^/api", "^/auth"],
  });
  assert.deepEqual(out.routes.map((r) => r.path), ["/coach"]);
});

test("code-router: missing router file yields no routes (no throw)", () => {
  const root = tmpRepo();
  const out = extractRoutes(root, { routing: "code-router", routerFiles: ["nope.tsx"] });
  assert.deepEqual(out.routes, []);
});

test("auto routing returns an empty skeleton from extractRoutes (resolved upstream)", () => {
  const root = tmpRepo();
  const out = extractRoutes(root, { routing: "auto" });
  assert.deepEqual(out.routes, []);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/route-extract.test.ts'`
Expected: FAIL (`code-router`/`auto` not handled; `extractCodeRouter` undefined).

- [ ] **Step 3: Extend `QaConfig` and add `extractCodeRouter`**

In `route-extract.ts`, change the `QaConfig` interface:

```ts
export interface QaConfig {
  routing: "next-pages" | "next-app" | "glob" | "code-router" | "auto";
  pagesDir?: string;
  appDir?: string;
  glob?: string;
  /** code-router: one or more files containing route definitions */
  routerFiles?: string[];
  /** code-router: regex with capture group 1 = the route path (default below) */
  pathPattern?: string;
  /** code-router: regexes; a path matching any is dropped */
  exclude?: string[];
  localesDir?: string | null;
  modulePrefix?: string | null;
  bibleModel?: string;
  docsForBible?: string[];
}

/** Default pattern matches `path: "..."` / `path: '...'` route literals. */
export const DEFAULT_CODE_ROUTER_PATTERN = "path:\\s*['\"]([^'\"]+)['\"]";

function extractCodeRouter(rootDir: string, cfg: QaConfig): GeneratedRoute[] {
  const files = cfg.routerFiles ?? [];
  const re = new RegExp(cfg.pathPattern ?? DEFAULT_CODE_ROUTER_PATTERN, "g");
  const excludes = (cfg.exclude ?? []).map((e) => new RegExp(e));
  const seen = new Map<string, GeneratedRoute>();
  for (const rel of files) {
    const abs = path.join(rootDir, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(re)) {
      const routePath = m[1];
      if (!routePath || !routePath.startsWith("/")) continue;
      if (excludes.some((rx) => rx.test(routePath))) continue;
      const { section, module } = sectionAndModule(routePath, cfg.modulePrefix);
      seen.set(routePath, { path: routePath, section, module });
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}
```

Ensure `readFileSync` is imported from `node:fs` (add to the existing import if absent).

- [ ] **Step 4: Wire the new cases into `extractRoutes`**

In the `switch (cfg.routing)` block, add before `default`:

```ts
    case "code-router":
      return { generatedAt: null, locales, routes: extractCodeRouter(rootDir, cfg) };

    case "opus-infer":
    case "auto":
      // routes come from the LLM/resolution step — return the skeleton only.
      return { generatedAt: null, locales, routes: [] };
```

(Replace the existing standalone `case "opus-infer":` with this combined block so `auto` shares it.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/route-extract.test.ts'`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/registry/_lib/src/lib/route-extract.ts packages/cli/registry/_lib/src/lib/route-extract.test.ts
git commit -m "feat(qa): code-router route strategy + auto routing in QaConfig"
```

---

### Task 2: `stack-detect.ts` — signal gathering, prompt, parse, resolve

**Files:**
- Create: `packages/cli/registry/_lib/src/lib/stack-detect.ts`
- Test: `packages/cli/registry/_lib/src/lib/stack-detect.test.ts`

**Interfaces:**
- Consumes: `QaConfig`, `GeneratedRoute`, `extractRoutes` (Task 1).
- Produces:
  - `gatherStackSignals(rootDir: string): StackSignals` where `StackSignals = { deps: string[]; tree: string[]; routerFiles: { path: string; text: string }[] }`.
  - `buildDetectPrompt(signals: StackSignals): { system: string; user: string }`.
  - `parseDetection(raw: string): Detection` where `Detection = { framework: string; strategy: QaConfig | null; routes: GeneratedRoute[] | null; confidence: number; notes: string }` (strategy is a partial QaConfig with at least `routing`).
  - `resolveAuto(rootDir, detection, opts: { runStrategy?: (root: string, cfg: QaConfig) => GeneratedRoute[] }): { routes: GeneratedRoute[]; persist: QaConfig }`.
  - `detectStack(rootDir, opts: { complete: (p: {system: string; user: string}) => Promise<string> }): Promise<Detection>` (gather → prompt → complete → parse).

- [ ] **Step 1: Write the failing tests**

Create `stack-detect.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gatherStackSignals,
  parseDetection,
  resolveAuto,
  detectStack,
} from "./stack-detect.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "gk-detect-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test("gatherStackSignals picks up deps + router file text", () => {
  const root = repoWith({
    "package.json": JSON.stringify({ dependencies: { "@tanstack/react-router": "1.0.0" } }),
    "src/presentation/app/router.tsx": `createRoute({ path: "/log" })`,
  });
  const s = gatherStackSignals(root);
  assert.ok(s.deps.includes("@tanstack/react-router"));
  assert.ok(s.routerFiles.some((f) => f.path.endsWith("router.tsx") && f.text.includes("/log")));
});

test("parseDetection accepts a strategy result", () => {
  const d = parseDetection(JSON.stringify({
    framework: "tanstack-router",
    strategy: { routing: "code-router", routerFiles: ["src/router.tsx"] },
    routes: null, confidence: 0.9, notes: "ok",
  }));
  assert.equal(d.strategy?.routing, "code-router");
  assert.equal(d.routes, null);
});

test("parseDetection accepts a direct routes result", () => {
  const d = parseDetection(JSON.stringify({
    framework: "custom", strategy: null,
    routes: [{ path: "/x", section: "x", module: null }], confidence: 0.5, notes: "",
  }));
  assert.equal(d.routes?.length, 1);
});

test("parseDetection rejects malformed / both-null", () => {
  assert.throws(() => parseDetection("not json"));
  assert.throws(() => parseDetection(JSON.stringify({ framework: "x", strategy: null, routes: null, confidence: 1, notes: "" })));
});

test("resolveAuto accepts a strategy that yields routes (persists concrete config)", () => {
  const root = repoWith({ "src/router.tsx": `path: "/a"; path: "/b";` });
  const detection = parseDetection(JSON.stringify({
    framework: "tanstack-router",
    strategy: { routing: "code-router", routerFiles: ["src/router.tsx"] },
    routes: null, confidence: 0.9, notes: "",
  }));
  const r = resolveAuto(root, detection, {});
  assert.deepEqual(r.routes.map((x) => x.path), ["/a", "/b"]);
  assert.equal(r.persist.routing, "code-router");
});

test("resolveAuto falls back to LLM routes when strategy yields empty", () => {
  const root = repoWith({});
  const detection = parseDetection(JSON.stringify({
    framework: "tanstack-router",
    strategy: { routing: "code-router", routerFiles: ["missing.tsx"] },
    routes: [{ path: "/fallback", section: "fallback", module: null }],
    confidence: 0.4, notes: "",
  }));
  const r = resolveAuto(root, detection, {});
  assert.deepEqual(r.routes.map((x) => x.path), ["/fallback"]);
  assert.equal(r.persist.routing, "opus-infer");
});

test("resolveAuto throws when both strategy and routes are empty", () => {
  const root = repoWith({});
  const detection = parseDetection(JSON.stringify({
    framework: "x", strategy: { routing: "code-router", routerFiles: ["missing.tsx"] },
    routes: null, confidence: 0.1, notes: "",
  }));
  assert.throws(() => resolveAuto(root, detection, {}));
});

test("detectStack: gather → prompt → stubbed complete → parse", async () => {
  const root = repoWith({
    "package.json": JSON.stringify({ dependencies: { next: "14" } }),
  });
  const complete = async () =>
    JSON.stringify({ framework: "next-app", strategy: { routing: "next-app", appDir: "app" }, routes: null, confidence: 1, notes: "" });
  const d = await detectStack(root, { complete });
  assert.equal(d.strategy?.routing, "next-app");
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/stack-detect.test.ts'`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `stack-detect.ts`**

```ts
/**
 * stack-detect.ts — adaptive route detection for the QA bible generator.
 *
 *   gatherStackSignals — deps + shallow tree + candidate router file texts
 *   buildDetectPrompt  — assemble the Opus prompt from signals
 *   parseDetection     — validate the structured-output JSON
 *   resolveAuto        — run the detected strategy, else fall back to LLM routes
 *   detectStack        — orchestrate: gather → prompt → complete → parse
 *
 * The LLM call is injected via `complete` so unit tests never hit the network.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { extractRoutes, type QaConfig, type GeneratedRoute } from "./route-extract.js";

const ROUTER_GLOBS = [
  "src/router.tsx", "src/router.ts", "src/presentation/app/router.tsx",
  "src/App.tsx", "src/App.jsx", "src/routes.tsx", "src/routes.ts", "routes.tsx",
];
const ROUTER_DIRS = ["app", "pages", "src/pages", "routes", "src/routes"];
const MAX_FILES = 12;
const MAX_BYTES = 8 * 1024;

export interface StackSignals {
  deps: string[];
  tree: string[];
  routerFiles: { path: string; text: string }[];
}

export interface Detection {
  framework: string;
  strategy: QaConfig | null;
  routes: GeneratedRoute[] | null;
  confidence: number;
  notes: string;
}

function readDeps(root: string): string[] {
  const p = path.join(root, "package.json");
  if (!existsSync(p)) return [];
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return [
      ...Object.keys((pkg.dependencies as object) ?? {}),
      ...Object.keys((pkg.devDependencies as object) ?? {}),
    ];
  } catch {
    return [];
  }
}

function shallowTree(root: string): string[] {
  const out: string[] = [];
  for (const dir of ["", "src", ...ROUTER_DIRS]) {
    const abs = path.join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      out.push(path.join(dir, e.name) + (e.isDirectory() ? "/" : ""));
    }
  }
  return [...new Set(out)].sort().slice(0, 80);
}

export function gatherStackSignals(root: string): StackSignals {
  const candidates = new Set<string>(ROUTER_GLOBS);
  for (const dir of ROUTER_DIRS) {
    const abs = path.join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isFile() && /\.(tsx?|jsx?)$/.test(e.name)) candidates.add(path.join(dir, e.name));
    }
  }
  const routerFiles: { path: string; text: string }[] = [];
  for (const rel of candidates) {
    if (routerFiles.length >= MAX_FILES) break;
    const abs = path.join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    routerFiles.push({ path: rel, text: readFileSync(abs, "utf8").slice(0, MAX_BYTES) });
  }
  return { deps: readDeps(root), tree: shallowTree(root), routerFiles };
}

export function buildDetectPrompt(signals: StackSignals): { system: string; user: string } {
  const system =
    "You analyze a web app's source to determine how its routes are defined. " +
    "Respond with ONE JSON object and nothing else, matching:\n" +
    `{ "framework": string, "strategy": <QaConfig|null>, "routes": <[{path,section,module}]|null>, "confidence": number, "notes": string }\n` +
    "Exactly one of strategy/routes is non-null. Prefer a deterministic `strategy` when a rule fits:\n" +
    "- next-pages {routing,pagesDir}; next-app {routing,appDir}; glob {routing,glob}; " +
    "code-router {routing,routerFiles[],pathPattern?,exclude?} for code-defined routers (TanStack/React-Router). " +
    "Only return `routes` directly when no deterministic rule fits. " +
    "section = first path segment ('/'→'home'); module = null unless under a /modules-style prefix.";
  const user = JSON.stringify(signals, null, 2);
  return { system, user };
}

export function parseDetection(raw: string): Detection {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`parseDetection: invalid JSON — ${(err as Error).message}`);
  }
  const strategy = (p.strategy ?? null) as QaConfig | null;
  const routes = (p.routes ?? null) as GeneratedRoute[] | null;
  if (!strategy && !routes) throw new Error("parseDetection: both strategy and routes are null");
  if (strategy && typeof strategy.routing !== "string") {
    throw new Error("parseDetection: strategy missing 'routing'");
  }
  return {
    framework: String(p.framework ?? "unknown"),
    strategy,
    routes,
    confidence: typeof p.confidence === "number" ? p.confidence : 0,
    notes: String(p.notes ?? ""),
  };
}

export function resolveAuto(
  root: string,
  detection: Detection,
  opts: { runStrategy?: (r: string, c: QaConfig) => GeneratedRoute[] },
): { routes: GeneratedRoute[]; persist: QaConfig } {
  const run = opts.runStrategy ?? ((r, c) => extractRoutes(r, c).routes);
  if (detection.strategy) {
    const routes = run(root, detection.strategy);
    if (routes.length > 0) return { routes, persist: detection.strategy };
  }
  const fallback = detection.routes ?? [];
  if (fallback.length === 0) {
    throw new Error("resolveAuto: detection produced no routes (strategy empty and no LLM routes)");
  }
  return { routes: fallback, persist: { ...detection.strategy, routing: "opus-infer" } as QaConfig };
}

export async function detectStack(
  root: string,
  opts: { complete: (p: { system: string; user: string }) => Promise<string> },
): Promise<Detection> {
  const signals = gatherStackSignals(root);
  const raw = await opts.complete(buildDetectPrompt(signals));
  return parseDetection(raw);
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/stack-detect.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/registry/_lib/src/lib/stack-detect.ts packages/cli/registry/_lib/src/lib/stack-detect.test.ts
git commit -m "feat(qa): stack-detect — adaptive route detection (gather/prompt/parse/resolve)"
```

---

### Task 3: Wire `auto` into the scripts + persist + registry listing

**Files:**
- Modify: `packages/cli/registry/qa/scripts/gen-bible.ts`
- Modify: `packages/cli/registry/qa/scripts/gen-qa-map.ts`
- Modify: `packages/cli/registry.json` (add `stack-detect.ts` to the `_lib` files list + bump version)
- Test: `packages/cli/registry/_lib/src/lib/qa-config-persist.test.ts` (+ a small helper file)
- Create: `packages/cli/registry/_lib/src/lib/qa-config-persist.ts`

**Interfaces:**
- Consumes: `detectStack`, `resolveAuto` (Task 2), `getClient()`/OpenRouter (existing in gen-bible).
- Produces: `mergeQaConfig(gatekitJson: object, resolved: QaConfig): object` (returns a new object with `qa` updated, unrelated keys preserved).

- [ ] **Step 1: Write the failing test for `mergeQaConfig`**

Create `qa-config-persist.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeQaConfig } from "./qa-config-persist.js";

test("mergeQaConfig replaces routing+params, preserves unrelated qa keys", () => {
  const gk = { name: "x", features: { qa: { enabled: true } },
    qa: { routing: "auto", bibleModel: "anthropic/claude-opus-4", docsForBible: ["README.md"] } };
  const out = mergeQaConfig(gk, { routing: "code-router", routerFiles: ["src/router.tsx"] } as any);
  assert.equal((out as any).qa.routing, "code-router");
  assert.deepEqual((out as any).qa.routerFiles, ["src/router.tsx"]);
  assert.equal((out as any).qa.bibleModel, "anthropic/claude-opus-4"); // preserved
  assert.equal((out as any).features.qa.enabled, true); // untouched
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/qa-config-persist.test.ts'`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `qa-config-persist.ts`**

```ts
import type { QaConfig } from "./route-extract.js";

/** Return a copy of the parsed gatekit.json with its `qa` block's routing +
 *  strategy params replaced by `resolved`, preserving bibleModel/docsForBible/etc. */
export function mergeQaConfig(gatekitJson: Record<string, unknown>, resolved: QaConfig): Record<string, unknown> {
  const prevQa = (gatekitJson.qa as Record<string, unknown>) ?? {};
  // strip strategy-specific keys so a stale pagesDir/glob doesn't linger
  const { routing: _r, pagesDir: _p, appDir: _a, glob: _g, routerFiles: _rf, pathPattern: _pp, exclude: _e, ...keep } = prevQa as any;
  return { ...gatekitJson, qa: { ...keep, ...resolved } };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/lib/qa-config-persist.test.ts'`
Expected: PASS.

- [ ] **Step 5: Wire auto-detection into `gen-bible.ts`**

In `qa/scripts/gen-bible.ts`, after loading the qa config and before the route-grouping step, add an auto-resolution block. Use the existing `getClient()` (OpenRouter) — wrap it as a `complete` seam. Import at top: `import { detectStack, resolveAuto } from "../src/lib/stack-detect.js";` `import { mergeQaConfig } from "../src/lib/qa-config-persist.js";` `import { writeFileSync, readFileSync } from "node:fs";`

Add this logic where `cfg`/`repoRoot` are known (use the file's existing `getClient`, `cfg.bibleModel`, `GENERATED_PATH`, and the gatekit.json path):

```ts
if (cfg.routing === "auto") {
  console.log("[gen-bible] routing=auto — running stack analysis…");
  const client = getClient();
  const model = cfg.bibleModel ?? "anthropic/claude-opus-4";
  const complete = async (p: { system: string; user: string }) => {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
      response_format: { type: "json_object" },
    });
    return res.choices[0]?.message?.content ?? "";
  };
  const detection = await detectStack(repoRoot, { complete });
  const { routes, persist } = resolveAuto(repoRoot, detection, {});
  console.log(`[gen-bible] detected ${detection.framework} → routing=${persist.routing} (${routes.length} routes)`);
  // write resolved routes to generated.json
  writeFileSync(GENERATED_PATH, JSON.stringify({ generatedAt: null, locales: [], routes }, null, 2) + "\n");
  // persist resolved config to gatekit.json
  const gkPath = path.join(repoRoot, "gatekit.json");
  const gk = JSON.parse(readFileSync(gkPath, "utf8"));
  writeFileSync(gkPath, JSON.stringify(mergeQaConfig(gk, persist), null, 2) + "\n");
  cfg.routing = persist.routing; // continue this run with the resolved routing
}
```

(Adapt variable names to the file's actual identifiers — `repoRoot`, `cfg`, `GENERATED_PATH`, `getClient` — discovered by reading the file.)

- [ ] **Step 6: Make `gen-qa-map.ts` no-op on unresolved `auto`**

In `qa/scripts/gen-qa-map.ts` `main()`, extend the existing opus-infer no-op guard:

```ts
  const cfg = loadGatekitQaConfig();
  if (cfg && (cfg.routing === "opus-infer" || cfg.routing === "auto") && existsSync(OUT)) {
    const why = cfg.routing === "auto"
      ? "routing=auto not yet resolved — run qa:gen-bible first"
      : "opus-infer: Opus-maintained map";
    console.log(`${why} — preserving ${path.relative(SENTINEL_DIR, OUT)}`);
    return;
  }
```

- [ ] **Step 7: Add `stack-detect.ts` + `qa-config-persist.ts` to the registry `_lib` file list and bump version**

In `packages/cli/registry.json`, add to `items._lib.files` (managed):
```json
{ "src": "_lib/src/lib/stack-detect.ts", "dest": "{sentinel}/src/lib/stack-detect.ts", "type": "managed" },
{ "src": "_lib/src/lib/qa-config-persist.ts", "dest": "{sentinel}/src/lib/qa-config-persist.ts", "type": "managed" }
```
Bump `version` to the next patch (e.g. `0.6.0`).

- [ ] **Step 8: Verify the full suites**

Run: `cd packages/cli/registry/_lib && node --import tsx --test 'src/**/*.test.ts'` → 0 fail.
Run: `cd packages/cli && npm test` → registry-validate + e2e green (the two new files exist + dest tokens resolve).

- [ ] **Step 9: Commit**

```bash
git add packages/cli/registry/qa/scripts/gen-bible.ts packages/cli/registry/qa/scripts/gen-qa-map.ts packages/cli/registry.json packages/cli/registry/_lib/src/lib/qa-config-persist.ts packages/cli/registry/_lib/src/lib/qa-config-persist.test.ts
git commit -m "feat(qa): wire auto stack-detection + config persistence into gen-bible; gen-map no-ops on auto"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/src/content/docs/gates/qa-bible.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document `auto` + `code-router`**

Add a section to `qa-bible.md`:
- `routing: "auto"` — a one-time bootstrap; on first `qa:gen-bible`, Opus analyzes the stack and rewrites `qa` in `gatekit.json` to a concrete strategy (reviewable). Subsequent `qa:gen-map` runs are deterministic.
- `code-router` — for code-defined routers (TanStack, React Router): `routerFiles`, `pathPattern` (default `path: "..."`), `exclude`. Show the atlas example (`src/presentation/app/router.tsx`).
- Note: when detection can't find a deterministic rule, it persists `routing: "opus-infer"` with the LLM-derived routes (freshness-skipped).

- [ ] **Step 2: Build the docs, verify 0 broken links**

Run: `cd docs && npm run build`
Expected: builds with 0 broken links.

- [ ] **Step 3: Commit**

```bash
git add docs/src/content/docs/gates/qa-bible.md
git commit -m "docs(qa): document routing: auto + code-router strategy"
```

---

## Self-Review notes

- **Spec coverage:** §3 code-router → Task 1; §4 stack-detect → Task 2; §5 resolve+persist → Task 2 (resolveAuto) + Task 3 (mergeQaConfig + script wiring); §6 invocation → Task 3; §7 error handling → Tasks 2–3 (throws + fallback); §8 testing → each task's tests; §9 docs → Task 4. All covered.
- **Type consistency:** `Detection`, `StackSignals`, `QaConfig` (with `code-router`/`auto` + `routerFiles`/`pathPattern`/`exclude`), `resolveAuto(...).persist: QaConfig`, `mergeQaConfig(gk, QaConfig)` consistent across tasks.
- **Deployed-layout imports:** scripts import lib via `../src/lib/<x>.js`; verify by the registry-validate + (optionally) a `{sentinel}`-shaped tsc as in prior qa work.
