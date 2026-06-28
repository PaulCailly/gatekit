import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeQaConfig } from "./qa-config-persist.js";

test("mergeQaConfig replaces routing+params, preserves unrelated qa keys", () => {
  const gk = {
    name: "x",
    features: { qa: { enabled: true } },
    qa: { routing: "auto", bibleModel: "anthropic/claude-opus-4", docsForBible: ["README.md"] },
  };
  const out = mergeQaConfig(gk, { routing: "code-router", routerFiles: ["src/router.tsx"] } as any);
  assert.equal((out as any).qa.routing, "code-router");
  assert.deepEqual((out as any).qa.routerFiles, ["src/router.tsx"]);
  assert.equal((out as any).qa.bibleModel, "anthropic/claude-opus-4"); // preserved
  assert.equal((out as any).features.qa.enabled, true); // untouched
});

test("mergeQaConfig strips a stale prior strategy param", () => {
  const gk = { qa: { routing: "next-pages", pagesDir: "src/pages", bibleModel: "m" } };
  const out = mergeQaConfig(gk, { routing: "code-router", routerFiles: ["r.tsx"] } as any);
  assert.equal((out as any).qa.pagesDir, undefined); // old strategy param gone
  assert.equal((out as any).qa.routerFiles[0], "r.tsx");
  assert.equal((out as any).qa.bibleModel, "m"); // non-strategy key kept
});
