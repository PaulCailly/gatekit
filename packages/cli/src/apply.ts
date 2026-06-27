import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readItemFile, type FileSpec } from "./registry.ts";
import { sha, resolveDest, type Manifest } from "./manifest.ts";

export function applyFile(opts: {
  root: string;
  cwd: string;
  spec: FileSpec;
  paths: Manifest["paths"];
  version: string;
  manifest: Manifest;
}): { dest: string; action: "wrote" | "skipped-owned" | "overwrote" | "conflict" } {
  const { root, cwd, spec, paths, version, manifest } = opts;
  const rel = resolveDest(spec.dest, paths);
  const abs = join(cwd, rel);
  const upstream = readItemFile(root, spec.src);
  let action: "wrote" | "skipped-owned" | "overwrote" | "conflict" = "wrote";
  if (spec.type === "owned" && existsSync(abs)) {
    action = "skipped-owned";
  } else if (
    spec.type === "managed" &&
    existsSync(abs) &&
    !manifest.installed[rel]
  ) {
    // Dest exists but was NOT installed by repo-harness — do not clobber.
    // Write upstream to a side-car file so the consumer can diff manually.
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs + ".harness-new", upstream);
    action = "conflict";
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) action = "overwrote";
    writeFileSync(abs, upstream);
  }
  if (action !== "conflict") {
    const onDisk = readFileSync(abs, "utf8");
    manifest.installed[rel] = { sha: sha(onDisk), type: spec.type, version };
  }
  return { dest: rel, action };
}
