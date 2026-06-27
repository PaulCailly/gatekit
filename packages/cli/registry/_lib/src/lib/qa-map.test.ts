import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateMap, PAGES_DIR } from "../../scripts/gen-qa-map.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(
  readFileSync(path.join(here, "qa-map.generated.json"), "utf8"),
) as { locales: string[]; routes: Array<{ path: string; section: string; module: string | null }> };

test("committed qa-map.generated.json is up to date with a fresh scan", { skip: !existsSync(PAGES_DIR) }, () => {
  const fresh = generateMap();
  assert.deepEqual(
    fresh.routes,
    committed.routes,
    "qa-map.generated.json is stale — run `npm run qa:gen-map` and commit.",
  );
  assert.deepEqual(fresh.locales, committed.locales);
});

test("generated map covers the known HACCP module routes", { skip: !existsSync(PAGES_DIR) }, () => {
  const paths = new Set(committed.routes.map((r) => r.path));
  for (const p of [
    "/modules/cooling",
    "/modules/freezing",
    "/modules/reheating",
    "/modules/transport",
    "/modules/surface-analysis",
    "/preparations/list",
    "/settings/advanced/export-data",
  ]) {
    assert.ok(paths.has(p), `expected route missing from map: ${p}`);
  }
});

test("module routes are tagged with their module segment", { skip: !existsSync(PAGES_DIR) }, () => {
  const cooling = committed.routes.find((r) => r.path === "/modules/cooling");
  assert.equal(cooling?.section, "modules");
  assert.equal(cooling?.module, "cooling");
});

test("locale list is the 14 shipped locales", { skip: !existsSync(PAGES_DIR) }, () => {
  assert.deepEqual(
    [...committed.locales].sort(),
    ["ar", "bn", "de", "en", "es", "fr", "hi", "it", "pl", "pt", "ro", "ta", "tr", "zh"],
  );
});

import { mergeQaMap, loadQaMap, type QaOverlay } from "./qa-map.js";

const GENERATED = {
  generatedAt: null,
  locales: ["en", "fr"],
  routes: [
    { path: "/modules/cooling", section: "modules", module: "cooling" },
    { path: "/modules/reheating", section: "modules", module: "reheating" },
    { path: "/preparations/list", section: "preparations", module: null },
  ],
};

const OVERLAY_OK: QaOverlay = {
  domains: [
    { key: "cold-chain", label: "Cold chain", routes: ["/modules/cooling", "/modules/reheating"], preconditions: ["Start a cooling cycle to see records."] },
    { key: "master-data", label: "Master data", routes: ["/preparations/list"], preconditions: [] },
  ],
  routePreconditions: { "/modules/reheating": ["Needs a completed cooling batch."] },
  outOfScope: [],
  enabledModules: ["cooling", "reheating"],
};

test("mergeQaMap assigns domains and preconditions to routes", () => {
  const map = mergeQaMap(GENERATED, OVERLAY_OK);
  const reheating = map.routes.find((r) => r.path === "/modules/reheating");
  assert.equal(reheating?.domain, "cold-chain");
  assert.deepEqual(reheating?.preconditions, ["Needs a completed cooling batch."]);
  assert.equal(map.domains.length, 2);
  assert.deepEqual(map.enabledModules, ["cooling", "reheating"]);
});

test("mergeQaMap throws when an overlay references an unknown route", () => {
  const bad: QaOverlay = {
    ...OVERLAY_OK,
    domains: [{ key: "x", label: "X", routes: ["/modules/does-not-exist"], preconditions: [] }],
  };
  assert.throws(() => mergeQaMap(GENERATED, bad), /unknown route/i);
});

test("mergeQaMap throws when routePreconditions has an unknown-route key", () => {
  const bad: QaOverlay = {
    ...OVERLAY_OK,
    routePreconditions: { "/modules/does-not-exist": ["nope"] },
  };
  assert.throws(() => mergeQaMap(GENERATED, bad), /unknown route/i);
});

