/**
 * Generate the QA route-map skeleton from the app's Next.js file-based routes.
 * Scans `../../src/pages/[locale]/**` (relative to the sentinel cwd) and the
 * `../../public/locales` dirs, emitting one canonical route per page plus the
 * shipped locale list. The output is committed as `src/lib/qa-map.generated.json`
 * and validated by a freshness test — so adding an app route without regenerating
 * fails CI. Run via `npm run qa:gen-map`.
 */
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SENTINEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAGES_DIR = path.resolve(SENTINEL_DIR, "../../src/pages");
const LOCALES_DIR = path.resolve(SENTINEL_DIR, "../../public/locales");
const OUT = path.resolve(SENTINEL_DIR, "src/lib/qa-map.generated.json");

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

/** Files that are not navigable routes. */
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

/** `[locale]/modules/cooling/index.tsx` → `/modules/cooling`; returns null for
 *  non-route or non-`[locale]` files. */
function toRoute(relFile: string): string | null {
  if (!relFile.startsWith("[locale]/")) return null; // canonical set is locale-prefixed
  let p = relFile.slice("[locale]/".length).replace(/\.tsx?$/, "");
  if (SKIP.has(p)) return null;
  p = p.replace(/\/index$/, "").replace(/^index$/, "");
  // Normalize any dynamic segment `[param]` → `:param` (defensive; none today).
  p = p.replace(/\[([^\]]+)\]/g, ":$1");
  return "/" + p;
}

export function generateMap(): GeneratedMap {
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
  const routes = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));

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

// Run only when invoked directly (not when imported by the freshness test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
