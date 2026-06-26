/**
 * A living QA memory: a markdown file (committed to `main`) that accumulates what
 * past `/qa` runs learned — the app map, gotchas, known issues, exploration tips —
 * so each run starts smarter. Read at run start (injected into the agent's prompt),
 * synthesized + written back at run end. All best-effort: never fails the QA run.
 */
import { core, octokit, owner, repo } from "./gh.js";
import { DEFAULT_MODEL_KEY, MODELS, getClient } from "./openrouter.js";

const MEMORY_PATH = ".github/sentinel/QA-MEMORY.md";

/** The current memory + its blob sha (needed to update it). Empty on first run. */
export async function readMemory(): Promise<{ content: string; sha: string | undefined }> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: MEMORY_PATH, ref: "main" });
    const data = res.data as { content?: string; sha?: string };
    if (data.content) {
      return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    }
  } catch {
    /* 404 → no memory yet */
  }
  return { content: "", sha: undefined };
}

/** Commit the updated memory to `main` with `[skip ci]` (so it doesn't trigger
 *  semantic-release or re-run CI). Best-effort; returns whether it landed. */
export async function writeMemory(content: string, sha: string | undefined): Promise<boolean> {
  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: MEMORY_PATH,
      branch: "main",
      message: "chore(qa): update QA-MEMORY [skip ci]",
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
    });
    return true;
  } catch (err) {
    core.warning(`QA memory write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface RunFacts {
  date: string;
  mode: string;
  target: string;
  paths: string[];
  findings: string[];
  summary: string;
}

/** Merge this run's facts into the existing memory via a cheap model. Returns the
 *  full updated markdown (or the existing memory unchanged if synthesis fails). */
export async function synthesizeMemory(existing: string, facts: RunFacts): Promise<string> {
  const prompt = [
    "You maintain a living QA memory for a web app — used to make each exploratory QA run smarter.",
    "Update the memory with what THIS run learned, then return ONLY the full updated markdown (no preamble).",
    "",
    "Rules:",
    "- Keep exactly these sections, creating any that are missing:",
    "  `## 🗺️ Map / paths explored`, `## ⚠️ Gotchas & quirks`, `## 🐞 Known issues`, `## 💡 Exploration tips`.",
    "- MERGE and DEDUPE — never repeat an entry. Keep the whole file concise (aim under ~250 lines).",
    "- Map: distinct screens/routes and how to reach them (e.g. via which nav item / modal).",
    "- Known issues: keep open bugs as a checklist; tag each with `(last seen <date>)`. If a previously-known",
    "  bug was NOT seen this run, leave it but it may be fixed — don't delete, just keep its last-seen date.",
    "- Gotchas: durable quirks (a page that needs an action to load, URL-encoding traps, the auth/login path…).",
    "- Tips: how to explore efficiently next time, and which areas still look unexplored.",
    "- Be terse and factual. No fluff.",
    "",
    `### This run — ${facts.date} · ${facts.mode} · ${facts.target}`,
    `Paths visited: ${facts.paths.join(", ") || "—"}`,
    `Findings: ${facts.findings.join(" | ") || "none"}`,
    `Agent's coverage summary: ${facts.summary || "—"}`,
    "",
    "### Existing memory (update this)",
    existing || "(empty — create it from scratch, with the four sections above)",
  ].join("\n");
  try {
    const resp = await getClient().chat.completions.create({
      model: MODELS[DEFAULT_MODEL_KEY].slug,
      max_tokens: 4000,
      messages: [
        { role: "system", content: "You curate a concise, deduplicated QA knowledge base. Output only the markdown." },
        { role: "user", content: prompt },
      ],
    });
    const out = resp.choices[0]?.message?.content?.trim();
    return out && out.length > 0 ? out : existing;
  } catch (err) {
    core.warning(`QA memory synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return existing;
  }
}
