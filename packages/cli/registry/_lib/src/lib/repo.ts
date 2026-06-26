import { octokit, owner, repo } from "./gh.js";

const MAX_FILE_BYTES = 60_000;

type Content = Awaited<ReturnType<typeof octokit.rest.repos.getContent>>["data"];

/** Read a file's full contents at a given ref (commit SHA / branch). */
export async function readFile(path: string, ref: string): Promise<string> {
  const clean = path.replace(/^[./]+/, "");
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path: clean, ref });
  if (Array.isArray(data)) throw new Error(`${clean} is a directory, not a file`);
  const file = data as Extract<Content, { content?: string }>;
  if (file.type !== "file" || file.content == null) {
    throw new Error(`${clean} is not a readable text file`);
  }
  let text = Buffer.from(file.content, "base64").toString("utf8");
  if (text.length > MAX_FILE_BYTES) {
    text = `${text.slice(0, MAX_FILE_BYTES)}\n…[truncated at ${MAX_FILE_BYTES} chars]`;
  }
  return text;
}

/** List the entries of a directory at a given ref. */
export async function listDir(path: string, ref: string): Promise<string> {
  const clean = path.replace(/^[./]+/, "");
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path: clean, ref });
  if (!Array.isArray(data)) return `${clean || "."} is a file, not a directory`;
  return data.map((e) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`).join("\n");
}

/** Recursive file listing for the repo at a given commit, capped. */
export async function fileTree(ref: string, cap = 800): Promise<string> {
  try {
    const { data: commit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: ref });
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });
    const paths = data.tree.filter((t) => t.type === "blob" && t.path).map((t) => t.path!);
    const shown = paths.slice(0, cap).join("\n");
    return paths.length > cap ? `${shown}\n…(${paths.length - cap} more files)` : shown;
  } catch {
    return "(file tree unavailable)";
  }
}

const GUIDELINE_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "README.md",
];

/** Inline the project's own guideline/architecture docs so the review is held
 *  to the repo's documented conventions. */
export async function guidelineDocs(ref: string): Promise<string> {
  const parts: string[] = [];
  for (const f of GUIDELINE_FILES) {
    try {
      parts.push(`### ${f}\n${await readFile(f, ref)}`);
    } catch {
      /* file not present in this repo */
    }
  }
  return parts.join("\n\n");
}
