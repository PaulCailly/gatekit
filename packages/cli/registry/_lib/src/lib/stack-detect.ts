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
import { extractRoutes, type QaConfig, type GeneratedFile } from "./route-extract.js";
import type { GeneratedRoute } from "./qa-map.js";

/** Deterministic strategies the detector may emit (NOT `llm`/`auto`). */
const KNOWN_STRATEGIES = ["next-pages", "next-app", "glob", "code-router"];

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
    "section = first path segment ('/'→'root'); module = null unless under a /modules-style prefix.";
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
  let strategy = (p.strategy ?? null) as QaConfig | null;
  const routes = (p.routes ?? null) as GeneratedRoute[] | null;
  if (strategy) {
    if (typeof strategy.routing !== "string") {
      throw new Error("parseDetection: strategy missing 'routing'");
    }
    // An unknown routing would throw deep in extractRoutes; discard it here so
    // resolveAuto falls back to the LLM routes instead of crashing.
    if (!KNOWN_STRATEGIES.includes(strategy.routing)) strategy = null;
  }
  if (routes != null) {
    if (!Array.isArray(routes)) throw new Error("parseDetection: 'routes' is not an array");
    for (const r of routes) {
      if (!r || typeof r.path !== "string") {
        throw new Error("parseDetection: each route needs a string 'path'");
      }
    }
  }
  if (!strategy && !(routes && routes.length)) {
    throw new Error("parseDetection: no usable strategy or routes");
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
  opts: { runStrategy?: (r: string, c: QaConfig) => GeneratedFile },
): { routes: GeneratedRoute[]; locales: string[]; persist: QaConfig } {
  const run = opts.runStrategy ?? ((r, c) => extractRoutes(r, c));
  if (detection.strategy) {
    let gen: GeneratedFile | null = null;
    try {
      gen = run(root, detection.strategy); // defensive: a bad strategy must not crash the bootstrap
    } catch {
      gen = null;
    }
    if (gen && gen.routes.length > 0) {
      return { routes: gen.routes, locales: gen.locales, persist: detection.strategy };
    }
  }
  const fallback = detection.routes ?? [];
  if (fallback.length === 0) {
    throw new Error("resolveAuto: detection produced no routes (strategy empty and no LLM routes)");
  }
  // Fallback persists a clean `llm` config — no stale strategy keys carried over.
  return { routes: fallback, locales: [], persist: { routing: "llm" } };
}

export async function detectStack(
  root: string,
  opts: { complete: (p: { system: string; user: string }) => Promise<string> },
): Promise<Detection> {
  const signals = gatherStackSignals(root);
  const raw = await opts.complete(buildDetectPrompt(signals));
  return parseDetection(raw);
}
