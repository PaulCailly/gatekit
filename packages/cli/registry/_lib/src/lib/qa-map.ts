/**
 * The QA map: the app's expected route/feature surface, used to measure coverage,
 * steer the agent toward unvisited areas, and scope `/qa focus`. Built by merging
 * the generated route skeleton (`qa-map.generated.json`, from the app's pages) with
 * a hand-authored overlay (`qa-map.overlay.ts`: domains, preconditions, out-of-scope,
 * enabled modules). Pure merge + coverage logic; the JSON load is the only IO.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { OVERLAY } from "./qa-map.overlay.js";

export interface GeneratedRoute {
  path: string;
  section: string;
  module: string | null;
}

export interface QaDomain {
  key: string;
  label: string;
  routes: string[];
  preconditions: string[];
}

export interface QaRoute {
  path: string;
  section: string;
  module: string | null;
  domain: string | null;
  preconditions: string[];
}

export interface QaOverlay {
  domains: QaDomain[];
  routePreconditions: Record<string, string[]>;
  outOfScope: string[];
  enabledModules: string[];
}

export interface QaMap {
  locales: string[];
  routes: QaRoute[];
  domains: QaDomain[];
  outOfScope: string[];
  enabledModules: string[];
}

interface GeneratedFile {
  generatedAt?: string | null;
  locales: string[];
  routes: GeneratedRoute[];
}

/** Merge the generated skeleton with the overlay. Throws if the overlay points at
 *  a route that doesn't exist in the skeleton (catches drift after a route rename). */
export function mergeQaMap(generated: GeneratedFile, overlay: QaOverlay): QaMap {
  const known = new Set(generated.routes.map((r) => r.path));

  const routeToDomain = new Map<string, string>();
  for (const d of overlay.domains) {
    for (const r of d.routes) {
      if (!known.has(r)) throw new Error(`Overlay domain "${d.key}" references unknown route: ${r}`);
      routeToDomain.set(r, d.key);
    }
  }
  for (const r of Object.keys(overlay.routePreconditions)) {
    if (!known.has(r)) throw new Error(`Overlay routePreconditions references unknown route: ${r}`);
  }
  for (const r of overlay.outOfScope) {
    if (!known.has(r)) throw new Error(`Overlay outOfScope references unknown route: ${r}`);
  }
  for (const r of overlay.outOfScope) {
    if (routeToDomain.has(r)) throw new Error(`Overlay route "${r}" is in both a domain and outOfScope`);
  }

  const routes: QaRoute[] = generated.routes.map((g) => ({
    path: g.path,
    section: g.section,
    module: g.module,
    domain: routeToDomain.get(g.path) ?? null,
    preconditions: overlay.routePreconditions[g.path] ?? [],
  }));

  return {
    locales: generated.locales,
    routes,
    domains: overlay.domains,
    outOfScope: overlay.outOfScope,
    enabledModules: overlay.enabledModules,
  };
}

/** Load + merge the committed skeleton and the overlay. */
export function loadQaMap(): QaMap {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const generated = JSON.parse(readFileSync(path.join(here, "qa-map.generated.json"), "utf8")) as GeneratedFile;
  return mergeQaMap(generated, OVERLAY);
}

export interface DomainCoverage {
  key: string;
  label: string;
  covered: number;
  total: number;
  pct: number;
}

export interface Coverage {
  overall: { covered: number; total: number; pct: number };
  domains: DomainCoverage[];
  outOfScopeCount: number;
  outOfScopeRoutes: string[];
  coveredPaths: string[];
}

export interface CoverageOpts {
  /** Restrict the denominator + breakdown to a single domain key. */
  domain?: string;
}

function pct(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 100);
}

/** Strip a leading `/<locale>` segment (when it's a known locale) and any trailing
 *  slash, yielding a route key comparable to QaMap route paths. */
export function normalizePath(pathname: string, locales: string[]): string {
  let p = pathname.split("?")[0].split("#")[0];
  const segs = p.split("/").filter(Boolean);
  if (segs.length > 0 && locales.includes(segs[0])) segs.shift();
  p = "/" + segs.join("/");
  return p === "/" ? "/" : p.replace(/\/$/, "");
}

/** True when a route counts toward coverage: in scope and (module-less or enabled). */
function inDenominator(r: QaRoute, map: QaMap): boolean {
  if (map.outOfScope.includes(r.path)) return false;
  if (r.module === null) return true;
  return map.enabledModules.includes(r.module);
}

function scopedRoutes(map: QaMap, domain?: string): QaRoute[] {
  const inDomain = domain ? (r: QaRoute) => r.domain === domain : () => true;
  return map.routes.filter((r) => inDenominator(r, map) && inDomain(r));
}

export function coverageFor(map: QaMap, visited: string[], opts: CoverageOpts = {}): Coverage {
  const visitedKeys = new Set(visited.map((v) => normalizePath(v, map.locales)));
  const scoped = scopedRoutes(map, opts.domain);
  const isCovered = (r: QaRoute) => visitedKeys.has(r.path);

  const coveredRoutes = scoped.filter(isCovered);
  const overall = { covered: coveredRoutes.length, total: scoped.length, pct: pct(coveredRoutes.length, scoped.length) };

  const domains: DomainCoverage[] = map.domains
    .filter((d) => !opts.domain || d.key === opts.domain)
    .map((d) => {
      const rs = scoped.filter((r) => r.domain === d.key);
      const cov = rs.filter(isCovered).length;
      return { key: d.key, label: d.label, covered: cov, total: rs.length, pct: pct(cov, rs.length) };
    });

  return {
    overall,
    domains,
    outOfScopeCount: map.outOfScope.length,
    outOfScopeRoutes: map.outOfScope,
    coveredPaths: coveredRoutes.map((r) => r.path),
  };
}

/** In-scope, enabled routes not yet covered — the steering target. */
export function unvisited(map: QaMap, visited: string[], opts: CoverageOpts = {}): QaRoute[] {
  const visitedKeys = new Set(visited.map((v) => normalizePath(v, map.locales)));
  return scopedRoutes(map, opts.domain).filter((r) => !visitedKeys.has(r.path));
}

export function routesForDomain(map: QaMap, domainKey: string): QaRoute[] {
  return map.routes.filter((r) => r.domain === domainKey);
}
