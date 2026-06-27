import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRoutes } from "./route-extract.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rx-"));
}

test("next-pages: locale-prefixed pages → routes, module derived", () => {
  const d = tmp();
  mkdirSync(join(d, "src/pages/[locale]/modules/cooling"), { recursive: true });
  writeFileSync(join(d, "src/pages/[locale]/modules/cooling/index.tsx"), "x");
  writeFileSync(join(d, "src/pages/[locale]/home.tsx"), "x");
  const r = extractRoutes(d, { routing: "next-pages", pagesDir: "src/pages", modulePrefix: "/modules" });
  const paths = r.routes.map((x) => x.path).sort();
  assert.deepEqual(paths, ["/home", "/modules/cooling"]);
  assert.equal(r.routes.find((x) => x.path === "/modules/cooling")!.module, "cooling");
});

test("next-app: page.tsx dirs → routes", () => {
  const d = tmp();
  mkdirSync(join(d, "app/blog/[slug]"), { recursive: true });
  writeFileSync(join(d, "app/blog/[slug]/page.tsx"), "x");
  writeFileSync(join(d, "app/page.tsx"), "x");
  const r = extractRoutes(d, { routing: "next-app", appDir: "app" });
  assert.deepEqual(r.routes.map((x) => x.path).sort(), ["/", "/blog/:slug"]);
});

test("next-app: route groups are stripped from URL", () => {
  const d = tmp();
  mkdirSync(join(d, "app/(marketing)/blog"), { recursive: true });
  mkdirSync(join(d, "app/(shop)"), { recursive: true });
  writeFileSync(join(d, "app/(marketing)/blog/page.tsx"), "x");
  writeFileSync(join(d, "app/(shop)/page.tsx"), "x");
  const r = extractRoutes(d, { routing: "next-app", appDir: "app" });
  assert.deepEqual(r.routes.map((x) => x.path).sort(), ["/", "/blog"]);
});

test("glob: matched files → routes via strip rule", () => {
  const d = tmp();
  mkdirSync(join(d, "src/screens"), { recursive: true });
  writeFileSync(join(d, "src/screens/coach.screen.tsx"), "x");
  const r = extractRoutes(d, { routing: "glob", glob: "src/screens/*.screen.tsx" });
  assert.deepEqual(r.routes.map((x) => x.path), ["/coach"]);
});
