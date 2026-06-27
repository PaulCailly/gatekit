import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { buildBenchmark, type ModelFailure } from "./lib/benchmark.js";
import { commentableLines } from "./lib/diff.js";
import { context, core, octokit, owner, repo } from "./lib/gh.js";
import { costTable, details } from "./lib/markdown.js";
import { buildHealthMetrics, type HealthMetrics } from "./lib/metrics.js";
import {
  getClient,
  type ModelSpec,
  mostExpensive,
  resolveModels,
  safeKey,
} from "./lib/openrouter.js";
import { trackTriggerReaction } from "./lib/reactions.js";
import { fileTree, guidelineDocs, listDir, readFile } from "./lib/repo.js";
import type { Finding, ReviewResult, Severity, Usage } from "./lib/types.js";
import { renderFixApproaches } from "./lib/review-fixes.js";

const FIX_ALL_INTRO =
  "Verify each finding against current code. Fix only still-valid issues, skip the\nrest with a brief reason, keep changes minimal, and validate.";

const MAX_TURNS = 16;
const MAX_READS = 60;
const MAX_TOKENS = 16000;

const SEVERITY_EMOJI: Record<Severity, string> = {
  error: "🔴",
  warning: "🟠",
  info: "🔵",
};

const VALID_SEVERITIES: Severity[] = ["error", "warning", "info"];

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "1-3 sentences: overall assessment and how the change fits the architecture." },
    walkthrough: {
      type: "string",
      description:
        "A Mermaid `sequenceDiagram` body (starting with the line `sequenceDiagram`, NO ``` fences) tracing the main runtime flow the change introduces or modifies — the key participants (modules/functions/services) and the calls between them. Keep it focused on what changed. Use an empty string for trivial changes with no meaningful flow.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          line: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["error", "warning", "info"] },
          confidence: { type: "integer" },
          category: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          impact: { type: "string" },
          fixes: {
            type: "array",
            minItems: 3,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                snippet: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["title", "description", "snippet", "prompt"],
            },
          },
        },
        required: ["path", "line", "severity", "confidence", "category", "title", "description", "impact"],
      },
    },
  },
  required: ["summary", "walkthrough", "findings"],
} as const;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full contents of a file in the repository at the PR's head commit. Use this to pull in files connected to the change — imported modules, callers, type definitions, configs, tests — and any docs/ guideline you want to check the change against.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative file path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the files and subdirectories at a repo-relative path (use '' or '.' for the root) at the PR's head commit. Use it to discover where related code lives before reading it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative directory path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_review",
      description: "Submit your final review. Call this exactly once, when you have gathered enough context.",
      parameters: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    },
  },
];

const SYSTEM = `You are a staff software engineer doing a thorough pull request review.

You are NOT limited to the diff. Review the change in the full context of the codebase:
- Use read_file / list_directory to open the files the change touches in full, plus the files it is connected to: imported modules, callers of changed functions, shared types, configuration, and the relevant tests.
- The project's own guideline and architecture docs are provided up front (and more live under docs/). Hold the change to the conventions, patterns, and best practices documented there — flag deviations.
- Assess correctness, security, performance, error handling, and architectural fit (does it belong here, does it duplicate existing utilities, does it break a layering/boundary the project maintains, does it follow the established patterns for this kind of code).

Be efficient: read only the files that materially help the review; you have a bounded number of reads. When done, call submit_review.

Also produce a "walkthrough": a Mermaid sequenceDiagram (body only, starting with the line "sequenceDiagram", no code fences) that traces the main runtime flow the change introduces or modifies — the key participants and the calls between them — so a reviewer can see how the pieces interact. Keep it focused on what changed; use an empty string for trivial changes.

For each finding:
- "line" must be a line number that exists in the NEW version of the changed file (a line the diff adds or keeps). Use null for a whole-file or cross-file observation.
- Give a confidence (0-100) and severity ("error" likely-breaking bug/security, "warning" probable issue, "info" minor/style/architecture nit).
- Report every issue you find, including lower-confidence ones, each tagged with confidence and severity. Coverage matters more than precision. An empty findings array is a valid result for a clean change.
- For EACH finding, propose exactly 3 distinct fix approaches in the "fixes" array. Each approach must have: a short "title" (1-2 words, e.g. "Stream", "Cache", "Block"), a one-line "description" of what this approach does, a minimal "snippet" showing the concrete code change (no fences), and a "prompt" an AI agent can copy-paste to apply that specific approach in the codebase. The 3 approaches must be genuinely different strategies — not 3 phrasings of the same fix.`;

