// bible-gen.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBiblePrompt, parseOverlay, validateOverlay, generateBible } from "./bible-gen.js";

const generated = { generatedAt: null, locales: ["en"], routes: [
  { path: "/home", section: "home", module: null },
  { path: "/modules/cooling", section: "modules", module: "cooling" },
]};

test("buildBiblePrompt mentions the routes + asks for QaOverlay JSON", () => {
  const p = buildBiblePrompt({ routes: generated.routes, locales: ["en"], readme: "", docs: "", pkgName: "app" });
  assert.match(p.user, /\/modules\/cooling/);
  assert.match(p.system + p.user, /domains/i);
});

test("parseOverlay tolerates code fences", () => {
  const o = parseOverlay("```json\n{\"domains\":[],\"routePreconditions\":{},\"outOfScope\":[],\"enabledModules\":[]}\n```");
  assert.deepEqual(o.domains, []);
});

test("validateOverlay rejects a route not in the generated map", () => {
  const bad = { domains: [{ key: "x", label: "X", routes: ["/nope"], preconditions: [] }], routePreconditions: {}, outOfScope: [], enabledModules: [] };
  const problems = validateOverlay(bad as any, generated);
  assert.ok(problems.some((p) => p.includes("/nope")));
});

test("generateBible runs the injected completer + validates", async () => {
  const fakeOverlay = { domains: [{ key: "ops", label: "Ops", routes: ["/modules/cooling"], preconditions: ["start a cycle"] }], routePreconditions: {}, outOfScope: [], enabledModules: ["cooling"] };
  const { overlay, problems } = await generateBible({
    rootDir: ".", cfg: { routing: "next-pages" }, generated,
    complete: async () => JSON.stringify(fakeOverlay),
  });
  assert.equal(problems.length, 0);
  assert.equal(overlay.domains[0].key, "ops");
});