test("mergeQaMap throws when outOfScope has an unknown route", () => {
  const bad: QaOverlay = {
    ...OVERLAY_OK,
    outOfScope: ["/modules/does-not-exist"],
  };
  assert.throws(() => mergeQaMap(GENERATED, bad), /unknown route/i);
});

test("mergeQaMap throws when a route is in both a domain and outOfScope", () => {
  const bad: QaOverlay = {
    ...OVERLAY_OK,
    outOfScope: ["/modules/cooling"],
  };
  assert.throws(() => mergeQaMap(GENERATED, bad), /both a domain and outOfScope/i);
});

test("loadQaMap loads the committed skeleton + real overlay without throwing", () => {
  const map = loadQaMap();
  assert.ok(Array.isArray(map.routes));
  assert.ok(Array.isArray(map.domains));
});

import { coverageFor, unvisited, normalizePath, routesForDomain } from "./qa-map.js";

test("normalizePath strips a known locale prefix and trailing slash", () => {
  assert.equal(normalizePath("/en/modules/cooling", ["en", "fr"]), "/modules/cooling");
  assert.equal(normalizePath("/fr/preparations/list/", ["en", "fr"]), "/preparations/list");
  assert.equal(normalizePath("/modules/cooling", ["en", "fr"]), "/modules/cooling");
  assert.equal(normalizePath("/en", ["en", "fr"]), "/");
});

const COV_MAP = mergeQaMap(
  {
    generatedAt: null,
    locales: ["en"],
    routes: [
      { path: "/modules/cooling", section: "modules", module: "cooling" },
      { path: "/modules/freezing", section: "modules", module: "freezing" },
      { path: "/modules/sensors/offer", section: "modules", module: "sensors" },
      { path: "/preparations/list", section: "preparations", module: null },
    ],
  },
  {
    domains: [
      { key: "cold-chain", label: "Cold chain", routes: ["/modules/cooling", "/modules/freezing"], preconditions: [] },
      { key: "master-data", label: "Master data", routes: ["/preparations/list"], preconditions: [] },
    ],
    routePreconditions: {},
    outOfScope: ["/modules/sensors/offer"],
    enabledModules: ["cooling", "freezing"], // NOT preparations(null module) → see note below
  },
);

test("coverageFor counts in-scope enabled routes, excludes out-of-scope", () => {
  // Visited cooling (en-prefixed) + the out-of-scope offer page.
  const cov = coverageFor(COV_MAP, ["/en/modules/cooling", "/en/modules/sensors/offer"]);
  // Denominator: cooling, freezing, preparations/list (module null = always in scope) = 3.
  assert.equal(cov.overall.total, 3);
  assert.equal(cov.overall.covered, 1);
  assert.equal(cov.overall.pct, 33);
  assert.equal(cov.outOfScopeCount, 1);
  assert.deepEqual(cov.outOfScopeRoutes, ["/modules/sensors/offer"]);
});

test("coverageFor reports per-domain breakdown", () => {
  const cov = coverageFor(COV_MAP, ["/en/modules/cooling"]);
  const cold = cov.domains.find((d) => d.key === "cold-chain");
  assert.deepEqual({ covered: cold?.covered, total: cold?.total, pct: cold?.pct }, { covered: 1, total: 2, pct: 50 });
});

test("coverageFor with opts.domain restricts to that domain", () => {
  const cov = coverageFor(COV_MAP, ["/en/modules/cooling"], { domain: "cold-chain" });
  assert.equal(cov.overall.total, 2);
  assert.equal(cov.overall.covered, 1);
});

test("unvisited returns in-scope enabled routes not yet covered", () => {
  const u = unvisited(COV_MAP, ["/en/modules/cooling"]).map((r) => r.path);
  assert.deepEqual(u.sort(), ["/modules/freezing", "/preparations/list"]);
  assert.ok(!u.includes("/modules/sensors/offer")); // out of scope
});

test("routesForDomain returns the domain's routes", () => {
  assert.deepEqual(
    routesForDomain(COV_MAP, "cold-chain").map((r) => r.path).sort(),
    ["/modules/cooling", "/modules/freezing"],
  );
});
