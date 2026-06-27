import { MODELS, type ModelSpec } from "./openrouter.js";

export const MAX_REBUTTAL_ROUNDS = 2;
export const DEFAULT_PANEL_KEYS = ["opus", "gpt", "gemini"] as const;
export const DEFAULT_MOTION = "Should this PR be merged as-is?";

const DEEP_FLAG = "--deep";

export interface MotionConfig {
  /** The question the models argue. */
  motion: string;
  /** True when no custom motion was supplied (verdict vocabulary differs). */
  isDefault: boolean;
  /** Allowed stance/verdict tokens for this motion. ABSTAIN is always last. */
  verdicts: string[];
}

export interface ParsedDebate {
  models: ModelSpec[];
  /** The free-text motion, or null when none was supplied. */
  motion: string | null;
  /** Whether file reads are enabled in rebuttal rounds (`--deep`). */
  deep: boolean;
}

function defaultPanel(): ModelSpec[] {
  return DEFAULT_PANEL_KEYS.map((k) => MODELS[k]).filter(Boolean);
}

/**
 * Parse a `/debate [models…] [--deep] [motion text]` comment.
 * Leading tokens are consumed while they are a known model alias, `all`, a raw
 * `provider/slug`, or `--deep`. The first token that is none of those begins the
 * motion (everything to the end). Fewer than two distinct models → default panel.
 */
export function parseDebateCommand(body: string): ParsedDebate {
  const after = body.trim().replace(/^\/debate\b/i, "").trim();
  const tokens = after.split(/\s+/).filter(Boolean);

  let deep = false;
  let sawAll = false;
  const named: ModelSpec[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (lower === DEEP_FLAG) {
      deep = true;
      continue;
    }
    if (lower === "all") {
      sawAll = true;
      continue;
    }
    if (MODELS[lower]) {
      if (!seen.has(lower)) {
        seen.add(lower);
        named.push(MODELS[lower]);
      }
      continue;
    }
    if (t.includes("/")) {
      if (!seen.has(lower)) {
        seen.add(lower);
        named.push({ key: t, slug: t, label: t, input: NaN, output: NaN });
      }
      continue;
    }
    break; // first non-model token → motion starts here
  }

  const motionText = tokens.slice(i).join(" ").trim();
  const motion = motionText.length > 0 ? motionText : null;

  let models: ModelSpec[];
  if (sawAll) models = Object.values(MODELS);
  else if (named.length >= 2) models = named;
  else models = defaultPanel();

  return { models, motion, deep };
}

/** Resolve the motion text into its config, choosing the verdict vocabulary. */
export function motionFor(motion: string | null): MotionConfig {
  if (!motion || !motion.trim()) {
    return { motion: DEFAULT_MOTION, isDefault: true, verdicts: ["APPROVE", "REQUEST_CHANGES", "ABSTAIN"] };
  }
  return { motion: motion.trim(), isDefault: false, verdicts: ["FOR", "AGAINST", "ABSTAIN"] };
}

export interface Vote {
  model: ModelSpec;
  verdict: string;
  rationale: string;
}

export interface Tally {
  counts: Record<string, number>;
  /** The plurality winner among substantive (non-ABSTAIN) verdicts, or null on a tie/none. */
  winner: string | null;
  decided: boolean;
  /** Human one-liner, e.g. "2 APPROVE · 1 REQUEST_CHANGES → merge favored". */
  outcomeLine: string;
}

function outcomeLabel(winner: string | null, cfg: MotionConfig): string {
  if (!winner) return "split — no consensus";
  if (cfg.isDefault) return winner === "APPROVE" ? "merge favored" : "changes requested";
  return winner === "FOR" ? "motion carries" : "motion fails";
}

/** Tally the votes democratically: plurality of substantive verdicts wins; a tie
 *  at the top (or no substantive votes) is an honest "split — no consensus". */
export function tally(votes: Vote[], cfg: MotionConfig): Tally {
  const counts: Record<string, number> = {};
  for (const v of cfg.verdicts) counts[v] = 0;
  for (const v of votes) {
    const key = cfg.verdicts.includes(v.verdict) ? v.verdict : "ABSTAIN";
    counts[key] += 1;
  }

  const substantive = cfg.verdicts
    .filter((v) => v !== "ABSTAIN")
    .map((v) => ({ v, n: counts[v] }))
    .sort((a, b) => b.n - a.n);
  const top = substantive[0];
  const tie = substantive.length > 1 && Boolean(top) && substantive[1].n === top.n;
  const decided = Boolean(top && top.n > 0 && !tie);
  const winner = decided ? top.v : null;

  const countsStr = cfg.verdicts
    .filter((v) => counts[v] > 0)
    .map((v) => `${counts[v]} ${v}`)
    .join(" · ");
  const label = outcomeLabel(winner, cfg);
  const outcomeLine = countsStr ? `${countsStr} → ${label}` : label;

  return { counts, winner, decided, outcomeLine };
}

/** Rotate an array left by n (wraps); used to vary debate speaking order per round. */
export function rotate<T>(arr: T[], n: number): T[] {
  if (arr.length === 0) return arr;
  const k = ((n % arr.length) + arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}
