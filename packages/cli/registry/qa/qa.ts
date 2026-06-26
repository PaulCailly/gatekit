/**
 * `/qa` — opt-in, Gemini-driven exploratory QA of the PR's deployed preview.
 *
 * A Gemini 3.5 Flash computer-use agent drives a real browser against the PR's
 * Vercel preview and explores it like a curious user — clicking through pages
 * and sub-pages, trying forms and buttons, with no scripted plan and no dev
 * tools — then reports what it found, graded by criticality, as a sticky PR
 * comment (the same shape `/review` posts).
 *
 *   /qa            → scoped: concentrate on the areas this PR changed (cheap)
 *   /qa all        → full-app sweep before a release / high-blast-radius change
 *   /qa <url>      → test an explicit URL instead of the resolved preview
 *
 * Runs from the trusted base branch on the `issue_comment` event, so the
 * GEMINI_API_KEY secret is never exposed to PR-authored code. The agent only
 * drives a browser against the already-deployed preview — it never executes PR
 * code on the runner.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

import { context, core, octokit, owner, repo } from "./lib/gh.js";
import { trackTriggerReaction } from "./lib/reactions.js";
import {
  continueInteraction,
  finalText,
  functionCalls,
  startInteraction,
  usageOf,
  type FunctionResult,
  type FunctionTool,
  type InteractionInput,
} from "./lib/gemini.js";
import { captureState, executeAction } from "./lib/browser.js";
import { uploadVideo } from "./lib/recorder.js";
import { readMemory, synthesizeMemory, writeMemory } from "./lib/qa-memory.js";
import { mintSession, seedSession, type QaSession } from "./lib/qa-auth.js";
import {
  affectedAreas,
  attachStateToResults,
  budgetFor,
  buildReport,
  buildTurnHint,
  isAllowedUrl,
  normalizeFinding,
  parseQaCommand,
  QA_CONFIG,
  trailingRepeats,
  type QaFinding,
  type QaMode,
} from "./lib/qa-core.js";

const REPORT_MARKER = "<!-- qa:report -->";
const STATUS_MARKER = "<!-- qa:status -->";

/** Post a FRESH comment (like `/review` does) and return its id — so each run's
 *  status + recap show at the bottom of the thread, not edited in place at some
 *  old position. Best-effort. */
async function postComment(prNumber: number, body: string): Promise<number | undefined> {
  try {
    const r = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    return r.data.id;
  } catch (err) {
    core.warning(`Comment failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Edit a comment by id (the in-progress → complete/failed transition within one
 *  run); falls back to a fresh comment if the id is missing. Best-effort. */
async function editComment(id: number | undefined, prNumber: number, body: string): Promise<void> {
  try {
    if (id) await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    else await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (err) {
    core.warning(`Comment update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The custom tool the agent calls to log an issue the moment it spots one. */
const REPORT_FINDING_TOOL: FunctionTool = {
  type: "function",
  name: "report_finding",
  description:
    "Record a QA issue you found (a bug, broken flow, confusing UX, visual glitch, " +
    "error message, or dead end). Call this as soon as you notice something — you can " +
    "call it many times. Grade its criticality honestly.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      severity: {
        type: "string",
        enum: ["critical", "major", "minor", "info"],
        description:
          "critical = flow is broken / data loss / crash; major = feature works wrong; " +
          "minor = small UX/visual issue; info = nit or observation.",
      },
      area: { type: "string", description: "Screen or feature, e.g. 'coach', 'onboarding'." },
      title: { type: "string", description: "One-line summary of the issue." },
      description: { type: "string", description: "What's wrong and why it matters." },
      steps_to_reproduce: { type: "string", description: "The clicks/inputs that led here." },
      expected: { type: "string", description: "What you expected to happen." },
      actual: { type: "string", description: "What actually happened." },
    },
    required: ["severity", "area", "title", "description"],
  },
};