/** Matches any Sentinel finding marker, capturing the model key and content hash. */
const SENTINEL_RE = /<!-- sentinel:([a-z0-9-]+):(\w+) -->/i;
/** Marker for the cross-model summary comment (issue comment, updated in place). */
const SUMMARY_MARKER = "<!-- sentinel:summary -->";
/** Marker for the lightweight "review in progress" status comment, posted up front
 *  so the author gets immediate feedback and updated in place when the run ends. */
const STATUS_MARKER = "<!-- sentinel:status -->";

function hashFor(f: Finding): string {
  return createHash("sha1").update(`${f.path}:${f.line}:${f.title}`).digest("hex").slice(0, 12);
}

function markerFor(f: Finding, key: string): string {
  return `<!-- sentinel:${key}:${hashFor(f)} -->`;
}

function formatBody(f: Finding, key: string): string {
  const fixBlock = renderFixApproaches(f.fixes ?? []);
  const parts = [
    `${SEVERITY_EMOJI[f.severity]} **${f.title}** · \`${f.category}\` · confidence ${f.confidence}%`,
    "",
    f.description,
    "",
    `**Impact:** ${f.impact}`,
  ];
  if (fixBlock) {
    parts.push("", fixBlock);
  }
  parts.push("", markerFor(f, key));
  return parts.join("\n");
}

interface ReviewComment {
  id: number;
  in_reply_to_id?: number;
  user?: { login?: string } | null;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

/** Build a plain-text digest of THIS model's prior findings and the human replies to
 *  each, so a re-review can skip issues already fixed, dismissed, or argued down.
 *  Replies are threaded onto their root comment via `in_reply_to_id`. */
function priorReviewDigest(comments: ReviewComment[], key: string): string {
  const repliesByRoot = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (!c.in_reply_to_id) continue;
    const arr = repliesByRoot.get(c.in_reply_to_id) ?? [];
    arr.push(c);
    repliesByRoot.set(c.in_reply_to_id, arr);
  }

  const blocks: string[] = [];
  for (const c of comments) {
    if (c.in_reply_to_id) continue; // a reply, handled under its root
    const m = SENTINEL_RE.exec(c.body ?? "");
    if (!m || m[1] !== key) continue; // only this model's own findings
    const line = c.line ?? c.original_line ?? null;
    const loc = line ? `${c.path}:${line}` : (c.path ?? "(file)");
    const lines = [`Finding at \`${loc}\`:`, (c.body ?? "").replace(SENTINEL_RE, "").trim()];
    for (const r of repliesByRoot.get(c.id) ?? []) {
      const who = r.user?.login ?? "someone";
      lines.push(`↳ reply from @${who}: ${(r.body ?? "").replace(SENTINEL_RE, "").trim()}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** Render the model's Mermaid sequence diagram as a collapsible fenced block. */
function walkthroughBlock(walkthrough: string): string | null {
  const body = walkthrough
    .trim()
    .replace(/^```(?:mermaid)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!body) return null;
  return details("🔀 Sequence diagram", ["```mermaid", body, "```"].join("\n"));
}

/** Collapsible list of the files this review covered. */
function reviewedFilesBlock(files: { filename: string; additions: number; deletions: number }[]): string {
  const rows = files.map((f) => `- \`${f.filename}\` (+${f.additions} -${f.deletions})`);
  return details(`📄 Reviewed ${files.length} file(s)`, rows.join("\n"));
}

/** One copy-pasteable code block combining every finding, for an AI agent to fix in bulk. */
function fixAllBlock(findings: Finding[]): string {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byFile.get(f.path) ?? [];
    arr.push(f);
    byFile.set(f.path, arr);
  }

  const lines = [FIX_ALL_INTRO];
  for (const [path, group] of byFile) {
    lines.push("", `In \`${path}\`:`);
    for (const f of group) {
      const loc = f.line ? `Around line ${f.line}: ` : "";
      lines.push(`- ${loc}${f.title} — ${f.description}`);
    }
  }

  return details("🤖 Prompt to fix all comments with an AI agent", ["```", lines.join("\n"), "```"].join("\n"));
}

/** Coerce a model's submit_review payload into a well-formed ReviewResult. Cross-provider
 *  models vary in how strictly they follow the schema, so defend every field. */
function normalizeResult(raw: unknown): ReviewResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: Finding[] = [];
  for (const item of rawFindings) {
    const f = (item ?? {}) as Record<string, unknown>;
    const severity = VALID_SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : "info";
    const lineNum = typeof f.line === "number" && Number.isFinite(f.line) ? Math.trunc(f.line) : null;
    const conf = typeof f.confidence === "number" && Number.isFinite(f.confidence) ? Math.trunc(f.confidence) : 50;
    if (!f.path || !f.title) continue;
    const rawFixes = Array.isArray(f.fixes) ? f.fixes : [];
    const fixes = rawFixes
      .filter((fx): fx is Record<string, unknown> => fx !== null && typeof fx === "object")
      .map((fx) => ({
        title: String(fx.title ?? ""),
        description: String(fx.description ?? ""),
        snippet: String(fx.snippet ?? ""),
        prompt: String(fx.prompt ?? ""),
      }));
    findings.push({
      path: String(f.path),
      line: lineNum,
      severity,
      confidence: Math.max(0, Math.min(100, conf)),
      category: String(f.category ?? "general"),
      title: String(f.title),
      description: String(f.description ?? ""),
      impact: String(f.impact ?? ""),
      ...(fixes.length > 0 ? { fixes } : {}),
    });
  }
  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    walkthrough: typeof obj.walkthrough === "string" ? obj.walkthrough : "",
    findings,
  };
}

