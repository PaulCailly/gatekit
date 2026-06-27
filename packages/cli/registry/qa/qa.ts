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
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
import { captureState, evaluateLocale, executeAction } from "./lib/browser.js";
import { uploadVideo } from "./lib/recorder.js";
import { parseLedger, readMemory, synthesizeMemory, upsertLedger, writeMemory } from "./lib/qa-memory.js";
import { buildShardResult, mergeShards, buildAggregateReport, type ShardResult } from "./lib/qa-shard.js";
import { loadQaMap, coverageFor, unvisited, type QaMap, type Coverage } from "./lib/qa-map.js";
import {
  affectedAreas,
  attachStateToResults,
  budgetFor,
  buildPrContext,
  buildReport,
  buildTurnHint,
  classifyDownload,
  classifyLocale,
  downloadFinding,
  isAllowedUrl,
  localeFindings,
  localeRootUrl,
  looksLikePinScreen,
  normalizeFinding,
  offlineFindings,
  offlineWindowFor,
  parseQaCommand,
  QA_CONFIG,
  trailingRepeats,
  type ConsoleError,
  type DownloadRecord,
  type DownloadVerdict,
  type LocaleObservation,
  type LocaleVerdict,
  type PrComment,
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

/** Pull the route keys recorded in the QA-MEMORY coverage ledger (a fenced
 *  `qa-coverage` JSON block: {"routes":{"/path":"YYYY-MM-DD"}}). Best-effort:
 *  returns [] when the block is absent or malformed. */
function extractLedgerPaths(memory: string): string[] {
  return Object.keys(parseLedger(memory));
}

/** The full ledger map ({path: date}) from QA-MEMORY, for seeding upsertLedger so
 *  history survives an LLM that drops the block. Best-effort → {} on absence/parse error. */
function extractLedgerRoutes(memory: string): Record<string, string> {
  return parseLedger(memory);
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

interface QaCreds {
  email: string;
  password: string;
  /** Optional staff PIN (from QA_PIN); entered if the PIN gate appears. */
  pin?: string | null;
}

/** Deterministic sign-in before the agent takes over: email/password, then — if
 *  the staff-PIN screen appears — the PIN (creds.pin). Best-effort; never throws
 *  (the agent explores whatever state it lands in). */
async function signIn(page: import("playwright").Page, creds: QaCreds): Promise<void> {
  const pin = creds.pin ?? null;
  try {
    const signInName = /log\s?in|sign\s?in|connexion|se connecter/i;
    await page
      .getByRole("button", { name: signInName })
      .or(page.getByRole("link", { name: signInName }))
      .first()
      .click({ timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    await page.locator('input[type="email"], input[name="email"]').first().fill(creds.email, { timeout: 10_000 });
    await page.locator('input[type="password"], input[name="password"]').first().fill(creds.password);
    await page
      .getByRole("button", { name: /log\s?in|sign\s?in|connexion|se connecter|continue|submit/i })
      .first()
      .click({ timeout: 8000 })
      .catch(() => page.keyboard.press("Enter"));
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    core.info(`Signed in; now at ${page.url()}`);
  } catch (err) {
    core.warning(`Deterministic login failed (${err instanceof Error ? err.message : String(err)}); exploring logged-out.`);
    return;
  }

  // Staff-PIN gate (Chakra PinInput: four single-char fields, auto-submits on the
  // 4th digit). Detect by URL or by the presence of the 1-char inputs, then type.
  if (!pin) return;
  try {
    const pinFields = page.locator('input[maxlength="1"]');
    await pinFields.first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    const fieldCount = await pinFields.count().catch(() => 0);
    // looksLikePinScreen also matches /settings/…/pin routes, which is why the
    // fieldCount >= 4 AND-guard is required to confirm the Chakra PinInput is present.
    if (looksLikePinScreen(page.url()) && fieldCount >= 4) {
      const clicked = await pinFields.first().click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (clicked) {
        await page.keyboard.type(pin);
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        core.info(`Entered PIN; now at ${page.url()}`);
      }
    }
  } catch (err) {
    core.warning(`PIN entry failed (${err instanceof Error ? err.message : String(err)}); continuing.`);
  }
}

/** A short, capped list of in-scope routes the agent has NOT covered yet (across
 *  this app, given what past runs + this run's start already visited), with any
 *  preconditions — injected so the agent prioritises unexplored areas. */
function steeringBlock(map: QaMap, alreadyVisited: string[], focus: string | null): string {
  const todo = unvisited(map, alreadyVisited, focus ? { domain: focus } : {}).slice(0, 20);
  if (todo.length === 0) return "";
  const lines = todo.map((r) => {
    const pre = r.preconditions[0] ? ` — ${r.preconditions[0]}` : "";
    return `- ${r.path}${pre}`;
  });
  return [
    "## Map & coverage — areas still UNVISITED (reach them by clicking)",
    "You have a known map of this app. These expected areas have not been covered yet;",
    "prioritise them over re-visiting screens you've already seen. Some need setup first.",
    "If a route is genuinely unreachable for you, record a finding and move on.",
    ...lines,
  ].join("\n");
}

function systemInstruction(
  mode: QaMode,
  scopeLine: string,
  creds: QaCreds | null,
  memory: string,
  steering: string,
  prContext: string,
): string {
  return [
    "You are an experienced QA tester exploring a web app to find problems, driving a real browser.",
    "",
    ...(prContext.trim() ? [prContext.trim(), ""] : []),
    ...(steering.trim() ? [steering.trim(), ""] : []),
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
    creds
      ? "- You are already signed in as a disposable TEST user — explore the authenticated app thoroughly. Do NOT sign out, and do NOT change the account's email or password. Still avoid other irreversible/destructive actions (deleting data, payments) — note them as findings instead and move on."
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
  /** Files the agent downloaded during the run (export verification). */
  downloads: DownloadRecord[];
  /** Console/page errors captured during the run, tagged by network phase. */
  consoleErrors: ConsoleError[];
  /** Number of turns that executed while the network was offline (0 for non-offline runs). */
  offlineTurns: number;
}

/** Drive the computer-use agent over the target until it finishes or the turn
 *  budget runs out, collecting findings reported along the way. */
async function explore(
  targetUrl: string,
  mode: QaMode,
  scopeLine: string,
  creds: QaCreds | null,
  memory: string,
  prContext: string,
  map: QaMap | null,
  priorVisited: string[],
  focus: string | null,
  screen: { width: number; height: number },
  budgetOverride?: number,
  offlineWindow?: { start: number; end: number },
): Promise<ExploreResult> {
  const origin = new URL(targetUrl).origin;
  const budget = budgetOverride ?? budgetFor(mode);
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
      viewport: screen,
      recordVideo: { dir: videoDir, size: screen },
      acceptDownloads: true,
    });

    // Capture any export the agent triggers. Best-effort: a listener error or an
    // unreadable file records a 0-byte entry (which grades as a failed export)
    // rather than throwing out of the run.
    const downloads: DownloadRecord[] = [];
    const downloadWaits: Promise<void>[] = [];
    ctx.on("download", (download) => {
      downloadWaits.push(
        (async () => {
          let filename = "(unknown)";
          try {
            filename = download.suggestedFilename();
            const p = await download.path(); // resolves when the download completes
            const sizeBytes = p ? statSync(p).size : 0;
            downloads.push({ filename, sizeBytes });
            core.info(`Captured download: ${filename} (${sizeBytes} bytes).`);
          } catch (err) {
            downloads.push({ filename, sizeBytes: 0 });
            core.warning(`Download capture failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
          }
        })(),
      );
    });

    const page = await ctx.newPage();
    await page.goto(targetUrl, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);

    const consoleErrors: ConsoleError[] = [];
    let netPhase: "online" | "offline" | "resync" = "online";
    page.on("pageerror", (err) => consoleErrors.push({ phase: netPhase, kind: "pageerror", text: err.message }));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push({ phase: netPhase, kind: "console", text: msg.text().slice(0, 300) });
    });

    // Deterministic sign-in BEFORE the model takes over. The computer-use model
    // refuses to type credentials itself (Gemini blocks "automated login" at the
    // input layer), so we log in via the form here; the agent then explores an
    // already-authenticated page and never sees the credentials.
    if (creds) await signIn(page, creds);

    const first = await captureState(page);
    let steering = "";
    if (map) {
      try {
        steering = steeringBlock(map, priorVisited, focus);
      } catch (err) {
        core.warning(`Steering block failed; continuing without it: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let interaction = await startInteraction(
      systemInstruction(mode, scopeLine, creds, memory, steering, prContext),
      [
        {
          type: "text",
          text: creds
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

    let offlineTurns = 0;
    let turn = 0;
    for (; turn < budget; turn++) {
      const calls = functionCalls(interaction);
      if (calls.length === 0) break; // agent decided it's done

      if (offlineWindow && turn === offlineWindow.start) {
        netPhase = "offline";
        await ctx.setOffline(true).catch(() => {});
        core.info(`Network cut at turn ${turn} (offline probe).`);
      }
      if (offlineWindow && turn === offlineWindow.end) {
        await ctx.setOffline(false).catch(() => {});
        netPhase = "resync";
        core.info(`Network restored at turn ${turn} (resync).`);
      }

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
          status = await executeAction(page, call, screen);
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

      if (netPhase === "offline") offlineTurns++;
    }

    let summary: string | undefined;
    if (turn >= budget) {
      note = `Reached the ${budget}-step budget for a ${mode} run; stopping here. Comment \`/qa all\` for a deeper sweep.`;
      core.info(note);
    } else {
      summary = finalText(interaction) || undefined;
      core.info(`Agent finished after ${turn} step(s): ${(summary ?? "").slice(0, 200)}`);
    }

    // Drain in-flight downloads BEFORE closing the context — ctx.close() cancels
    // pending download streams, which would record 0-byte entries (false-positive
    // "Export download problem" major findings).
    await Promise.all(downloadWaits).catch(() => {});

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
      downloads,
      consoleErrors,
      offlineTurns,
    };
  } finally {
    await browser.close();
  }
}

/** Deterministic, logged-out localisation sweep: harness-navigates to each
 *  same-origin locale root and reads the DOM. Best-effort per locale — a load
 *  failure is recorded, never thrown. */
async function sweepLocales(
  targetUrl: string,
  locales: string[],
  screen: { width: number; height: number },
): Promise<{ observations: LocaleObservation[] }> {
  const origin = new URL(targetUrl).origin;
  const observations: LocaleObservation[] = [];
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: screen });
    const page = await ctx.newPage();
    for (const locale of locales) {
      const url = localeRootUrl(origin, locale);
      let loaded = false;
      // Neutral fallback so a goto/evaluate throw still records one observation
      // for this locale and the loop continues to the next.
      let dom: Awaited<ReturnType<typeof evaluateLocale>> = {
        htmlLang: null,
        dir: null,
        horizontalOverflowPx: 0,
        rawKeyHits: [],
        interpolationLeaks: [],
      };
      try {
        const resp = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await page.waitForTimeout(1200);
        loaded = !!resp && resp.status() < 400 && isAllowedUrl(page.url(), origin);
        dom = await evaluateLocale(page);
      } catch (err) {
        core.warning(`i18n: ${locale} failed to load: ${err instanceof Error ? err.message : String(err)}`);
      }
      observations.push({ locale, loaded, ...dom });
      core.info(`i18n: ${locale} loaded=${loaded} dir=${dom.dir} overflow=${dom.horizontalOverflowPx} keys=${dom.rawKeyHits.length}`);
    }
    await ctx.close().catch(() => {});
    return { observations };
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
  const { mode, url, focus, viewport } = parseQaCommand(commentBody);
  const screen = QA_CONFIG.viewports[viewport];

  // Load the QA map (best-effort: a broken/absent map just disables steering+coverage).
  let map: QaMap | null = null;
  try {
    map = loadQaMap();
  } catch (err) {
    core.warning(`QA map unavailable; running without steering/coverage: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Reject an unknown focus domain early, before spending any browser/Gemini budget.
  if (mode === "focus") {
    const valid = map?.domains.map((d) => d.key) ?? [];
    if (!focus || !valid.includes(focus)) {
      await postComment(prNumber, [
          "## 🕵️ QA focus — unknown domain",
          "",
          focus ? `\`${focus}\` isn't a known domain.` : "No domain given.",
          valid.length ? `Valid domains: ${valid.map((v) => `\`${v}\``).join(", ")}.` : "",
          "",
          STATUS_MARKER,
        ].join("\n"));
      core.info(`Unknown focus domain '${focus ?? ""}'; asked for a valid one.`);
      return;
    }
  }

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha = pr.head.sha;

  // PR context: what this change is about + what reviewers raised, so the agent
  // tests the actual change. Best-effort — never blocks the run.
  let prContext = "";
  try {
    const issueComments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: prNumber, per_page: 100 });
    const comments: PrComment[] = issueComments.map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "" }));
    prContext = buildPrContext({ title: pr.title ?? "", body: pr.body ?? null, comments });
    if (prContext) core.info(`PR context: ${prContext.length} chars from title/body + ${comments.length} comment(s).`);
  } catch (err) {
    core.warning(`PR context unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve the target: an explicit URL wins; otherwise the PR's preview.
  const targetUrl = url ?? (await resolvePreviewUrl(headSha));
  if (!targetUrl) {
    await postComment(prNumber, [
        "## 🕵️ QA could not start",
        "",
        "No preview URL found for this PR yet — wait for the Vercel preview deployment to finish, " +
          "then comment `/qa` again, or point me at one with `/qa <url>`.",
        "",
        STATUS_MARKER,
      ].join("\n"));
    core.info("No preview URL resolved; asked the author to retry.");
    return;
  }

  if (mode === "i18n") {
    // i18n mode intentionally skips the memory/ledger step: this is a logged-out
    // locale sweep and locale roots aren't meaningful coverage for the app's routes.
    const locales = map?.locales ?? [];
    if (locales.length === 0) {
      await postComment(prNumber, ["## 🕵️ QA i18n could not start", "", "The QA map (locale list) is unavailable, so the i18n sweep can't run.", "", STATUS_MARKER].join("\n"));
      core.info("i18n: no locale list; aborting.");
      return;
    }
    const statusId = await postComment(prNumber, [
      "## 🕵️ QA i18n sweep in progress",
      "",
      `Checking ${locales.length} locale(s) on ${targetUrl} — hang tight.`,
      "",
      STATUS_MARKER,
    ].join("\n"));
    await reaction.inProgress();
    try {
      const { observations } = await sweepLocales(targetUrl, locales, screen);
      const verdicts: LocaleVerdict[] = observations.map(classifyLocale);
      let findings: QaFinding[] = verdicts.flatMap(localeFindings);

      // Agent look at the Arabic (RTL) page — short, budget-capped, logged in if creds exist.
      // Intentional split: the deterministic sweep above runs logged-out (public locale
      // roots), while this agent pass logs in for a richer authenticated RTL view. If the
      // app overrides locale on login, the agent's `ar` view may differ from the sweep's
      // logged-out `ar` verdict — that's an acceptable dual signal, not a bug.
      const creds: QaCreds | null =
        process.env.QA_LOGIN_EMAIL && process.env.QA_LOGIN_PASSWORD
          ? { email: process.env.QA_LOGIN_EMAIL, password: process.env.QA_LOGIN_PASSWORD, pin: process.env.QA_PIN || null }
          : null;
      let rtlResult: ExploreResult | null = null;
      if (locales.includes("ar")) {
        try {
          const arUrl = localeRootUrl(new URL(targetUrl).origin, "ar");
          rtlResult = await explore(arUrl, "i18n", "Focus on the Arabic (RTL) layout: report mirrored/clipped/overlapping text, controls on the wrong side, or untranslated strings.", creds, "", prContext, null, [], null, screen, QA_CONFIG.budgets.i18n);
          findings = [...findings, ...rtlResult.findings];
        } catch (err) {
          core.warning(`i18n: Arabic agent pass failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Thread Arabic explore result: classify downloads, build metrics, upload video.
      const rtlDownloadVerdicts = rtlResult ? rtlResult.downloads.map(classifyDownload) : [];
      const rtlDownloadFindings = rtlDownloadVerdicts.map(downloadFinding).filter((f): f is QaFinding => f !== null);
      if (rtlDownloadFindings.length > 0) findings = [...findings, ...rtlDownloadFindings];

      const rtlMetrics = rtlResult
        ? {
            steps: rtlResult.turns,
            budget: QA_CONFIG.budgets.i18n,
            inputTokens: rtlResult.inputTokens,
            outputTokens: rtlResult.outputTokens,
            costUsd: (rtlResult.inputTokens * QA_CONFIG.pricing.input + rtlResult.outputTokens * QA_CONFIG.pricing.output) / 1_000_000,
            durationMs: rtlResult.durationMs,
          }
        : undefined;

      let rtlReplayUrl: string | null = null;
      if (rtlResult?.video && rtlResult.video.length > 0) {
        rtlReplayUrl = await uploadVideo(rtlResult.video, `qa-replays/pr-${prNumber}/i18n-ar-${Date.now()}.webm`);
        core.info(rtlReplayUrl ? `i18n Arabic video published: ${rtlReplayUrl}` : "i18n Arabic video not published (no blob creds or upload failed).");
      }

      await postComment(prNumber, buildReport({
          mode,
          targetUrl,
          findings,
          turns: rtlResult?.turns ?? 0,
          marker: REPORT_MARKER,
          i18n: verdicts,
          ...(rtlMetrics ? { metrics: rtlMetrics } : {}),
          replayUrl: rtlReplayUrl,
          ...(rtlDownloadVerdicts.length > 0 ? { downloads: rtlDownloadVerdicts } : {}),
          viewport,
        }));
      await editComment(statusId, prNumber, [`## ✅ QA i18n sweep complete`, "", `Checked ${verdicts.length} locale(s); ${verdicts.filter((v) => v.ok).length} clean.`, "", STATUS_MARKER].join("\n"));
      core.info(`i18n sweep complete: ${findings.length} finding(s) across ${verdicts.length} locale(s).`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await editComment(statusId, prNumber, [`## ❌ QA i18n failed`, "", `The i18n sweep did not complete: ${reason}`, "", "Fix the cause and comment `/qa i18n` again.", "", STATUS_MARKER].join("\n"));
      throw err;
    } finally {
      await reaction.done();
    }
    // Intentional: the i18n branch does NOT persist QA memory / the coverage ledger
    // (unlike scoped/full/focus/offline). The sweep is logged-out and locale roots
    // aren't meaningful route coverage, and the Arabic agent pass's paths/findings
    // are surfaced in the report but not worth threading into cross-run memory.
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
  if (mode === "focus" && map && focus) {
    const domain = map.domains.find((d) => d.key === focus);
    const routeList = (domain?.routes ?? []).join(", ");
    scopeLine = `FOCUS on the "${domain?.label ?? focus}" area only. Concentrate on these routes and their flows: ${routeList}. Don't wander outside this area.`;
  }
  const scopeNote = mode === "scoped" ? `_${scopeLine}_` : undefined;

  const statusId = await postComment(prNumber, [
      "## 🕵️ QA exploration in progress",
      "",
      `A Gemini computer-use agent is exploring ${targetUrl} like a user` +
        (mode === "full" ? " (full-app sweep)." : mode === "focus" ? ` (focused on ${focus}).` : mode === "offline" ? " (offline probe)." : " (scoped to this PR's changes)."),
      "This takes a few minutes — hang tight.",
      "",
      STATUS_MARKER,
    ].join("\n"));

  await reaction.inProgress();
  try {
    const creds: QaCreds | null =
      process.env.QA_LOGIN_EMAIL && process.env.QA_LOGIN_PASSWORD
        ? { email: process.env.QA_LOGIN_EMAIL, password: process.env.QA_LOGIN_PASSWORD, pin: process.env.QA_PIN || null }
        : null;
    if (creds) core.info(`QA login enabled for ${creds.email}.`);
    if (creds?.pin) core.info("QA PIN provided; will pass the PIN gate if shown.");

    // Load the QA memory and feed it to the agent so this run starts smarter.
    const memory = await readMemory();
    if (memory.content) core.info(`QA memory loaded (${memory.content.length} chars).`);

    // Seed steering with paths covered in past runs (from memory), so we don't
    // re-push already-covered routes. Best-effort parse; empty on any failure.
    const priorVisited = map ? extractLedgerPaths(memory.content) : [];

    const offlineWindow = mode === "offline" ? offlineWindowFor(QA_CONFIG.budgets.offline) : undefined;
    const { findings, turns, note, summary, inputTokens, outputTokens, durationMs, video, paths, downloads, consoleErrors, offlineTurns } = await explore(
      targetUrl,
      mode,
      scopeLine,
      creds,
      memory.content,
      prContext,
      map,
      priorVisited,
      focus,
      screen,
      undefined,
      offlineWindow,
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

    // Coverage over the union of this run's paths and what past runs covered.
    let coverage: Coverage | null = null;
    if (map) {
      try {
        const allVisited = [...new Set([...paths, ...priorVisited])];
        coverage = coverageFor(map, allVisited, mode === "focus" && focus ? { domain: focus } : {});
        core.info(`QA coverage: ${coverage.overall.covered}/${coverage.overall.total} (${coverage.overall.pct}%).`);
      } catch (err) {
        core.warning(`Coverage computation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Publish the session video (best-effort — never blocks the report).
    let replayUrl: string | null = null;
    if (video && video.length > 0) {
      replayUrl = await uploadVideo(video, `qa-replays/pr-${prNumber}/${mode}-${Date.now()}.webm`);
      core.info(replayUrl ? `Video published: ${replayUrl}` : `Video not published (no blob creds or upload failed).`);
    } else {
      core.info("Video skipped: no recording captured.");
    }

    // Grade export downloads: failures become findings; all are shown in the report.
    const downloadVerdicts = downloads.map(classifyDownload);
    const downloadFindings = downloadVerdicts.map(downloadFinding).filter((f): f is QaFinding => f !== null);
    const offlineExtra =
      mode === "offline"
        ? { findings: offlineFindings(consoleErrors), block: { errors: consoleErrors, offlineTurns } }
        : null;
    const reportFindings = [...findings, ...downloadFindings, ...(offlineExtra?.findings ?? [])];
    if (downloadVerdicts.length > 0) {
      core.info(`Export downloads: ${downloadVerdicts.filter((v) => v.ok).length}/${downloadVerdicts.length} verified.`);
    }

    await postComment(prNumber, buildReport({ mode, targetUrl, findings: reportFindings, turns, scopeNote, note, summary, marker: REPORT_MARKER, metrics, replayUrl, coverage, downloads: downloadVerdicts, offline: offlineExtra?.block ?? null, viewport }));

    // Collapse the in-progress status to a one-liner pointing at the report.
    await editComment(statusId, prNumber, [`## ✅ QA exploration complete`, "", `Found ${reportFindings.length} issue(s) in ${turns} step(s). See the report below.`, "", STATUS_MARKER].join("\n"));

    // Distil this run into the QA memory for next time (best-effort).
    try {
      const facts = {
        date: new Date().toISOString().slice(0, 10),
        mode,
        target: targetUrl,
        paths,
        findings: reportFindings.map((f) => `${f.severity}: ${f.title} (${f.area})`),
        summary: summary ?? note ?? "",
        coverage: coverage ? { pct: coverage.overall.pct, covered: coverage.overall.covered, total: coverage.overall.total } : null,
        coveredPaths: coverage?.coveredPaths ?? [],
      };
      const priorLedger = extractLedgerRoutes(memory.content);
      const synthesized = await synthesizeMemory(memory.content, facts);
      const updated = upsertLedger(synthesized, coverage?.coveredPaths ?? [], facts.date, priorLedger);
      if (updated && updated !== memory.content) {
        core.info((await writeMemory(updated, memory.sha)) ? "QA memory updated." : "QA memory not committed.");
      } else {
        core.info("QA memory unchanged.");
      }
    } catch (err) {
      core.warning(`QA memory step failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    core.info(`QA complete: ${reportFindings.length} finding(s) over ${turns} step(s).`);
  } catch (err) {
    // Close the loop on failure: without this the "in progress" status comment
    // lingers forever (the agent crashed, hit a rate limit, the browser died,
    // the preview 404'd after resolution…) with no report and no signal. Rewrite
    // it to an error, then rethrow so the job still fails.
    const reason = err instanceof Error ? err.message : String(err);
    await editComment(statusId, prNumber, [`## ❌ QA exploration failed`, "", `The run did not complete: ${reason}`, "", "Fix the cause and comment `/qa` again.", "", STATUS_MARKER].join("\n"));
    throw err;
  } finally {
    await reaction.done();
  }
}

async function runShard(): Promise<void> {
  const domain = process.env.QA_SHARD_DOMAIN!;
  const url = process.env.QA_TARGET_URL!;
  const out = process.env.QA_SHARD_OUT!;
  const prNumber = Number(process.env.QA_PR);
  const map = loadQaMap();
  try {
    const d = map.domains.find((x) => x.key === domain);
    if (!d) throw new Error(`unknown domain '${domain}'`);
    const routeList = d.routes.join(", ");
    const scopeLine = `FOCUS on the "${d.label}" area only. Concentrate on these routes and their flows: ${routeList}. Don't wander outside this area.`;
    const creds: QaCreds | null =
      process.env.QA_LOGIN_EMAIL && process.env.QA_LOGIN_PASSWORD
        ? { email: process.env.QA_LOGIN_EMAIL, password: process.env.QA_LOGIN_PASSWORD, pin: process.env.QA_PIN || null }
        : null;
    const memory = await readMemory();
    const priorVisited = extractLedgerPaths(memory.content);
    const prContext = ""; // shards run from the workflow; PR-intent context is optional here
    const r = await explore(url, "focus", scopeLine, creds, memory.content, prContext, map, priorVisited, domain, QA_CONFIG.screen, QA_CONFIG.budgets.focus);
    let replayUrl: string | null = null;
    if (r.video && r.video.length > 0) {
      replayUrl = await uploadVideo(r.video, `qa-replays/pr-${prNumber}/shard-${domain}-${process.env.GITHUB_RUN_ID ?? "x"}.webm`);
    }
    const downloadVerdicts = r.downloads.map(classifyDownload);
    const downloadFindings = downloadVerdicts.map(downloadFinding).filter((f): f is QaFinding => f !== null);
    const sr = buildShardResult(map, domain, { ...r, findings: [...r.findings, ...downloadFindings] }, replayUrl, QA_CONFIG.pricing);
    writeFileSync(out, JSON.stringify(sr));
    core.info(`Shard ${domain}: ${r.paths.length} paths, ${r.findings.length + downloadFindings.length} findings, ${r.turns} turns.`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    writeFileSync(out, JSON.stringify({ domain, ok: false, reason, visited: [], findings: [], coverage: null, turns: 0 }));
    core.warning(`Shard ${domain} failed: ${reason}`);
  }
}

async function runAggregate(): Promise<void> {
  const dir = process.env.QA_AGGREGATE_DIR!;
  const prNumber = Number(process.env.QA_PR);
  const url = process.env.QA_TARGET_URL || "";
  const statusId = process.env.QA_STATUS_ID ? Number(process.env.QA_STATUS_ID) : undefined;
  const map = loadQaMap();

  const shards: ShardResult[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { shards.push(JSON.parse(readFileSync(path.join(dir, f), "utf8")) as ShardResult); }
    catch (e) { core.warning(`Bad shard artifact ${f}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const reported = new Set(shards.map((s) => s.domain));
  for (const d of map.domains) {
    if (!reported.has(d.key)) {
      shards.push({ domain: d.key, ok: false, reason: "no result (shard did not report)", visited: [], findings: [], coverage: null, turns: 0 });
    }
  }
  const merged = mergeShards(map, shards);
  const sum = (k: "inputTokens" | "outputTokens" | "durationMs") => shards.reduce((n, s) => n + (s.metrics?.[k] ?? 0), 0);
  const totalTurns = shards.reduce((n, s) => n + s.turns, 0);
  const costUsd = (sum("inputTokens") * QA_CONFIG.pricing.input + sum("outputTokens") * QA_CONFIG.pricing.output) / 1_000_000;
  const replayLinks = shards.filter((s) => s.replayUrl).map((s) => ({ domain: s.domain, url: s.replayUrl! }));

  const totalBudget = QA_CONFIG.budgets.focus * shards.length;
  const body = buildAggregateReport(map, shards, {
    targetUrl: url, marker: REPORT_MARKER,
    metrics: { steps: totalTurns, budget: totalBudget, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costUsd, durationMs: sum("durationMs") },
    replayLinks,
  });
  await postComment(prNumber, body);
  const completed = shards.filter((s) => s.ok).length;
  await editComment(statusId, prNumber, [`## ✅ QA full sweep complete`, "", `${completed}/${shards.length} domains finished · overall coverage ${merged.overall.overall.pct}% · ${merged.findings.length} finding(s).`, "", STATUS_MARKER].join("\n"));

  // Single-writer ledger update over the union of visited paths.
  try {
    const memory = await readMemory();
    const priorLedger = parseLedger(memory.content);
    const today = new Date().toISOString().slice(0, 10);
    const updated = upsertLedger(memory.content, merged.overall.coveredPaths, today, priorLedger);
    if (updated !== memory.content) core.info((await writeMemory(updated, memory.sha)) ? "QA memory updated." : "QA memory not committed.");
  } catch (e) { core.warning(`Ledger update skipped: ${e instanceof Error ? e.message : String(e)}`); }
}

async function runGate(): Promise<void> {
  const prNumber = Number(process.env.QA_PR);
  const headSha = process.env.QA_HEAD_SHA ?? "";
  const map = loadQaMap();
  const domains = map.domains.map((d) => d.key);
  const explicitUrl = /^\/qa\s+all\s+(https?:\/\/\S+)/.exec(context.payload.comment?.body ?? "")?.[1] ?? "";
  const url = process.env.QA_TARGET_URL || explicitUrl || (await resolvePreviewUrl(headSha)) || "";
  if (!url) {
    await postComment(prNumber, ["## 🕵️ QA full sweep — no preview", "", "No Vercel preview URL was found for this PR, so the fan-out can't run.", "", STATUS_MARKER].join("\n"));
    core.setOutput("domains", "[]"); core.setOutput("url", ""); core.setOutput("status_id", "");
    return;
  }
  const statusId = await postComment(prNumber, [
    `## 🕵️ QA full sweep — fanning out across ${domains.length} domains`, "",
    `Each domain gets its own focused agent against ${url}. Results aggregate into one report when they finish.`, "",
    STATUS_MARKER,
  ].join("\n"));
  core.setOutput("domains", JSON.stringify(domains));
  core.setOutput("url", url);
  core.setOutput("status_id", String(statusId ?? ""));
  core.info(`Gate: ${domains.length} domains, url=${url}, status=${statusId}`);
}

async function main(): Promise<void> {
  if (process.env.QA_AGGREGATE_DIR) return runAggregate();
  if (process.env.QA_SHARD_DOMAIN) return runShard();
  if (process.env.QA_GATE) return runGate();
  return run();
}
main().catch((e) => { core.setFailed(e instanceof Error ? e.message : String(e)); });