function systemInstruction(mode: QaMode, scopeLine: string, session: QaSession | null, memory: string): string {
  return [
    "You are an experienced QA tester exploring a web app to find problems, driving a real browser.",
    "",
    ...(memory.trim()
      ? [
          "## What past QA runs learned (your memory — use it, don't just repeat it)",
          "Use this to skip what's already mapped, go DEEPER into less-explored areas, and re-check the known issues",
          "(report one only if it's still broken). Treat it as fallible — verify, don't assume.",
          "",
          memory.trim(),
          "",
        ]
      : []),
    "## How to explore (no fixed script — behave like a curious real user)",
    "- Systematically dig into every branch of the app: open each top-level navigation entry, then within each screen open its sub-pages, panels, tabs, and modals. Cover breadth first, then go deeper where it's interesting.",
    "- Actually USE the app: fill in and submit forms, toggle settings, press buttons, follow flows to their end. Try both the happy path and slightly odd input (empty, very long, wrong format) the way a real user might.",
    "- Be efficient with your turns — don't repeat the same screen or re-do an action that already worked. Once an area is covered, move on to one you haven't seen.",
    "",
    "## Hard rules",
    "- You only have what a normal user has: mouse, keyboard, scrolling, and the browser Back button. You do NOT have dev tools, a console, or the address bar — never try to navigate by typing a URL or running scripts. Discover pages by clicking.",
    session
      ? "- You are already signed in as a disposable TEST user — explore the authenticated app thoroughly. Do NOT sign out, and do NOT change the account's login details (phone number, linked Apple/Google). Still avoid other irreversible/destructive actions (deleting data, payments) — note them as findings instead and move on."
      : "- Stay within this app. Do not log in with real credentials, do not complete payments or other irreversible/destructive actions, and do not try to solve CAPTCHAs — note them as findings instead and move on.",
    "",
    "## Reporting",
    "- The instant you notice a bug, broken flow, confusing UX, visual glitch, error, or dead end, call `report_finding` with an honest severity. You may call it many times as you go.",
    "- If a screen is fine, just keep exploring — don't report 'looks good'.",
    "- When you have covered the relevant surface, stop calling actions and reply with a one-paragraph summary of what you exercised.",
    "",
    `## This run: ${mode === "full" ? "FULL-APP SWEEP — cover the whole app." : "SCOPED — concentrate on what this PR changed."}`,
    scopeLine,
  ].join("\n");
}

/** Resolve the PR's preview URL from its GitHub deployments (Vercel posts one
 *  per push with an `environment_url`), falling back to a vercel.app commit
 *  status target. Returns null if none is found yet. */
