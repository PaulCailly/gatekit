/**
 * Generate the QA route-map skeleton.  Now config-driven: reads the consumer's
 * `gatekit.json` `qa` stanza and dispatches via extractRoutes().
 * Falls back to the original next-pages scan when no gatekit.json is found.
 *
 * The output is committed as `src/lib/qa-map.generated.json` and validated by
 * a freshness test — so adding a route without regenerating fails CI.
 * Run via `npm run qa:gen-map`.
 */
import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// DEV COPY — exercised by src/lib/qa-map.test.ts in the registry dev tree.
// The SHIPPED copy is at qa/scripts/gen-qa-map.ts (installed to
// {sentinel}/scripts/gen-qa-map.ts) and uses "../src/lib/route-extract.js".
// Consolidation is deferred because the two layout roots differ; keep import
// paths in sync when changing shared logic.
import { extractRoutes, type QaConfig } from "../src/lib/route-extract.js";

const SENTINEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Walk up from startDir to the nearest directory containing gatekit.json; fall back to process.cwd(). */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "gatekit.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export const PAGES_DIR = path.resolve(SENTINEL_DIR, "../../src/pages");
const LOCALES_DIR = path.resolve(SENTINEL_DIR, "../../public/locales");
const OUT = path.resolve(SENTINEL_DIR, "src/lib/qa-map.generated.json");

export type { QaConfig };
export { extractRoutes };

export interface GeneratedRoute {
  path: string;
  section: string;
  module: string | null;
}

export interface GeneratedMap {
  generatedAt: null;
  locales: string[];
  routes: GeneratedRoute[];
}

/** Load QA config from the consumer's gatekit.json, if present. */
function loadGatekitQaConfig(): QaConfig | null {
  const gkPath = path.join(REPO_ROOT, "gatekit.json");
  if (!existsSync(gkPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(gkPath, "utf8")) as Record<string, unknown>;
    if (!raw.qa || typeof raw.qa !== "object") return null;
    const qa = raw.qa as Record<string, unknown>;
    if (typeof qa.routing !== "string") {
      console.log("[gatekit] qa.routing missing or not a string — using next-pages fallback");
      return null;
    }
    return qa as unknown as QaConfig;
  } catch {
    return null;
  }
}

/** Files that are not navigable routes (next-pages fallback). */
const SKIP = new Set(["_app", "_document", "_error", "404"]);

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), childRel));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(childRel);
    }
  }
  return out;
}

function toRoute(relFile: string): string | null {
  if (!relFile.startsWith("[locale]/")) return null;
  let p = relFile.slice("[locale]/".length).replace(/\.tsx?$/, "");
  if (SKIP.has(p)) return null;
  p = p.replace(/\/index$/, "").replace(/^index$/, "");
  p = p.replace(/\[([^\]]+)\]/g, ":$1");
  return "/" + p;
}

export function generateMap(): GeneratedMap {
  const qaConfig = loadGatekitQaConfig();

  if (qaConfig) {
    const generated = extractRoutes(REPO_ROOT, qaConfig);
    return { generatedAt: null, locales: generated.locales, routes: generated.routes };
  }

  // ── backward-compatible next-pages fallback ──────────────────────────────
  const files = existsSync(PAGES_DIR) ? walk(PAGES_DIR) : [];
  const seen = new Map<string, GeneratedRoute>();
  for (const f of files) {
    const route = toRoute(f);
    if (route === null) continue;
    const segs = route.split("/").filter(Boolean);
    const section = segs[0] ?? "root";
    const module = section === "modules" ? segs[1] ?? null : null;
    seen.set(route, { path: route, section, module });
  }
  const routes = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const locales = existsSync(LOCALES_DIR)
    ? readdirSync(LOCALES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

  return { generatedAt: null, locales, routes };
}

function main(): void {
  const map = generateMap();
  writeFileSync(OUT, JSON.stringify(map, null, 2) + "\n", "utf8");
  console.log(`Wrote ${map.routes.length} routes, ${map.locales.length} locales → ${path.relative(SENTINEL_DIR, OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
