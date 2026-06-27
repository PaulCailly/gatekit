import assert from "node:assert/strict";
import { test } from "node:test";

// reactions.ts → gh.js constructs an Octokit and reads context.repo at import,
// both of which throw without these env vars. Set them before the dynamic import.
process.env.GITHUB_TOKEN ||= "test-token";
process.env.GITHUB_REPOSITORY ||= "owner/repo";
const { trackTriggerReaction } = await import("./reactions.js");
type ReactionDeps = Parameters<typeof trackTriggerReaction>[1] & object;

/** A fake Octokit + core that records calls and lets tests force failures. */
function makeFake(opts: { failCreate?: boolean; failDelete?: boolean } = {}) {
  const calls: string[] = [];
  let nextId = 100;
  const deps: ReactionDeps = {
    owner: "o",
    repo: "r",
    core: { warning: () => calls.push("warn") },
    octokit: {
      rest: {
        reactions: {
          async createForIssueComment(p) {
            calls.push(`create:${p.content}`);
            if (opts.failCreate) throw new Error("create boom");
            return { data: { id: nextId++ } };
          },
          async deleteForIssueComment(p) {
            calls.push(`delete:${p.reaction_id}`);
            if (opts.failDelete) throw new Error("delete boom");
            return {};
          },
        },
      },
    },
  };
  return { deps, calls };
}

test("undefined commentId → no API calls at all", async () => {
  const { deps, calls } = makeFake();
  const r = trackTriggerReaction(undefined, deps);
  await r.inProgress();
  await r.done();
  assert.deepEqual(calls, []);
});

test("happy path: 👀 on start, then delete 👀 + add 👍 on done", async () => {
  const { deps, calls } = makeFake();
  const r = trackTriggerReaction(42, deps);
  await r.inProgress();
  await r.done();
  // eyes added (id 100), then deleted first, then +1 added.
  assert.deepEqual(calls, ["create:eyes", "delete:100", "create:+1"]);
});

test("inProgress failure is swallowed and skips the delete on done", async () => {
  const { deps, calls } = makeFake({ failCreate: true });
  const r = trackTriggerReaction(42, deps);
  await assert.doesNotReject(() => r.inProgress());
  // No eyesId captured (create failed), so done() only attempts +1 — which also
  // fails here (same fake), but is swallowed. No delete is attempted.
  await assert.doesNotReject(() => r.done());
  assert.deepEqual(
    calls.filter((c) => c.startsWith("delete")),
    [],
  );
  assert.ok(calls.includes("warn"));
});

test("a failing delete still lets the 👍 add proceed", async () => {
  const { deps, calls } = makeFake({ failDelete: true });
  const r = trackTriggerReaction(42, deps);
  await r.inProgress();
  await assert.doesNotReject(() => r.done());
  // delete attempted (and failed), but +1 is still added independently.
  assert.deepEqual(calls, ["create:eyes", "delete:100", "warn", "create:+1"]);
});
