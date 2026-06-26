import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import remove from "../src/commands/remove.ts";
import { writeManifest, readManifest, sha } from "../src/manifest.ts";

const ROOT = fileURLToPath(new URL("./fixtures/registry", import.meta.url));

test("remove deletes managed but keeps owned", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rh-"));
  await mkdir(join(cwd, "scripts/demo"), { recursive: true });
  await writeFile(join(cwd, "scripts/demo/engine.mjs"), "E");
  await writeFile(join(cwd, "scripts/demo/policy.mjs"), "P");
  writeManifest(cwd, {
    $schema: "x", version: "9.9.9", packageManager: "npm",
    paths: { scripts: "scripts", sentinel: ".github/sentinel" },
    features: { demo: { enabled: true, mode: "report" } },
    installed: {
      "scripts/demo/engine.mjs": { sha: sha("E"), type: "managed", version: "9.9.9" },
      "scripts/demo/policy.mjs": { sha: sha("P"), type: "owned", version: "9.9.9" },
    },
  });
  const prev = process.cwd(); process.chdir(cwd);
  try {
    process.env.REPO_HARNESS_ROOT = ROOT;
    assert.equal(await remove(["demo"]), 0);
    assert.equal(existsSync(join(cwd, "scripts/demo/engine.mjs")), false);
    assert.equal(existsSync(join(cwd, "scripts/demo/policy.mjs")), true);
    assert.equal(readManifest(cwd)!.features.demo.enabled, false);
  } finally { process.chdir(prev); delete process.env.REPO_HARNESS_ROOT; }
});
