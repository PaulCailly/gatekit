import type OpenAI from "openai";
import {
  MAX_REBUTTAL_ROUNDS,
  motionFor,
  parseDebateCommand,
  rotate,
  tally,
  type MotionConfig,
  type Vote,
} from "./lib/debate-core.js";
import { context, core, octokit, owner, repo } from "./lib/gh.js";
import { details } from "./lib/markdown.js";
import {
  estimateCost,
  getClient,
  mostExpensive,
  type ModelSpec,
} from "./lib/openrouter.js";
import {
  outcomeDiagram,
  positionsTable,
  type RoundRecord,
  type Turn,
  VERDICT_EMOJI,
} from "./lib/debate-format.js";
import { trackTriggerReaction } from "./lib/reactions.js";
import type { Usage } from "./lib/types.js";
import { fileTree, guidelineDocs, listDir, readFile } from "./lib/repo.js";

const MAX_OPENING_READS = 20;
const MAX_DEEP_READS = 12;
const MAX_TURNS = 10;
const MAX_TOKENS = 4000;
const SUMMARY_MARKER = "<!-- debate:summary -->";

interface DebateContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  headSha: string;
  diffText: string;
  docs: string;
  tree: string;
  cfg: MotionConfig;
}

function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

// ---- Per-model usage accounting (for an honest aggregate cost) ----
const usageByModel = new Map<string, { model: ModelSpec; usage: Usage }>();
function accrue(model: ModelSpec, u: Usage): void {
  const cur = usageByModel.get(model.key) ?? { model, usage: zeroUsage() };
  cur.usage.input_tokens += u.input_tokens;
  cur.usage.output_tokens += u.output_tokens;
  usageByModel.set(model.key, cur);
}

const READ_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file at the PR's head commit, to ground your argument in the real code.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Repo-relative file path." } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List entries of a repo-relative directory (use '' for the root) at the PR's head commit.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Repo-relative directory path." } }, required: ["path"] },
    },
  },
];

function structuredSchema(cfg: MotionConfig, kind: "opening" | "rebuttal" | "vote"): Record<string, unknown> {
  if (kind === "opening") {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        stance: { type: "string", enum: cfg.verdicts, description: "Your position on the motion." },
        argument: { type: "string", description: "Your grounded opening argument; cite file:line where relevant. 2-5 sentences." },
      },
      required: ["stance", "argument"],
    };
  }
  if (kind === "rebuttal") {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        stance: { type: "string", enum: cfg.verdicts, description: "Your (possibly revised) position after hearing the others." },
        rebuttal: { type: "string", description: "Steelman the strongest opposing point, say where/why you disagree (name debaters), concede what's right. 2-5 sentences." },
        unresolved: { type: "boolean", description: "True if a substantive disagreement remains unresolved." },
      },
      required: ["stance", "rebuttal", "unresolved"],
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: cfg.verdicts, description: "Your final, binding vote." },
      rationale: { type: "string", description: "One line." },
    },
    required: ["verdict", "rationale"],
  };
}

const OPENING_SYSTEM =
  "You are a staff engineer in a structured, democratic debate about a pull request. State your honest position on the motion and argue it from the real code. You may read files to ground your argument. Be concise and specific; cite file:line. When ready, call submit_opening.";

const REBUTTAL_SYSTEM =
  "You are in the rebuttal phase of a democratic debate, governed by RADICAL CANDOR: challenge directly, argue in good faith.\n" +
  "Your rebuttal MUST: steelman the strongest argument against your own position; state explicitly where and why you disagree with specific other debaters (name them); concede any point an opponent got right; revise your stance if genuinely persuaded (changing your mind is a win); and if everyone already agrees, surface the strongest remaining objection anyway. No false harmony.\n" +
  "Be concise. When ready, call submit_rebuttal.";

const VOTE_SYSTEM =
  "The debate is over. Weigh every argument and cast your single, final, binding vote on the motion. Call submit_vote.";

/** Run one model to a single forced `submit_*` call, optionally allowing file
 *  reads first. Returns the parsed submit arguments and the token usage. */