interface SharedContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  headSha: string;
  diffText: string;
  reviewable: { filename: string; additions: number; deletions: number }[];
  validLines: Map<string, Set<number>>;
  existing: ReviewComment[];
  metrics: HealthMetrics | null;
  docs: string;
  tree: string;
}

/** Run the agentic review loop for one model and return its structured result. */
async function reviewWithContext(
  model: ModelSpec,
  ctx: SharedContext,
  priorReviews: string,
): Promise<{ result: ReviewResult; usage: Usage; turns: number }> {
  const initial = [
    `Pull request: ${ctx.prTitle}`,
    "",
    "## PR description (author's stated intent and context for the change)",
    ctx.prBody.trim() || "(no description provided)",
    "",
    "## Project guidelines & architecture (review the change against these)",
    ctx.docs || "(none found)",
    "",
    ...(ctx.metrics
      ? ["## Static analysis metrics (deterministic, for the changed files)", ctx.metrics.promptSection, ""]
      : []),
    "## Prior automated reviews on this PR (earlier iterations)",
    priorReviews.trim() || "(none — this is the first review of this PR)",
    "Do NOT re-report a prior finding that the current code has already fixed, or that the author has dismissed or rebutted with a reasonable justification in a reply. Treat a reply arguing against a finding as a signal to drop it, unless the current code plainly still has the issue. Only raise a past finding again if it is clearly still valid and unaddressed.",
    "",
    "## Repository file tree",
    "```",
    ctx.tree,
    "```",
    "",
    "## The diff to review (changed files, unified patches)",
    ctx.diffText,
    "",
    "Investigate the connected files and relevant docs with your tools, then call submit_review.",
  ].join("\n");

  const client = getClient();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: initial },
  ];
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let reads = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const force = turn === MAX_TURNS - 1;
    const resp = await client.chat.completions.create({
      model: model.slug,
      max_tokens: MAX_TOKENS,
      messages,
      tools: TOOLS,
      tool_choice: force ? { type: "function", function: { name: "submit_review" } } : "auto",
    });

    usage.input_tokens += resp.usage?.prompt_tokens ?? 0;
    usage.output_tokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error(`${model.label}: empty response from the model.`);
    if (msg.refusal) throw new Error(`${model.label} declined to review this PR.`);
    messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Call submit_review now with your findings." });
      continue;
    }

    let submitted: ReviewResult | null = null;
    for (const call of calls) {
      if (call.type !== "function") continue;
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* leave args empty; tool result below explains the failure */
      }

      if (name === "submit_review") {
        submitted = normalizeResult(args);
        messages.push({ role: "tool", tool_call_id: call.id, content: "Review received." });
        continue;
      }

      const path = String(args.path ?? "");
      let out: string;
      try {
        if (name === "read_file") {
          out = ++reads > MAX_READS ? "Read budget exhausted — call submit_review with what you have." : await readFile(path, ctx.headSha);
        } else if (name === "list_directory") {
          out = await listDir(path, ctx.headSha);
        } else {
          out = `Unknown tool: ${name}`;
        }
      } catch (err) {
        out = err instanceof Error ? err.message : String(err);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }

    if (submitted) return { result: submitted, usage, turns: turn + 1 };
  }

  throw new Error(`${model.label}: review did not converge — the model never called submit_review.`);
}

