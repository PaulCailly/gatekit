import { core, octokit, owner, repo } from "./gh.js";

// GitHub's reaction API has no ✅ checkmark — its only contents are
// +1 -1 laugh confused heart hooray rocket eyes. So we acknowledge a job with
// 👀 (eyes) and mark it finished by flipping that to 👍 (+1).
const EYES = "eyes" as const;
const DONE = "+1" as const;

/** The narrow slice of Octokit + `core` this helper needs. Narrowing it (rather
 *  than depending on the concrete client) lets a unit test inject a fake without
 *  a real token; the real `octokit`/`core` satisfy it structurally. */
export interface ReactionDeps {
  octokit: {
    rest: {
      reactions: {
        createForIssueComment(params: {
          owner: string;
          repo: string;
          comment_id: number;
          content: "eyes" | "+1";
        }): Promise<{ data: { id: number } }>;
        deleteForIssueComment(params: {
          owner: string;
          repo: string;
          comment_id: number;
          reaction_id: number;
        }): Promise<unknown>;
      };
    };
  };
  core: { warning(message: string): void };
  owner: string;
  repo: string;
}

const realDeps: ReactionDeps = { octokit, core, owner, repo };

/** Tracks the acknowledgement reaction on the comment that triggered a job
 *  (e.g. the `/review` or `/debate` comment): 👀 while the job runs, then 👍
 *  when it finishes, removing the 👀 so the final state shows only "done".
 *
 *  Best-effort end-to-end: a missing comment id (e.g. a manual workflow run with
 *  no triggering comment) is a no-op, and any reaction API failure is logged but
 *  never thrown — reacting must never sink the job it's annotating. */
export function trackTriggerReaction(commentId: number | undefined, deps: ReactionDeps = realDeps) {
  const { octokit: gh, core: log, owner: o, repo: r } = deps;
  let eyesId: number | undefined;
  const warn = (what: string, err: unknown) =>
    log.warning(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  return {
    /** Acknowledge the trigger comment with 👀 as soon as the job starts. */
    async inProgress(): Promise<void> {
      if (commentId === undefined) return;
      try {
        const { data } = await gh.rest.reactions.createForIssueComment({
          owner: o,
          repo: r,
          comment_id: commentId,
          content: EYES,
        });
        eyesId = data.id;
      } catch (err) {
        warn("Could not add 👀 reaction", err);
      }
    },
    /** Flip the acknowledgement to 👍 and drop the 👀 once the job is done.
     *  Two independent best-effort steps: remove 👀 FIRST so a failure on the 👍
     *  add leaves the comment in its pre-trigger state rather than a stale
     *  "in progress" 👀, and keep them separate so one failing never skips the
     *  other (which would otherwise leave both reactions, or neither flipped). */
    async done(): Promise<void> {
      if (commentId === undefined) return;
      if (eyesId !== undefined) {
        try {
          await gh.rest.reactions.deleteForIssueComment({
            owner: o,
            repo: r,
            comment_id: commentId,
            reaction_id: eyesId,
          });
          eyesId = undefined;
        } catch (err) {
          warn("Could not remove 👀 reaction", err);
        }
      }
      try {
        await gh.rest.reactions.createForIssueComment({
          owner: o,
          repo: r,
          comment_id: commentId,
          content: DONE,
        });
      } catch (err) {
        warn("Could not add 👍 reaction", err);
      }
    },
  };
}