async function runToSubmit(
  model: ModelSpec,
  system: string,
  user: string,
  submitName: string,
  submitSchema: Record<string, unknown>,
  allowReads: boolean,
  readBudget: number,
  headSha: string,
): Promise<{ data: Record<string, unknown>; usage: Usage }> {
  const submitTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: { name: submitName, description: `Submit your ${submitName.replace("submit_", "")}. Call exactly once when ready.`, parameters: submitSchema },
  };
  const tools = allowReads ? [...READ_TOOLS, submitTool] : [submitTool];

  const client = getClient();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const usage: Usage = zeroUsage();
  let reads = 0;
  const maxTurns = allowReads ? MAX_TURNS : 1;

  for (let turn = 0; turn < maxTurns; turn++) {
    const force = !allowReads || turn === maxTurns - 1;
    const resp = await client.chat.completions.create({
      model: model.slug,
      max_tokens: MAX_TOKENS,
      messages,
      tools,
      tool_choice: force ? { type: "function", function: { name: submitName } } : "auto",
    });
    usage.input_tokens += resp.usage?.prompt_tokens ?? 0;
    usage.output_tokens += resp.usage?.completion_tokens ?? 0;

    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error(`${model.label}: empty response.`);
    if (msg.refusal) throw new Error(`${model.label} declined.`);
    messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      messages.push({ role: "user", content: `Call ${submitName} now.` });
      continue;
    }

    let submitted: Record<string, unknown> | null = null;
    for (const call of calls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* leave empty */
      }
      if (call.function.name === submitName) {
        submitted = args;
        messages.push({ role: "tool", tool_call_id: call.id, content: "Received." });
        continue;
      }
      const path = String(args.path ?? "");
      let out: string;
      try {
        if (call.function.name === "read_file") {
          out = ++reads > readBudget ? `Read budget exhausted — call ${submitName} now.` : await readFile(path, headSha);
        } else if (call.function.name === "list_directory") {
          out = await listDir(path, headSha);
        } else {
          out = `Unknown tool: ${call.function.name}`;
        }
      } catch (err) {
        out = err instanceof Error ? err.message : String(err);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
    if (submitted) return { data: submitted, usage };
  }
  throw new Error(`${model.label}: never called ${submitName}.`);
}

function normStance(v: unknown, cfg: MotionConfig): string {
  const s = String(v ?? "").toUpperCase().replace(/\s+/g, "_");
  return cfg.verdicts.includes(s) ? s : "ABSTAIN";
}

function contextBlock(ctx: DebateContext): string {
  return [
    `Motion under debate: "${ctx.cfg.motion}"`,
    `Allowed positions: ${ctx.cfg.verdicts.join(", ")}.`,
    "",
    `Pull request: ${ctx.prTitle}`,
    "## PR description",
    ctx.prBody.trim() || "(none)",
    "",
    "## Project guidelines & architecture",
    ctx.docs || "(none)",
    "",
    "## Repository file tree",
    "```",
    ctx.tree,
    "```",
    "",
    "## The diff",
    ctx.diffText,
  ].join("\n");
}

function transcriptText(rounds: RoundRecord[]): string {
  const parts: string[] = [];
  for (const r of rounds) {
    parts.push(`## ${r.label}`);
    for (const t of r.turns) parts.push(`### ${t.model.label} — stance: ${t.stance}\n${t.text}`);
  }
  return parts.join("\n\n");
}

async function runOpening(model: ModelSpec, ctx: DebateContext): Promise<Turn> {
  const user = [contextBlock(ctx), "", "Give your opening statement. Investigate the code as needed, then call submit_opening."].join("\n");
  const { data, usage } = await runToSubmit(model, OPENING_SYSTEM, user, "submit_opening", structuredSchema(ctx.cfg, "opening"), true, MAX_OPENING_READS, ctx.headSha);
  accrue(model, usage);
  return { model, stance: normStance(data.stance, ctx.cfg), text: String(data.argument ?? "") };
}

async function runRebuttal(
  model: ModelSpec,
  ctx: DebateContext,
  priorRounds: RoundRecord[],
  deep: boolean,
): Promise<{ turn: Turn; unresolved: boolean }> {
  const user = [
    contextBlock(ctx),
    "",
    "## Debate so far",
    transcriptText(priorRounds),
    "",
    "Now give your rebuttal following the radical-candor rules, then call submit_rebuttal.",
  ].join("\n");
  const { data, usage } = await runToSubmit(model, REBUTTAL_SYSTEM, user, "submit_rebuttal", structuredSchema(ctx.cfg, "rebuttal"), deep, MAX_DEEP_READS, ctx.headSha);
  accrue(model, usage);
  return { turn: { model, stance: normStance(data.stance, ctx.cfg), text: String(data.rebuttal ?? "") }, unresolved: Boolean(data.unresolved) };
}

