import * as core from "@actions/core";
import * as github from "@actions/github";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error("GITHUB_TOKEN is not set");
}

export const octokit = github.getOctokit(token);
export const context = github.context;
export const { owner, repo } = context.repo;
export { core };

/** Create the sticky report comment identified by `marker`, or update the
 *  existing one in place. `label` names the comment in the log line (e.g.
 *  "compliance" / "code-quality"). */
export async function upsertComment(
  prNumber: number,
  marker: string,
  body: string,
  label: string,
): Promise<void> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const mine = existing.find((c) => (c.body ?? "").includes(marker));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
    core.info(`Updated ${label} comment ${mine.id}.`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    core.info(`Posted ${label} comment.`);
  }
}