interface PostedReview {
  model: ModelSpec;
  result: ReviewResult;
  usage: Usage;
  turns: number;
}

/** Run one model's review and post it as its own PR review. Returns the result for the
 *  cross-model summary, or null if the model found nothing new to add. */
async function runOneReview(model: ModelSpec, ctx: SharedContext): Promise<PostedReview | null> {
  const key = safeKey(model);

  // This model's own prior findings: the dedup set and the context digest.
  const seen = new Set<string>();
  for (const c of ctx.existing) {
    const m = SENTINEL_RE.exec(c.body ?? "");
    if (m && m[1] === key) seen.add(m[2]);
  }
  const priorReviews = priorReviewDigest(ctx.existing, key);
  const hadPrior = seen.size > 0;

  const { result, usage, turns } = await reviewWithContext(model, ctx, priorReviews);

  const inline: { path: string; line: number; body: string }[] = [];
  const general: Finding[] = [];
  const posted: Finding[] = [];

  for (const f of result.findings) {
    const hash = hashFor(f);
    if (seen.has(hash)) continue;
    seen.add(hash);
    posted.push(f);

    const lines = ctx.validLines.get(f.path);
    if (f.line && lines?.has(f.line)) {
      inline.push({ path: f.path, line: f.line, body: formatBody(f, key) });
    } else {
      general.push(f);
    }
  }

  if (inline.length === 0 && general.length === 0 && hadPrior) {
    core.info(`[${model.label}] No new findings since the last review; skipping duplicate summary.`);
    return { model, result, usage, turns };
  }

  const counts = result.findings.reduce(
    (acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc),
    {} as Record<string, number>,
  );

  const bodyParts = [`## 🤖 Code Review · \`${model.label}\``, ""];

  if (ctx.metrics?.scoreLine) bodyParts.push(ctx.metrics.scoreLine, "");

  bodyParts.push(
    result.findings.length === 0
      ? "No issues detected — the change looks consistent with the codebase. ✅"
      : `Found **${result.findings.length}** issue(s): ` +
        `${counts.error ?? 0} 🔴 · ${counts.warning ?? 0} 🟠 · ${counts.info ?? 0} 🔵`,
  );

  if (result.summary) bodyParts.push("", result.summary);

  const walkthrough = walkthroughBlock(result.walkthrough ?? "");
  if (walkthrough) bodyParts.push("", walkthrough);

  bodyParts.push("", reviewedFilesBlock(ctx.reviewable));

  if (ctx.metrics) bodyParts.push("", details("📊 Static metrics (changed files)", ctx.metrics.commentBody));

  if (general.length > 0) {
    bodyParts.push("", "### Additional findings");
    for (const f of general) {
      const loc = f.line ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``;
      bodyParts.push(`- ${SEVERITY_EMOJI[f.severity]} ${loc} — **${f.title}** (${f.confidence}%): ${f.description}`);
    }
  }

  if (posted.length > 0) bodyParts.push("", fixAllBlock(posted));

  bodyParts.push("", costTable("💰 Review cost", usage, turns, model));
  bodyParts.push("", `<sub>Reviewed by \`${model.slug}\` via OpenRouter.</sub>`);

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: ctx.prNumber,
    event: "COMMENT",
    body: bodyParts.join("\n"),
    comments: inline,
  });

  core.info(`[${model.label}] Posted ${inline.length} inline comment(s), ${general.length} general finding(s).`);
  return { model, result, usage, turns };
}

/** Have the priciest model that ran write a cross-analysis of all the reviews, then
 *  append a deterministic model benchmark (overlap matrix, per-model cost/agreement).
 *  Posted (or updated) as a single issue comment. Only called when ≥2 models reviewed. */