async function resolvePreviewUrl(headSha: string): Promise<string | null> {
  try {
    const deployments = await octokit.paginate(octokit.rest.repos.listDeployments, {
      owner,
      repo,
      sha: headSha,
      per_page: 100,
    });
    for (const d of deployments) {
      const statuses = await octokit.paginate(octokit.rest.repos.listDeploymentStatuses, {
        owner,
        repo,
        deployment_id: d.id,
        per_page: 100,
      });
      const ok = statuses.find((s) => s.state === "success" && s.environment_url);
      if (ok?.environment_url) {
        core.info(`Preview resolved from deployment ${d.id}: ${ok.environment_url}`);
        return ok.environment_url;
      }
    }
    core.info(`No deployment with an environment_url for ${headSha} (${deployments.length} deployment(s)); trying commit statuses.`);
  } catch (err) {
    core.warning(`Deployment lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { data } = await octokit.rest.repos.listCommitStatusesForRef({ owner, repo, ref: headSha, per_page: 100 });
    const ok = data.find((s) => s.state === "success" && /vercel\.app/.test(s.target_url ?? ""));
    if (ok?.target_url) {
      core.info(`Preview resolved from commit status: ${ok.target_url}`);
      return ok.target_url;
    }
    core.info(`No vercel.app commit status for ${headSha} either; no preview found.`);
  } catch (err) {
    core.warning(`Commit-status lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

interface ExploreResult {
  findings: QaFinding[];
  turns: number;
  note?: string;
  /** The agent's closing prose summary when it finished on its own. */
  summary?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** The session video bytes (.webm), or null if recording/extraction failed. */
  video: Buffer | null;
  /** Distinct URL paths the agent visited, for the QA memory. */
  paths: string[];
}

/** Drive the computer-use agent over the target until it finishes or the turn
 *  budget runs out, collecting findings reported along the way. */
async function explore(
  targetUrl: string,
  mode: QaMode,
  scopeLine: string,
  session: QaSession | null,
  memory: string,
): Promise<ExploreResult> {
  const origin = new URL(targetUrl).origin;
  const budget = budgetFor(mode);
  const findings: QaFinding[] = [];
  const visited: string[] = [];
  let note: string | undefined;
  const startedAt = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let video: Buffer | null = null;
  const videoDir = path.join(os.tmpdir(), `qa-video-${startedAt}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    // Record the whole session to a .webm (viewport screencast — no page-side JS,
    // so it never slows the run). The pulse ripples the agent drops on each click
    // are rendered DOM, so they show up in the video.
    const ctx = await browser.newContext({
      viewport: QA_CONFIG.screen,
      recordVideo: { dir: videoDir, size: QA_CONFIG.screen },
    });
    const page = await ctx.newPage();

    // Authenticated exploration: seed the Supabase session into localStorage
    // BEFORE the app's scripts run, so supabase-js adopts it on init and the
    // agent lands signed in (atlas has no password-form login to drive). The
    // agent never sees the credentials. Best-effort — registered before `goto`.
    if (session) await seedSession(page, session);

    await page.goto(targetUrl, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    if (session) {
      // Let supabase-js read the seeded token and any auth-gated redirect settle.
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      core.info(`Signed in as ${session.label}; now at ${page.url()}`);
    }

    const first = await captureState(page);
    let interaction = await startInteraction(
      systemInstruction(mode, scopeLine, session, memory),
      [
        {
          type: "text",
          text: session
            ? `You are signed in as a test user, now on ${page.url()}. Begin exploring the authenticated app.`
            : `You are on ${targetUrl}. Begin exploring.`,
        },
        { type: "image", data: first.screenshotBase64, mime_type: "image/png" },
      ],
      [REPORT_FINDING_TOOL],
    );
    {
      const u = usageOf(interaction);
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      core.info(`First-turn usage: in=${u.inputTokens} out=${u.outputTokens}`);
    }

    // Guard a silent shape mismatch: if the very first turn yields neither an
    // action nor any model text, we can't drive the browser — most likely the
    // computer-use response shape changed (e.g. an @google/genai bump). Fail
    // loudly instead of falling through to a misleading "no issues found".
    if (functionCalls(interaction).length === 0 && !finalText(interaction)) {
      throw new Error(
        `Gemini (${QA_CONFIG.model}) returned no actions and no text on the first turn — the model id may be ` +
          "wrong/unavailable for computer use, or the @google/genai response shape changed. Aborting rather than reporting a false clean bill of health.",
      );
    }

    let turn = 0;
    for (; turn < budget; turn++) {
      const calls = functionCalls(interaction);
      if (calls.length === 0) break; // agent decided it's done

      // Execute UI actions; collect findings from report_finding calls.
      const results: FunctionResult[] = [];
      for (const call of calls) {
        if (call.name === "report_finding") {
          const f = normalizeFinding(call.arguments);
          if (f) findings.push(f);
          results.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result: [{ type: "text", text: "recorded" }],
          });
          continue;
        }
        let status: string;
        try {
          status = await executeAction(page, call);
        } catch (err) {
          status = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        results.push({
          type: "function_result",
          name: call.name,
          call_id: call.id,
          result: [{ type: "text", text: status }],
        });
      }

      // One fresh screenshot per turn. If a click left the app, come back —
      // testing the app means staying on its origin.
      const state = await captureState(page);
      let leftApp = false;
      if (!isAllowedUrl(state.url, origin)) {
        leftApp = true;
        await page.goBack().catch(() => {});
        await page.waitForTimeout(800);
      }
      const after = leftApp ? await captureState(page) : state;
      visited.push(after.url);

      // Append the screenshot + nudge to the right result (never clobbering a
      // report_finding ack) and send the turn back.
      const hint = buildTurnHint({
        url: after.url,
        leftApp,
        repeats: trailingRepeats(visited),
        stuckThreshold: QA_CONFIG.stuckThreshold,
      });
      const withState = attachStateToResults(results, hint, after.screenshotBase64);

      // On the final permitted turn, skip the round-trip whose response the loop
      // would never inspect (it exits on the next condition check) — that call
      // is pure wasted Gemini + image cost, multiplied over a /qa all sweep.
      if (turn < budget - 1) {
        interaction = await continueInteraction(interaction.id, withState as InteractionInput[], [REPORT_FINDING_TOOL]);
        const u = usageOf(interaction);
        inputTokens += u.inputTokens;
        outputTokens += u.outputTokens;
      }
    }

    let summary: string | undefined;
    if (turn >= budget) {
      note = `Reached the ${budget}-step budget for a ${mode} run; stopping here. Comment \`/qa all\` for a deeper sweep.`;
      core.info(note);
    } else {
      summary = finalText(interaction) || undefined;
      core.info(`Agent finished after ${turn} step(s): ${(summary ?? "").slice(0, 200)}`);
    }

    // Finalize the video: closing the context flushes the .webm to disk, then we
    // read the bytes. Done before the browser closes; best-effort.
    try {
      const handle = page.video();
      await ctx.close();
      if (handle) {
        video = readFileSync(await handle.path());
        core.info(`Session video: ${(video.length / 1_048_576).toFixed(1)} MB.`);
      }
    } catch (err) {
      core.warning(`Video capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      findings,
      turns: turn,
      note,
      summary,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
      video,
      paths: [
        ...new Set(
          visited.map((u) => {
            try {
              return new URL(u).pathname;
            } catch {
              return u;
            }
          }),
        ),
      ],
    };
  } finally {
    await browser.close();
  }
}

async function run(): Promise<void> {
  const prNumber = context.payload.issue?.number ?? context.payload.pull_request?.number;
  if (!prNumber) {
    core.info("No pull request in context; nothing to QA.");
    return;
  }

  const commentBody = context.payload.comment?.body ?? "/qa";
  const reaction = trackTriggerReaction(context.payload.comment?.id);
  const { mode, url } = parseQaCommand(commentBody);

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha = pr.head.sha;

  // Resolve the target: an explicit URL wins; otherwise the PR's preview.
  const targetUrl = url ?? (await resolvePreviewUrl(headSha));
  if (!targetUrl) {
    await postComment(
      prNumber,
      [
        "## 🕵️ QA could not start",
        "",
        "No preview URL found for this PR yet — wait for the Vercel preview deployment to finish, " +
          "then comment `/qa` again, or point me at one with `/qa <url>`.",
        "",
        STATUS_MARKER,
      ].join("\n"),
    );
    core.info("No preview URL resolved; asked the author to retry.");
    return;
  }

  // Scope line: for a scoped run, point the agent at the areas the PR touched.
  let scopeLine = "Explore broadly.";
  if (mode === "scoped") {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
    const areas = affectedAreas(files.map((f) => f.filename));
    scopeLine = areas.length
      ? `This PR changed these areas — start and spend most of your effort there: ${areas.join(", ")}. Branch out only if you have budget left.`
      : "This PR's changes don't map to a specific screen; do a light pass over the main flows.";
  }
  const scopeNote = mode === "scoped" ? `_${scopeLine}_` : undefined;

  const statusId = await postComment(
    prNumber,
    [
      "## 🕵️ QA exploration in progress",
      "",
      `A Gemini computer-use agent is exploring ${targetUrl} like a user` +
        (mode === "full" ? " (full-app sweep)." : " (scoped to this PR's changes)."),
      "This takes a few minutes — hang tight.",
      "",
      STATUS_MARKER,
    ].join("\n"),
  );

  await reaction.inProgress();
  try {
    // Mint a Supabase session for the disposable test user (best-effort); when
    // unavailable the agent explores the logged-out surface.
    const session = await mintSession();
    if (session) core.info(`QA login enabled for ${session.label}.`);

    // Load the QA memory and feed it to the agent so this run starts smarter.
    const memory = await readMemory();
    if (memory.content) core.info(`QA memory loaded (${memory.content.length} chars).`);

    const { findings, turns, note, summary, inputTokens, outputTokens, durationMs, video, paths } = await explore(
      targetUrl,
      mode,
      scopeLine,
      session,
      memory.content,
    );
    const costUsd = (inputTokens * QA_CONFIG.pricing.input + outputTokens * QA_CONFIG.pricing.output) / 1_000_000;
    const metrics = {
      steps: turns,
      budget: QA_CONFIG.budgets[mode],
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
    };
    core.info(`QA metrics: ${turns} steps, ${inputTokens}/${outputTokens} tok, ~$${costUsd.toFixed(4)}, ${Math.round(durationMs / 1000)}s.`);

    // Publish the session video (best-effort — never blocks the report).
    let replayUrl: string | null = null;
    if (video && video.length > 0) {
      replayUrl = await uploadVideo(video, `qa-replays/pr-${prNumber}/${mode}-${Date.now()}.webm`);
      core.info(replayUrl ? `Video published: ${replayUrl}` : `Video not published (no blob creds or upload failed).`);
    } else {
      core.info("Video skipped: no recording captured.");
    }

    // Update the in-progress status to a complete summary, then post the fresh
    // recap right below it (so both land at the bottom of the thread this run).
    await editComment(
      statusId,
      prNumber,
      [`## ✅ QA exploration complete`, "", `Found ${findings.length} issue(s) in ${turns} step(s). Full recap below ⬇️`, "", STATUS_MARKER].join("\n"),
    );

    await postComment(
      prNumber,
      buildReport({ mode, targetUrl, findings, turns, scopeNote, note, summary, marker: REPORT_MARKER, metrics, replayUrl }),
    );

    // Distil this run into the QA memory for next time (best-effort).
    try {
      const facts = {
        date: new Date().toISOString().slice(0, 10),
        mode,
        target: targetUrl,
        paths,
        findings: findings.map((f) => `${f.severity}: ${f.title} (${f.area})`),
        summary: summary ?? note ?? "",
      };
      const updated = await synthesizeMemory(memory.content, facts);
      if (updated && updated !== memory.content) {
        core.info((await writeMemory(updated, memory.sha)) ? "QA memory updated." : "QA memory not committed.");
      } else {
        core.info("QA memory unchanged.");
      }
    } catch (err) {
      core.warning(`QA memory step failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    core.info(`QA complete: ${findings.length} finding(s) over ${turns} step(s).`);
  } catch (err) {
    // Close the loop on failure: without this the "in progress" status comment
    // lingers forever (the agent crashed, hit a rate limit, the browser died,
    // the preview 404'd after resolution…) with no report and no signal. Rewrite
    // it to an error, then rethrow so the job still fails.
    const reason = err instanceof Error ? err.message : String(err);
    await editComment(
      statusId,
      prNumber,
      [`## ❌ QA exploration failed`, "", `The run did not complete: ${reason}`, "", "Fix the cause and comment `/qa` again.", "", STATUS_MARKER].join("\n"),
    );
    throw err;
  } finally {
    await reaction.done();
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