async function runVote(model: ModelSpec, ctx: DebateContext, rounds: RoundRecord[]): Promise<Vote> {
  const user = [
    `Motion: "${ctx.cfg.motion}"`,
    "## Full debate transcript",
    transcriptText(rounds),
    "",
    `Cast your final vote (${ctx.cfg.verdicts.join(", ")}) and a one-line rationale. Call submit_vote.`,
  ].join("\n");
  const { data, usage } = await runToSubmit(model, VOTE_SYSTEM, user, "submit_vote", structuredSchema(ctx.cfg, "vote"), false, 0, ctx.headSha);
  accrue(model, usage);
  return { model, verdict: normStance(data.verdict, ctx.cfg), rationale: String(data.rationale ?? "") };
}

async function synthesise(ctx: DebateContext, votes: Vote[]): Promise<string> {
  const summarizer = mostExpensive(votes.map((v) => v.model));
  const t = tally(votes, ctx.cfg);
  const prompt = [
    `Motion: "${ctx.cfg.motion}". Final tally: ${t.outcomeLine}.`,
    "Votes:",
    ...votes.map((v) => `- ${v.model.label}: ${v.verdict} — ${v.rationale}`),
    "",
    "In exactly 2 sentences, give the bottom line a human should take away from this debate. No preamble.",
  ].join("\n");
  const resp = await getClient().chat.completions.create({
    model: summarizer.slug,
    max_tokens: 300,
    messages: [
      { role: "system", content: "You distil a multi-model debate into a crisp bottom line." },
      { role: "user", content: prompt },
    ],
  });
  accrue(summarizer, {
    input_tokens: resp.usage?.prompt_tokens ?? 0,
    output_tokens: resp.usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}

function roundBlock(round: RoundRecord): string {
  const parts: string[] = [];
  for (const t of round.turns) parts.push(`**${t.model.label}** · _${t.stance}_`, "", t.text, "");
  return details(round.label, parts.join("\n"));
}

function costBlock(): string {
  const n = (v: number) => v.toLocaleString("en-US");
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let unpriced = false;
  const rows = ["| Model | Input | Output | Est. cost |", "| --- | --- | --- | --- |"];
  for (const { model, usage } of usageByModel.values()) {
    inTok += usage.input_tokens;
    outTok += usage.output_tokens;
    const c = estimateCost(usage, model);
    if (c === null) unpriced = true;
    else cost += c;
    rows.push(`| \`${model.slug}\` | ${n(usage.input_tokens)} | ${n(usage.output_tokens)} | ${c === null ? "n/a" : `$${c.toFixed(2)}`} |`);
  }
  rows.push(`| **Total** | ${n(inTok)} | ${n(outTok)} | **${unpriced ? "≥ " : ""}$${cost.toFixed(2)}** |`);
  return details("💰 Debate cost", rows.join("\n"));
}

async function postSummary(
  ctx: DebateContext,
  rounds: RoundRecord[],
  votes: Vote[],
  bottomLine: string,
  note?: string,
): Promise<void> {
  const t = tally(votes, ctx.cfg);
  const parts = [`## 🗣️ Debate · ${ctx.cfg.motion}`, ""];
  if (note) parts.push(`> ${note}`, "");
  if (votes.length > 0) {
    parts.push(`**Outcome:** ${t.outcomeLine}`, "");
    if (bottomLine) parts.push(bottomLine, "");
    parts.push(outcomeDiagram(votes, t.outcomeLine), "");
    parts.push("| Model | Vote | Rationale |", "| --- | --- | --- |");
    for (const v of votes) parts.push(`| ${v.model.label} | ${VERDICT_EMOJI[v.verdict] ?? ""} ${v.verdict} | ${v.rationale} |`);
    parts.push("");
  }
  const positions = positionsTable(rounds, votes);
  if (positions) parts.push("**How each model's position evolved**", "", positions, "");
  for (const r of rounds) parts.push(roundBlock(r), "");
  parts.push(costBlock(), "");
  parts.push("<sub>Debated via OpenRouter.</sub>", "", SUMMARY_MARKER);
  const body = parts.join("\n");

  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: ctx.prNumber, per_page: 100 });
  const prior = comments.find((c) => (c.body ?? "").includes(SUMMARY_MARKER));
  if (prior) await octokit.rest.issues.updateComment({ owner, repo, comment_id: prior.id, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number: ctx.prNumber, body });
  core.info(`Posted debate summary (${votes.length} vote(s)).`);
}

function reason(s: PromiseRejectedResult): string {
  return s.reason instanceof Error ? s.reason.message : String(s.reason);
}

