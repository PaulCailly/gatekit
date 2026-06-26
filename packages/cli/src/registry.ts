import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FileSpec { src: string; dest: string; type: "managed" | "owned"; mode?: string }
export interface Item {
  description: string; dependsOn?: string[]; files: FileSpec[];
  workflows?: FileSpec[]; scripts?: Record<string, string>; secrets?: string[];
}
export interface Registry { version: string; items: Record<string, Item> }

export function registryRoot(): string {
  if (process.env.REPO_HARNESS_ROOT) return process.env.REPO_HARNESS_ROOT;
  return fileURLToPath(new URL("..", import.meta.url)); // package root (dist/ -> ..)
}

export function loadRegistry(root: string): Registry {
  return JSON.parse(readFileSync(join(root, "registry.json"), "utf8")) as Registry;
}

export function readItemFile(root: string, src: string): string {
  return readFileSync(join(root, "registry", src), "utf8");
}

export function resolveDeps(reg: Registry, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    if (stack.has(name)) throw new Error(`dependency cycle at ${name}`);
    const item = reg.items[name];
    if (!item) throw new Error(`unknown feature: ${name}`);
    stack.add(name);
    for (const dep of item.dependsOn ?? []) visit(dep);
    stack.delete(name);
    seen.add(name);
    out.push(name);
  };
  for (const n of names) visit(n);
  return out;
}
