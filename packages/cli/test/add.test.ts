import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFile } from "../src/apply.ts";
import { loadRegistry } from "../src/registry.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));
const PATHS = { scripts: "scripts", sentinel: ".github/sentinel" };

test("applyFile writes a managed file and records sha", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  const reg = loadRegistry(ROOT);
  const manifest: any = { installed: {} };
  const spec = reg.items.demo.files[0]; // managed engine.mjs
  const r = applyFile({ root: ROOT, cwd, spec, paths: PATHS, version: "9.9.9", manifest });
  assert.equal(r.action, "wrote");
  assert.ok(existsSync(join(cwd, "scripts/demo/engine.mjs")));
  assert.equal(manifest.installed["scripts/demo/engine.mjs"].type, "managed");
});

test("applyFile never overwrites an existing owned file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/policy.mjs"), "MINE");
  const reg = loadRegistry(ROOT);
  const manifest: any = { installed: {} };
  const spec = reg.items.demo.files[1]; // owned policy.mjs
  const r = applyFile({ root: ROOT, cwd, spec, paths: PATHS, version: "9.9.9", manifest });
  assert.equal(r.action, "skipped-owned");
  assert.equal(await readFile(join(cwd, "scripts/demo/policy.mjs"), "utf8"), "MINE");
});

test("applyFile does not clobber an untracked pre-existing managed file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "EXISTING");
  const reg = loadRegistry(ROOT);
  const manifest: any = { installed: {} }; // not tracked — simulates fresh consumer repo
  const spec = reg.items.demo.files[0]; // managed engine.mjs
  const r = applyFile({ root: ROOT, cwd, spec, paths: PATHS, version: "9.9.9", manifest });
  // Must return conflict
  assert.equal(r.action, "conflict");
  // Original file preserved
  assert.equal(await readFile(join(cwd, "scripts/demo/engine.mjs"), "utf8"), "EXISTING");
  // Upstream written to side-car
  const sidecar = await readFile(join(cwd, "scripts/demo/engine.mjs.harness-new"), "utf8");
  assert.ok(sidecar.length > 0, "side-car must contain upstream bytes");
  // Must NOT be recorded in manifest
  assert.equal(manifest.installed["scripts/demo/engine.mjs"], undefined);
});