function stanceOf(turns: Turn[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of turns) m.set(t.model.key, t.stance);
  return m;
}

async function run(): Promise<void> {
  const prNumber = context.payload.issue?.number ?? context.payload.pull_request?.number;
  if (!prNumber) {
    core.info("No pull request in context; nothing to debate.");
    return;
  }

  const commentBody = context.payload.comment?.body ?? "/debate";
  const reaction = trackTriggerReaction(context.payload.comment?.id);
  const { models, motion, deep } = parseDebateCommand(commentBody);
  const cfg = motionFor(motion);
  core.info(`Debating "${cfg.motion}" with: ${models.map((m) => m.label).join(", ")}${deep ? " (deep)" : ""}`);

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha: string = pr.head.sha;

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: prNumber, per_page: 100 });
  const reviewable = files.filter((f) => f.patch && f.status !== "removed");
  if (reviewable.length === 0) {
    // Returns before inProgress(): no 👀 was added, so there is nothing to flip.
    core.info("No textual changes to debate.");
    return;
  }

  // Acknowledge the triggering /debate comment with 👀 while the debate runs,
  // then flip it to 👍 in `finally` so any crash below still finalises it.
  await reaction.inProgress();
  try {
    const diffText = reviewable
      .map((f) => `### File: ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n${f.patch}`)
      .join("\n\n");

    const [docs, tree] = await Promise.all([guidelineDocs(headSha), fileTree(headSha)]);

    const ctx: DebateContext = {
      prNumber,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      headSha,
      diffText,
      docs,
      tree,
      cfg,
    };

    // ----- Opening (parallel, agentic) -----
    const openingSettled = await Promise.allSettled(models.map((m) => runOpening(m, ctx)));
    const openingTurns: Turn[] = [];
    const survivors: ModelSpec[] = [];
    for (let i = 0; i < openingSettled.length; i++) {
      const s = openingSettled[i];
      if (s.status === "fulfilled") {
        openingTurns.push(s.value);
        survivors.push(models[i]);
      } else {
        core.error(`[${models[i].label}] opening failed: ${reason(s)}`);
      }
    }
    const rounds: RoundRecord[] = [{ label: "Round 0 · Opening statements", turns: openingTurns }];

    if (survivors.length < 2) {
      await postSummary(ctx, rounds, [], "", "Debate could not be held — fewer than two models converged on an opening.");
      if (survivors.length === 0) core.setFailed("All models failed to open.");
      return;
    }

    // ----- Rebuttal rounds (sequential, rotating order, early-stop on convergence) -----
    const prevStances = stanceOf(openingTurns);
    for (let r = 0; r < MAX_REBUTTAL_ROUNDS; r++) {
      const order = rotate(survivors, r);
      const turns: Turn[] = [];
      let anyUnresolved = false;
      let anyChanged = false;
      for (const m of order) {
        try {
          const priorRounds = [...rounds, { label: `Round ${r + 1} · Rebuttals (in progress)`, turns }];
          const { turn, unresolved } = await runRebuttal(m, ctx, priorRounds, deep);
          turns.push(turn);
          if (unresolved) anyUnresolved = true;
          if (prevStances.get(m.key) !== turn.stance) anyChanged = true;
        } catch (err) {
          core.error(`[${m.label}] rebuttal failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      rounds.push({ label: `Round ${r + 1} · Rebuttals`, turns });
      for (const t of turns) prevStances.set(t.model.key, t.stance);
      if (turns.length > 0 && !anyUnresolved && !anyChanged) {
        core.info(`Debate converged after rebuttal round ${r + 1}.`);
        break;
      }
    }

    // ----- Vote (parallel, non-agentic) -----
    const voteSettled = await Promise.allSettled(survivors.map((m) => runVote(m, ctx, rounds)));
    const votes: Vote[] = [];
    for (let i = 0; i < voteSettled.length; i++) {
      const s = voteSettled[i];
      if (s.status === "fulfilled") votes.push(s.value);
      else core.error(`[${survivors[i].label}] vote failed: ${reason(s)}`);
    }

    // ----- Synthesis + post -----
    const bottomLine =
      votes.length > 0
        ? await synthesise(ctx, votes).catch((err) => {
            core.error(`Synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
            return "";
          })
        : "";
    await postSummary(ctx, rounds, votes, bottomLine);

    if (votes.length === 0) core.setFailed("No model cast a vote.");
  } finally {
    await reaction.done();
  }
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
