// packages/cli/test/update.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../src/commands/update.ts";
import update from "../src/commands/update.ts";
import { loadRegistry } from "../src/registry.ts";
import { sha } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));
const PATHS = { scripts: "scripts", sentinel: ".github/sentinel" };

test("classify flags a locally-modified managed file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "EDITED BY USER");
  const reg = loadRegistry(ROOT);
  const manifest: any = {
    paths: PATHS,
    installed: { "scripts/demo/engine.mjs": { sha: sha("export const engine = \"v0\";"), type: "managed", version: "0" } },
  };
  const rows = classify(ROOT, cwd, manifest, reg);
  const row = rows.find((r) => r.dest === "scripts/demo/engine.mjs")!;
  assert.equal(row.state, "locally-modified");
});

test("update skips orphaned files without crashing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  // Create a file that exists on disk under a dest not in any registry spec
  await mkdir(join(cwd, "scripts/gone"), { recursive: true });
  const orphanContent = "X";
  await writeFile(join(cwd, "scripts/gone/old.mjs"), orphanContent);

  // Manifest records this file as managed — but no registry item maps to this dest
  const manifest: any = {
    paths: PATHS,
    installed: {
      "scripts/gone/old.mjs": { sha: sha(orphanContent), type: "managed", version: "0" },
    },
  };

  const reg = loadRegistry(ROOT);

  // classify should return src: undefined for the orphaned dest (not in registry)
  const rows = classify(ROOT, cwd, manifest, reg);
  const row = rows.find((r) => r.dest === "scripts/gone/old.mjs")!;
  assert.ok(row, "orphaned row should appear in classify output");
  assert.equal(row.src, undefined, "orphaned file should have src === undefined");

  // update default should not throw and should return 0, leaving the file untouched
  const prevCwd = process.cwd();
  const prevRoot = process.env.REPO_HARNESS_ROOT;
  process.chdir(cwd);
  process.env.REPO_HARNESS_ROOT = ROOT;
  // Write a minimal repo-harness.json so readManifest succeeds
  await writeFile(
    join(cwd, "repo-harness.json"),
    JSON.stringify({ version: "0", paths: PATHS, installed: manifest.installed }),
  );
  let exitCode: number;
  try {
    exitCode = await update([]);
  } finally {
    process.chdir(prevCwd);
    if (prevRoot === undefined) delete process.env.REPO_HARNESS_ROOT;
    else process.env.REPO_HARNESS_ROOT = prevRoot;
  }
  assert.equal(exitCode!, 0, "update should return 0 for orphaned file");

  // Original file must be untouched
  const { readFileSync } = await import("node:fs");
  const afterContent = readFileSync(join(cwd, "scripts/gone/old.mjs"), "utf8");
  assert.equal(afterContent, orphanContent, "orphaned file content must be unchanged");
});
