// packages/cli/src/commands/update.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, writeManifest, sha, resolveDest, type Manifest } from "../manifest.ts";
import { loadRegistry, registryRoot, readItemFile, type Registry } from "../registry.ts";

type State = "up-to-date" | "update-available" | "locally-modified" | "owned";

/** Map every installed file to its update state vs the registry. */
export function classify(root: string, cwd: string, manifest: Manifest, reg: Registry):
  Array<{ dest: string; state: State; src?: string }> {
  // Build dest -> src/type from the registry for resolution.
  const byDest = new Map<string, { src: string; type: "managed" | "owned" }>();
  for (const item of Object.values(reg.items))
    for (const f of [...item.files, ...(item.workflows ?? [])])
      byDest.set(resolveDest(f.dest, manifest.paths), { src: f.src, type: f.type });

  const rows: Array<{ dest: string; state: State; src?: string }> = [];
  for (const [dest, rec] of Object.entries(manifest.installed)) {
    const meta = byDest.get(dest);
    if (rec.type === "owned") { rows.push({ dest, state: "owned", src: meta?.src }); continue; }
    const abs = join(cwd, dest);
    const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const upstream = meta ? readItemFile(root, meta.src) : "";
    if (sha(onDisk) !== rec.sha) rows.push({ dest, state: "locally-modified", src: meta?.src });
    else if (sha(upstream) !== rec.sha) rows.push({ dest, state: "update-available", src: meta?.src });
    else rows.push({ dest, state: "up-to-date", src: meta?.src });
  }
  return rows;
}

export default async function update(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const manifest = readManifest(cwd);
  if (!manifest) { console.error("No repo-harness.json — run `repo-harness init` first."); return 1; }
  const root = registryRoot();
  const reg = loadRegistry(root);
  let conflicts = 0;
  for (const row of classify(root, cwd, manifest, reg)) {
    if (row.state === "owned" || row.state === "up-to-date") continue;
    if (!row.src) {
      console.log(`  orphaned  ${row.dest} (no longer in the registry; skipping)`);
      continue;
    }
    const abs = join(cwd, row.dest);
    const upstream = readItemFile(root, row.src);
    if (row.state === "update-available") {
      writeFileSync(abs, upstream);
      manifest.installed[row.dest] = { sha: sha(upstream), type: "managed", version: reg.version };
      console.log(`  updated   ${row.dest}`);
    } else {
      // locally-modified: never clobber — write upstream alongside as .harness-new
      writeFileSync(`${abs}.harness-new`, upstream);
      conflicts++;
      console.log(`  CONFLICT  ${row.dest} (edited locally; upstream written to ${row.dest}.harness-new)`);
    }
  }
  manifest.version = reg.version;
  writeManifest(cwd, manifest);
  if (conflicts) console.log(`\n${conflicts} locally-modified file(s) need a manual merge.`);
  return 0;
}
