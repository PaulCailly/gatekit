import type { Vote } from "./debate-core.js";
import type { ModelSpec } from "./openrouter.js";

/** Emoji for each verdict. Verdicts reaching these formatters are already
 *  normalised to a motion's closed vocabulary (see `normStance`), so the
 *  `?? ""` fallbacks at the call sites are defensive, not load-bearing. */
export const VERDICT_EMOJI: Record<string, string> = {
  APPROVE: "✅",
  REQUEST_CHANGES: "🛑",
  FOR: "✅",
  AGAINST: "🛑",
  ABSTAIN: "⚪",
};

export interface Turn {
  model: ModelSpec;
  stance: string;
  text: string;
}

export interface RoundRecord {
  label: string;
  turns: Turn[];
}

/** Sanitise free text for use inside a Mermaid node label. We always quote node
 *  text, so we only neutralise the characters that break even quoted labels on
 *  GitHub's renderer — including backtick and `#`, which can otherwise terminate
 *  the surrounding ``` fence or be read as a class directive. */
export function mmLabel(s: string): string {
  return s.replace(/["|<>{}`#]/g, " ").replace(/\s+/g, " ").trim();
}

/** "Round 0 · Opening statements" → "Opening"; "Round 1 · Rebuttals" → "R1". */
export function shortRoundLabel(label: string): string {
  if (/opening/i.test(label)) return "Opening";
  const m = label.match(/Round\s+(\d+)/i);
  return m ? `R${m[1]}` : label;
}

/** Debaters down the side, rounds across the top, so a reader can see at a glance
 *  where each model stood and how positions moved relative to one another. */
export function positionsTable(rounds: RoundRecord[], votes: Vote[]): string {
  const order: ModelSpec[] = [];
  const seen = new Set<string>();
  const note = (m: ModelSpec) => {
    if (!seen.has(m.key)) {
      seen.add(m.key);
      order.push(m);
    }
  };
  for (const r of rounds) for (const t of r.turns) note(t.model);
  for (const v of votes) note(v.model);
  if (order.length === 0) return "";

  const cell = (stance: string | undefined) => (stance ? `${VERDICT_EMOJI[stance] ?? ""} ${stance}`.trim() : "—");
  const voteByKey = new Map(votes.map((v) => [v.model.key, v.verdict]));
  const stanceByRound = rounds.map((r) => new Map(r.turns.map((t) => [t.model.key, t.stance])));

  const cols = rounds.map((r) => shortRoundLabel(r.label));
  const header = `| Debater | ${cols.join(" | ")} | Final vote |`;
  const sep = `| --- |${cols.map(() => " :---: |").join("")} :---: |`;
  const rows = order.map((m) => {
    const cells = stanceByRound.map((s) => cell(s.get(m.key)));
    const fin = voteByKey.get(m.key);
    return `| **${m.label}** | ${cells.join(" | ")} | ${fin ? `${VERDICT_EMOJI[fin] ?? ""} ${fin}` : "—"} |`;
  });
  return [header, sep, ...rows].join("\n");
}

/** A Mermaid flowchart of the outcome: each debater grouped under the side it
 *  finally voted for, flowing into the decided result. `outcomeLine` is passed
 *  in (already computed by the caller's tally) to avoid a second tally. */
export function outcomeDiagram(votes: Vote[], outcomeLine: string): string {
  if (votes.length === 0) return "";
  const groups = new Map<string, ModelSpec[]>();
  for (const v of votes) {
    const arr = groups.get(v.verdict) ?? [];
    arr.push(v.model);
    groups.set(v.verdict, arr);
  }

  const lines = ["```mermaid", "flowchart LR"];
  let gi = 0;
  const groupIds: string[] = [];
  for (const [verdict, mdls] of groups) {
    const gid = `G${gi++}`;
    groupIds.push(gid);
    const emoji = VERDICT_EMOJI[verdict] ?? "";
    lines.push(`  subgraph ${gid}["${`${emoji} ${verdict} (${mdls.length})`.trim()}"]`);
    lines.push("    direction TB");
    mdls.forEach((m, i) => lines.push(`    ${gid}n${i}["${mmLabel(m.label)}"]`));
    lines.push("  end");
  }
  lines.push(`  Out(["🏁 ${mmLabel(outcomeLine)}"])`);
  for (const gid of groupIds) lines.push(`  ${gid} --> Out`);
  lines.push("```");
  return lines.join("\n");
}
