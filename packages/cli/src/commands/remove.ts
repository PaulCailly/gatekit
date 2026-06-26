import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest, resolveDest } from "../manifest.ts";
import { loadRegistry, registryRoot } from "../registry.ts";

export default async function remove(args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const name = args[0];
  const reg = loadRegistry(registryRoot());
  const item = reg.items[name];
  if (!item) { console.error(`unknown feature: ${name}`); return 1; }

  for (const spec of [...item.files, ...(item.workflows ?? [])]) {
    const rel = resolveDest(spec.dest, manifest.paths);
    if (spec.type === "owned") { console.log(`  kept (owned)  ${rel}`); continue; }
    const abs = join(cwd, rel);
    if (existsSync(abs)) rmSync(abs);
    delete manifest.installed[rel];
    console.log(`  removed       ${rel}`);
  }
  if (manifest.features[name]) manifest.features[name].enabled = false;
  writeManifest(cwd, manifest);
  return 0;
}