/** Ask the summariser model to reconcile the reviews into a prose cross-analysis. */
async function crossAnalysis(reviews: PostedReview[], ctx: SharedContext, summarizer: ModelSpec): Promise<string> {
  const reviewBlocks = reviews
    .map((r) => {
      const findings = r.result.findings.length
        ? r.result.findings
            .map((f) => {
              const loc = f.line ? `${f.path}:${f.line}` : f.path;
              return `- [${f.severity}] ${loc} — ${f.title}: ${f.description}`;
            })
            .join("\n")
        : "(no findings)";
      return `### Model: ${r.model.label}\nSummary: ${r.result.summary || "(none)"}\nFindings:\n${findings}`;
    })
    .join("\n\n");

  const prompt = [
    `${reviews.length} models independently reviewed the same pull request "${ctx.prTitle}".`,
    "Below are their reviews. Write a concise cross-analysis in Markdown for a human deciding what to act on:",
    "- **Consensus** — issues multiple models flagged (highest priority); cite which models agree.",
    "- **Disagreements / unique calls** — notable findings only one model raised, or where models conflict.",
    "- **Bottom line** — the top 1–3 things to fix first.",
    "Be tight and specific. Reference findings by file:line. No preamble, no restating every finding.",
    "",
    reviewBlocks,
  ].join("\n");

  const resp = await getClient().chat.completions.create({
    model: summarizer.slug,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: "You are a staff engineer reconciling several independent code reviews of one PR." },
      { role: "user", content: prompt },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}

async function postCrossAnalysis(
  reviews: PostedReview[],
  failures: ModelFailure[],
  ctx: SharedContext,
): Promise<void> {
  // The deterministic benchmark is the load-bearing part of this comment, so build
  // it first and never let the (best-effort) LLM synthesis block it from posting.
  const benchmark = buildBenchmark(reviews, failures);
  const summarizer = mostExpensive(reviews.map((r) => r.model));

  // A qualitative cross-analysis only makes sense with ≥2 successful reviews to
  // reconcile. With a single success (the rest failed) we post the benchmark alone.
  let analysis = "";
  let intro: string;
  if (reviews.length >= 2) {
    intro = `Comparing the independent reviews from ${reviews.map((r) => `\`${r.model.label}\``).join(", ")}. Synthesised by \`${summarizer.slug}\`.`;
    analysis = await crossAnalysis(reviews, ctx, summarizer).catch((err) => {
      core.error(`Cross-analysis synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    });
  } else {
    intro = `Only \`${reviews[0].model.label}\` converged; the benchmark below records the run (including failed models).`;
  }

  const bodyParts = [`## 🧮 Cross-model review summary`, "", intro, ""];
  if (analysis) bodyParts.push(analysis, "", "---", "");
  bodyParts.push(benchmark, "", SUMMARY_MARKER);
  const body = bodyParts.join("\n");

  // Update the existing summary in place (avoids stacking one per re-review), else create.
  const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: ctx.prNumber,
    per_page: 100,
  });
  const prior = issueComments.find((c) => (c.body ?? "").includes(SUMMARY_MARKER));
  if (prior) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: ctx.prNumber, body });
  }
  core.info(`Posted cross-model summary by ${summarizer.label}.`);
}

/** Create or update the single "review status" issue comment in place. Posted as
 *  soon as a review starts (so the author sees it's running, not dead, and knows a
 *  fresh /review would cancel it), then rewritten to the outcome when it finishes.
 *  Best-effort: a status-comment failure must never sink the review itself. */
async function upsertStatus(prNumber: number, body: string): Promise<void> {
  const full = `${body}\n\n${STATUS_MARKER}`;
  const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const prior = issueComments.find((c) => (c.body ?? "").includes(STATUS_MARKER));
  if (prior) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body: full });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: full });
  }
}

