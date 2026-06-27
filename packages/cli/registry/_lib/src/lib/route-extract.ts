/**
 * Config-driven, portable route extractor.
 * Dispatches by QaConfig.routing to produce a GeneratedFile (same shape as
 * qa-map.generated.json) without touching the network or any LLM.
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

import type { GeneratedRoute } from "./qa-map.js";

// ── public types ─────────────────────────────────────────────────────────────

export interface QaConfig {
  routing: "next-pages" | "next-app" | "glob" | "opus-infer";
  /** next-pages: root of the pages directory (e.g. "src/pages") */
  pagesDir?: string;
  /** next-app: root of the app directory (e.g. "app") */
  appDir?: string;
  /** glob: pattern in the form "dir/*.suffix" */
  glob?: string;
  /** Directory whose sub-directory names are locale codes (e.g. "public/locales") */
  localesDir?: string | null;
  /** First path segment that triggers module tagging (default "/modules") */
  modulePrefix?: string | null;
  bibleModel?: string;
  docsForBible?: string[];
}

export interface GeneratedFile {
  generatedAt: string | null;
  locales: string[];
  routes: GeneratedRoute[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const NEXT_PAGE_SKIP = new Set(["_app", "_document", "_error", "404"]);

/** Recursively collect relative paths of .ts / .tsx / .js / .jsx files. */
function walkFiles(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(path.join(dir, entry.name), childRel));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(childRel);
    }
  }
  return out;
}

/** [param] → :param. Does NOT handle (group) route-group segments — those are filtered out upstream before this is called. */
function dynamicToColon(seg: string): string {
  return seg.replace(/\[([^\]]+)\]/g, ":$1");
}

/** Read locale codes from localesDir (sub-directory names). */
function getLocales(rootDir: string, localesDir?: string | null): string[] {
  if (!localesDir) return [];
  const abs = path.join(rootDir, localesDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Derive section + module from a route path. */
function sectionAndModule(
  routePath: string,
  modulePrefix?: string | null,
): { section: string; module: string | null } {
  const segs = routePath.split("/").filter(Boolean);
  const section = segs[0] ?? "root";
  const mp = (modulePrefix ?? "/modules").replace(/^\//, ""); // "modules"
  const mod = section === mp ? (segs[1] ?? null) : null;
  return { section, module: mod };
}

// ── strategies ────────────────────────────────────────────────────────────────

function extractNextPages(rootDir: string, cfg: QaConfig): GeneratedRoute[] {
  const pagesDir = path.join(rootDir, cfg.pagesDir ?? "pages");
  const files = walkFiles(pagesDir);
  const seen = new Map<string, GeneratedRoute>();

  for (const f of files) {
    if (!f.startsWith("[locale]/")) continue; // only canonical locale-prefixed set
    let p = f.slice("[locale]/".length).replace(/\.(tsx?|jsx?)$/, "");
    if (NEXT_PAGE_SKIP.has(p)) continue;
    p = p.replace(/\/index$/, "").replace(/^index$/, "");
    p = p.replace(/\[([^\]]+)\]/g, ":$1");
    const routePath = "/" + p;
    const { section, module } = sectionAndModule(routePath, cfg.modulePrefix);
    seen.set(routePath, { path: routePath, section, module });
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function extractNextApp(rootDir: string, cfg: QaConfig): GeneratedRoute[] {
  const appDir = path.join(rootDir, cfg.appDir ?? "app");
  const files = walkFiles(appDir);
  const seen = new Map<string, GeneratedRoute>();

  for (const f of files) {
    // Only page.{tsx,jsx,ts,js} files count
    if (!/(?:^|\/)page\.(tsx?|jsx?)$/.test(f)) continue;
    // Route = directory containing the page file, relative to appDir
    const dirPart = f.replace(/\/page\.(tsx?|jsx?)$/, "").replace(/^page\.(tsx?|jsx?)$/, "");
    // Convert to route path: empty dirPart means root
    let routePath: string;
    if (!dirPart) {
      routePath = "/";
    } else {
      // Strip Next.js route groups (e.g. "(marketing)") — layout-only, never in the URL.
      const segs = dirPart.split("/").filter(s => !/^\(.*\)$/.test(s)).map(dynamicToColon);
      routePath = segs.length === 0 ? "/" : "/" + segs.join("/");
    }
    const { section, module } = sectionAndModule(routePath, cfg.modulePrefix);
    seen.set(routePath, { path: routePath, section, module });
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

/**
 * Minimal single-level glob matcher for patterns of the form "dir/*.suffix"
 * (exactly one `*` in the filename segment, no path separators in the wildcard).
 */
function extractGlob(rootDir: string, cfg: QaConfig): GeneratedRoute[] {
  const pattern = cfg.glob ?? "";
  const lastSlash = pattern.lastIndexOf("/");
  const globDir = lastSlash >= 0 ? pattern.slice(0, lastSlash) : ".";
  const filePat = lastSlash >= 0 ? pattern.slice(lastSlash + 1) : pattern;

  const starIdx = filePat.indexOf("*");
  if (starIdx === -1) return []; // no wildcard — unsupported form

  const prefix = filePat.slice(0, starIdx);
  const suffix = filePat.slice(starIdx + 1);

  const absDir = path.join(rootDir, globDir);
  if (!existsSync(absDir)) return [];

  const routes: GeneratedRoute[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const n = entry.name;
    if (!n.startsWith(prefix) || !n.endsWith(suffix)) continue;
    // The matched portion (the `*` capture) becomes the route segment
    const matched = n.slice(prefix.length, n.length - suffix.length);
    if (!matched) continue;
    const routePath = "/" + matched;
    const { section, module } = sectionAndModule(routePath, cfg.modulePrefix);
    routes.push({ path: routePath, section, module });
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

// ── public API ────────────────────────────────────────────────────────────────

export function extractRoutes(rootDir: string, cfg: QaConfig): GeneratedFile {
  const locales = getLocales(rootDir, cfg.localesDir);

  switch (cfg.routing) {
    case "next-pages":
      return { generatedAt: null, locales, routes: extractNextPages(rootDir, cfg) };

    case "next-app":
      return { generatedAt: null, locales, routes: extractNextApp(rootDir, cfg) };

    case "glob":
      return { generatedAt: null, locales, routes: extractGlob(rootDir, cfg) };

    case "opus-infer":
      // Routes come from the LLM step — return the skeleton only.
      return { generatedAt: null, locales, routes: [] };

    default: {
      const _: never = cfg.routing;
      throw new Error(`Unknown routing strategy: ${_}`);
    }
  }
}
