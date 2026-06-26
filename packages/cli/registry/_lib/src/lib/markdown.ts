import { estimateCost, type ModelSpec } from "./openrouter.js";
import type { Usage } from "./types.js";

/** Wrap `body` in a collapsible `<details>` block with the given summary. */
export function details(summary: string, body: string): string {
  return ["<details>", `<summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

/** Collapsible token-usage and estimated-cost breakdown for one model run.
 *  The caller supplies the summary title (e.g. "💰 Review cost" / "💰 Audit cost"). */
export function costTable(title: string, usage: Usage, turns: number, model: ModelSpec): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const cost = estimateCost(usage, model);
  return details(
    title,
    [
      "| Metric | Value |",
      "| --- | --- |",
      `| Model | \`${model.slug}\` |`,
      `| Agentic turns | ${turns} |`,
      `| Input tokens | ${n(usage.input_tokens)} |`,
      `| Output tokens | ${n(usage.output_tokens)} |`,
      `| **Estimated cost** | **${cost === null ? "n/a (unpriced model)" : `$${cost.toFixed(2)}`}** |`,
    ].join("\n"),
  );
}
