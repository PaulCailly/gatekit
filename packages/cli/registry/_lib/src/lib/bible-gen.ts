/**
 * bible-gen.ts — pure, testable Opus overlay generator.
 *
 * Exports four functions:
 *   buildBiblePrompt  — assemble the prompt asking Opus for a QaOverlay JSON
 *   parseOverlay      — parse (and fence-strip) the model's JSON response
 *   validateOverlay   — check overlay references against the generated route set
 *   generateBible     — orchestrate: gather context → prompt → complete → parse → validate
 *
 * The LLM call is injected via the `complete` parameter so unit tests never
 * reach a real model.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { GeneratedRoute, QaOverlay, QaDomain } from "./qa-map.js";
import type { QaConfig, GeneratedFile } from "./route-extract.js";

// ── constants ────────────────────────────────────────────────────────────────

const MAX_DOC_CHARS = 8_000; // per-file truncation cap

// ── buildBiblePrompt ────────────────────────────────────────────────────────

export interface BiblePromptCtx {
  routes: GeneratedRoute[];
  locales: string[];
  readme: string;
  docs: string;
  pkgName: string;
}

export function buildBiblePrompt(ctx: BiblePromptCtx): { system: string; user: string } {
  const system = `\
You are an expert QA architect drafting the semantic overlay for a QA bible.

Your job is to analyse the app's route list and any provided documentation, then
produce a JSON object that matches the QaOverlay interface exactly:

{
  "domains": [
    {
      "key": "<snake_case_id>",
      "label": "<Human label>",
      "routes": ["<route path>", ...],
      "preconditions": ["<setup note>", ...]
    }
  ],
  "routePreconditions": { "<route path>": ["<note>", ...] },
  "outOfScope": ["<route path>", ...],
  "enabledModules": ["<module key>", ...]
}

Rules:
- Every key in domains[].routes, routePreconditions, and outOfScope MUST be an
  exact path from the provided route list.
- Group related routes into logical domains for /qa focus fan-out.
- preconditions: list data / account state the tester must set up before visiting
  that domain.
- outOfScope: routes that are purely informational, hardware-dependent (camera,
  printer), payment-only, or otherwise untestable via browser automation.
- enabledModules: list the module keys (second path segment under /modules) that
  are enabled for this app.
- Respond with ONLY the JSON object (no extra prose, no markdown fences).`;

  const routeLines = ctx.routes
    .map((r) => `  ${r.path}  (section: ${r.section}${r.module ? `, module: ${r.module}` : ""})`)
    .join("\n");

  const docSection =
    ctx.readme || ctx.docs
      ? `\n\n## Documentation excerpt\n\n${[ctx.readme, ctx.docs].filter(Boolean).join("\n\n---\n\n")}`
      : "";

  const user = `\
## App: ${ctx.pkgName}
## Locales: ${ctx.locales.join(", ") || "none"}

## Routes (${ctx.routes.length} total)
${routeLines}
${docSection}

Draft the QaOverlay JSON for this app. Group routes into semantic domains,
identify preconditions, mark out-of-scope routes, and list enabled modules.
Return ONLY valid JSON matching the QaOverlay interface — no fences, no prose.`;

  return { system, user };
}

// ── parseOverlay ────────────────────────────────────────────────────────────

/** Strip optional ` ```json … ``` ` fences and parse the JSON into a QaOverlay.
 *  Throws with a descriptive message if the shape is malformed. */
export function parseOverlay(raw: string): QaOverlay {
  // Strip code fences (``` or ```json)
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`parseOverlay: invalid JSON — ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parseOverlay: expected a JSON object at the top level");
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.domains)) {
    throw new Error("parseOverlay: missing or non-array 'domains' key");
  }
  if (typeof obj.routePreconditions !== "object" || obj.routePreconditions === null || Array.isArray(obj.routePreconditions)) {
    throw new Error("parseOverlay: missing or non-object 'routePreconditions' key");
  }
  if (!Array.isArray(obj.outOfScope)) {
    throw new Error("parseOverlay: missing or non-array 'outOfScope' key");
  }
  if (!Array.isArray(obj.enabledModules)) {
    throw new Error("parseOverlay: missing or non-array 'enabledModules' key");
  }

  return obj as unknown as QaOverlay;
}

// ── validateOverlay ─────────────────────────────────────────────────────────

/** Returns a list of problems. Empty array = valid. */
export function validateOverlay(overlay: QaOverlay, generated: GeneratedFile): string[] {
  const knownPaths = new Set(generated.routes.map((r) => r.path));
  const problems: string[] = [];

  if (overlay.domains.length === 0) {
    problems.push("overlay has no domains — add at least one domain");
  }

  for (const domain of overlay.domains) {
    if (!domain.routes || domain.routes.length === 0) {
      problems.push(`domain "${domain.key}" has no routes`);
    }
    for (const r of domain.routes ?? []) {
      if (!knownPaths.has(r)) {
        problems.push(`domain "${domain.key}" references unknown route: ${r}`);
      }
    }
  }

  for (const r of Object.keys(overlay.routePreconditions)) {
    if (!knownPaths.has(r)) {
      problems.push(`routePreconditions references unknown route: ${r}`);
    }
  }

  for (const r of overlay.outOfScope) {
    if (!knownPaths.has(r)) {
      problems.push(`outOfScope references unknown route: ${r}`);
    }
  }

  return problems;
}

// ── generateBible ────────────────────────────────────────────────────────────

export interface GenerateBibleOpts {
  rootDir: string;
  cfg: QaConfig;
  generated: GeneratedFile;
  complete: (p: { system: string; user: string }) => Promise<string>;
}

export interface GenerateBibleResult {
  overlay: QaOverlay;
  problems: string[];
}

/** Read a file best-effort (returns "" on any error), truncated to maxChars. */
function readBestEffort(filePath: string, maxChars: number): string {
  try {
    const full = readFileSync(filePath, "utf8");
    return full.length > maxChars ? full.slice(0, maxChars) + "\n…[truncated]" : full;
  } catch {
    return "";
  }
}

export async function generateBible(opts: GenerateBibleOpts): Promise<GenerateBibleResult> {
  const { rootDir, cfg, generated, complete } = opts;

  // Gather README (best-effort)
  let readme = "";
  for (const candidate of ["README.md", "readme.md", "README.txt"]) {
    const p = path.resolve(rootDir, candidate);
    if (existsSync(p)) {
      readme = readBestEffort(p, MAX_DOC_CHARS);
      break;
    }
  }

  // Gather cfg.docsForBible files (best-effort)
  const docParts: string[] = [];
  for (const rel of cfg.docsForBible ?? []) {
    const p = path.resolve(rootDir, rel);
    const content = readBestEffort(p, MAX_DOC_CHARS);
    if (content) docParts.push(content);
  }
  const docs = docParts.join("\n\n---\n\n");

  // Derive pkgName from rootDir
  const pkgName = path.basename(path.resolve(rootDir));

  const prompt = buildBiblePrompt({
    routes: generated.routes,
    locales: generated.locales,
    readme,
    docs,
    pkgName,
  });

  const raw = await complete(prompt);
  const overlay = parseOverlay(raw);
  const problems = validateOverlay(overlay, generated);

  return { overlay, problems };
}
