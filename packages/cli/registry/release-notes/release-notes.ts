/**
 * Release changelog generator. Runs when a `v*` tag is pushed (or via manual
 * dispatch): it reads the commits since the previous tag, asks an LLM — routed
 * through OpenRouter, GLM 5.2 first with fallbacks, like the other sentinel
 * jobs — to write categorized release notes, then:
 *   1. creates or updates the GitHub Release for the tag with those notes, and
 *   2. prepends a dated section to CHANGELOG.md (committed by the workflow).
 *
 * Deterministic-first: the raw commit list always reaches the release body, so
 * a flaky model never produces an empty changelog. Pure helpers live in
 * lib/release-core.ts so they're unit-tested without git/network.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type OpenAI from "openai";

import { context, core, octokit, owner, repo } from "./lib/gh.js";
import { fallbackSlugs, getClient } from "./lib/openrouter.js";
import { parseCommitLog, prependChangelogSection, rawCommitList, type Commit } from "./lib/release-core.js";

// Headroom for a large release: 2000 tokens truncates long changelogs mid-section.
const MAX_TOKENS = 4000;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// This script runs from .github/sentinel, but git history and CHANGELOG.md live
// at the repo root — anchor both there rather than relative to the cwd.
const ROOT = git("rev-parse", "--show-toplevel");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

/** The tag being released: the dispatch input, else the pushed ref name. */
function resolveTag(): string {
  const fromInput = process.env.RELEASE_TAG?.trim();
  if (fromInput) return fromInput;
  const ref = context.ref; // e.g. "refs/tags/v2.0.0"
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
  if (!tag) throw new Error(`No release tag found (ref="${ref}", RELEASE_TAG unset).`);
  return tag;
}

/** Previous **version** tag reachable from `tag`, or null for the first release. */
function previousTag(tag: string): string | null {
  try {
    // --match keeps a stray non-version tag (e.g. `latest`) from becoming the boundary.
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${tag}^`);
  } catch {
    return null;
  }
}

/** Commits in (prev, tag], newest first, excluding the bot's own [skip ci] noise. */
function commitsSince(prev: string | null, tag: string): Commit[] {
  const range = prev ? `${prev}..${tag}` : tag;
  return parseCommitLog(git("log", range, "--no-merges", "--pretty=format:%H%x09%s"));
}

/**
 * Ask the LLM for categorized Markdown notes; falls back to the raw list on any
 * error or empty output. Returns the notes and the model that actually answered
 * (OpenRouter's fallback routing may have used a downstream model).
 */
async function generateNotes(
  tag: string,
  prev: string | null,
  commits: Commit[],
): Promise<{ notes: string; model: string }> {
  const raw = rawCommitList(commits);
  const slugs = fallbackSlugs();
  const prompt = [
    `Write release notes for version \`${tag}\`${prev ? ` (changes since \`${prev}\`)` : " (first release)"}.`,
    "",
    "Group the commits below into Markdown sections with these headings, omitting any that are empty:",
    "`### ✨ Features`, `### 🐛 Fixes`, `### 🔧 Maintenance`, `### 📚 Docs`.",
    "Rewrite each entry as a concise, user-facing bullet (imperative mood, no commit prefixes like 'feat:'/'fix:').",
    "Keep the short hash in parentheses at the end of each bullet. Merge duplicates. No preamble, no version heading, no closing remarks.",
    "",
    "Commits (newest first):",
    raw,
  ].join("\n");

  try {
    const resp = await getClient().chat.completions.create({
      model: slugs[0],
      // OpenRouter fallback routing: tries each slug in order, bills the one that answers.
      models: slugs,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: "You write clear, categorized software release notes from a list of commits." },
        { role: "user", content: prompt },
      ],
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { models: string[] });
    const notes = resp.choices[0]?.message?.content?.trim();
    if (resp.choices[0]?.finish_reason === "length") {
      // The model hit the token cap mid-changelog; a half-written section is
      // worse than the deterministic list, so fall back rather than ship it.
      core.warning(`Release notes hit the ${MAX_TOKENS}-token cap and were truncated; using the raw commit list.`);
    } else if (notes) {
      return { notes, model: resp.model ?? slugs[0] };
    } else {
      core.warning("Model returned empty notes; using the raw commit list.");
    }
  } catch (err) {
    core.warning(`LLM changelog generation failed (${err instanceof Error ? err.message : String(err)}); using the raw commit list.`);
  }
  return { notes: `### Changes\n\n${raw}`, model: `${slugs[0]} (raw fallback)` };
}

/** Create the GitHub Release for `tag`, or update it in place if it already exists. */
async function publishRelease(tag: string, body: string): Promise<void> {
  let releaseId: number | null = null;
  try {
    const existing = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
    releaseId = existing.data.id;
  } catch (err) {
    // Only a genuine "no release for this tag" (404) should fall through to create;
    // a transient 5xx/403/network error must propagate, not silently create a dup.
    if ((err as { status?: number }).status !== 404) throw err;
  }
  if (releaseId !== null) {
    await octokit.rest.repos.updateRelease({ owner, repo, release_id: releaseId, body, name: tag });
    core.info(`Updated release ${tag}.`);
  } else {
    await octokit.rest.repos.createRelease({ owner, repo, tag_name: tag, name: tag, body });
    core.info(`Created release ${tag}.`);
  }
}

/** Prepend a dated section for `tag` to CHANGELOG.md, creating the file if absent. */
async function updateChangelog(tag: string, notes: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  let existing = "";
  try {
    existing = await readFile(CHANGELOG, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(CHANGELOG, prependChangelogSection(existing, tag, notes, date));
  core.info(`Prepended ${tag} to ${CHANGELOG}.`);
}

async function run(): Promise<void> {
  const tag = resolveTag();
  const prev = previousTag(tag);
  const commits = commitsSince(prev, tag);
  core.info(`Release ${tag}: ${commits.length} commit(s) since ${prev ?? "the beginning"}.`);

  const { notes, model } = commits.length
    ? await generateNotes(tag, prev, commits)
    : { notes: "_No notable changes._", model: fallbackSlugs()[0] };
  const body = `${notes}\n\n<sub>Generated via OpenRouter (${model}).</sub>`;

  await publishRelease(tag, body);
  await updateChangelog(tag, notes);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## 🚀 Release ${tag}\n\n${notes}\n`);
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
