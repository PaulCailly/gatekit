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
  assert.equal(r.persist.routing, "llm");
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

test("parseDetection discards an unknown strategy routing (falls through to routes)", () => {
  const d = parseDetection(JSON.stringify({
    framework: "x", strategy: { routing: "react-router-future" },
    routes: [{ path: "/y", section: "y", module: null }], confidence: 0.5, notes: "",
  }));
  assert.equal(d.strategy, null);
  assert.equal(d.routes?.length, 1);
});

test("parseDetection rejects routes whose entries lack a string path", () => {
  assert.throws(() => parseDetection(JSON.stringify({
    framework: "x", strategy: null, routes: [{ section: "y" }], confidence: 1, notes: "",
  })));
});

test("resolveAuto falls back (clean llm persist) when the strategy run throws", () => {
  const detection = {
    framework: "x",
    strategy: { routing: "code-router", routerFiles: ["x"] } as any,
    routes: [{ path: "/z", section: "z", module: null }],
    confidence: 0.3, notes: "",
  };
  const r = resolveAuto("/tmp", detection as any, { runStrategy: () => { throw new Error("boom"); } });
  assert.deepEqual(r.routes.map((x) => x.path), ["/z"]);
  assert.equal(r.persist.routing, "llm");
  assert.equal((r.persist as any).routerFiles, undefined); // no stale strategy keys
  assert.ok(Array.isArray(r.locales));
});