async function run(): Promise<void> {
  // The review is triggered by a "/review …" comment (issue_comment event), which
  // doesn't carry the PR object — only the issue number. Fetch the PR for its
  // title, body, and head SHA. (PR/issue numbers are shared on GitHub.)
  const prNumber = context.payload.issue?.number ?? context.payload.pull_request?.number;
  if (!prNumber) {
    core.info("No pull request in context; nothing to review.");
    return;
  }

  const commentBody = context.payload.comment?.body ?? "/review";
  const reaction = trackTriggerReaction(context.payload.comment?.id);
  const models = resolveModels(commentBody);
  core.info(`Reviewing with: ${models.map((m) => m.label).join(", ")}`);

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha: string = pr.head.sha;

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const reviewable = files.filter((f) => f.patch && f.status !== "removed");
  if (reviewable.length === 0) {
    core.info("No textual changes to review.");
    return;
  }

  // Immediate acknowledgement so the author knows the review is running (not dead)
  // before the multi-minute model loop starts. Posted via GITHUB_TOKEN, so it does
  // not itself trigger another workflow run.
  const modelList = models.map((m) => `\`${m.label}\``).join(", ");
  await upsertStatus(
    prNumber,
    [
      `## 🔍 Code review in progress`,
      "",
      `Reviewing this PR with ${modelList}.` +
        (models.length > 1 ? " The models run concurrently and each posts its own review." : ""),
      "This usually takes a few minutes — hang tight.",
      "",
      `> Heads up: a new \`/review\` while this one is running will **cancel** it, so please wait for the result.`,
    ].join("\n"),
  ).catch((err) => core.warning(`Could not post status comment: ${err instanceof Error ? err.message : String(err)}`));

  // Acknowledge the triggering /review comment with 👀 while the review runs,
  // then flip it to 👍 in `finally` so any crash below still finalises it.
  await reaction.inProgress();
  try {
    const validLines = new Map<string, Set<number>>();
    const diffText = reviewable
      .map((f) => {
        validLines.set(f.filename, commentableLines(f.patch!));
        return `### File: ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch}`;
      })
      .join("\n\n");

    // Prior inline comments (with their reply threads) seed each model's dedup set and
    // context, so a re-review doesn't repeat that model's fixed or dismissed feedback.
    const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    // Deterministic static-analysis metrics for the changed files, generated by a
    // prior CI step (scripts/health). Best-effort.
    const reportDir = process.env.HEALTH_REPORT_DIR;
    let metrics: HealthMetrics | null = null;
    if (reportDir) {
      metrics = await buildHealthMetrics(
        reportDir,
        reviewable.map((f) => f.filename),
      ).catch(() => null);
    }

    const [docs, tree] = await Promise.all([guidelineDocs(headSha), fileTree(headSha)]);

    const ctx: SharedContext = {
      prNumber,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      headSha,
      diffText,
      reviewable: reviewable.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions })),
      validLines,
      existing,
      metrics,
      docs,
      tree,
    };

    // Run every requested model concurrently; each posts its own independent review.
    const settled = await Promise.allSettled(models.map((m) => runOneReview(m, ctx)));

    const succeeded: PostedReview[] = [];
    const failures: ModelFailure[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        if (s.value) succeeded.push(s.value);
      } else {
        const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
        failures.push({ model: models[i], error });
        core.error(`[${models[i].label}] review failed: ${error}`);
      }
    }

    // For any multi-model invocation with at least one converged review, post the
    // cross-model summary: the deterministic benchmark (incl. failed-model rows)
    // always renders; the qualitative reconciliation kicks in once ≥2 succeeded.
    if (models.length >= 2 && succeeded.length >= 1) {
      await postCrossAnalysis(succeeded, failures, ctx).catch((err) =>
        core.error(`Cross-analysis failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // Rewrite the in-progress status to the outcome, so it doesn't linger as a stale
    // "in progress" once the reviews (and any cross-model summary) have posted.
    const okList = succeeded.map((r) => `\`${r.model.label}\``).join(", ");
    const failList = failures.map((f) => `\`${f.model.label}\``).join(", ");
    const finalStatus =
      succeeded.length === 0
        ? `## ❌ Code review failed\n\nEvery model failed (${failList}). Check the workflow run logs for details.`
        : [
            `## ✅ Code review complete`,
            "",
            `Posted reviews from ${okList}.` + (failures.length ? ` Failed: ${failList}.` : ""),
            ...(models.length >= 2 && succeeded.length >= 1 ? ["See the cross-model summary below."] : []),
          ].join("\n");
    await upsertStatus(prNumber, finalStatus).catch((err) =>
      core.warning(`Could not update status comment: ${err instanceof Error ? err.message : String(err)}`),
    );

    if (succeeded.length === 0) {
      core.setFailed("All model reviews failed.");
    }
  } finally {
    // Flip the 👀 acknowledgement to 👍 once the review has finished (or crashed).
    await reaction.done();
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
