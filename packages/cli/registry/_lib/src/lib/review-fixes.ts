import type { FixApproach } from "./types.js";
import { details } from "./markdown.js";

/**
 * Compute a safe Markdown code fence: N backticks where N is strictly greater
 * than the longest contiguous run of backticks in `content`, minimum 3.
 * This matches GitHub's fenced-code-block rule so inner backtick runs cannot
 * terminate the outer fence early.
 */
function safeFence(lang: string, content: string): [open: string, close: string] {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  const n = Math.max(3, longest + 1);
  const ticks = "`".repeat(n);
  return [`${ticks}${lang}`, ticks];
}

/**
 * Heuristic: does the snippet look like JSX?
 * Checks for an opening angle-bracket tag (`<Letter`).
 */
function looksLikeTsx(snippet: string): boolean {
  return /<[A-Za-z]/.test(snippet);
}

/**
 * Render a "Ways to fix this" Markdown block for a PR comment.
 * Returns `""` when `fixes` is empty so callers can skip the section gracefully.
 */
export function renderFixApproaches(fixes: FixApproach[]): string {
  if (!fixes || fixes.length === 0) return "";

  const parts: string[] = ["**Ways to fix this:**", ""];

  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const lang = looksLikeTsx(f.snippet) ? "tsx" : "";
    const [openFence, closeFence] = safeFence(lang, f.snippet);
    const [promptOpen, promptClose] = safeFence("", f.prompt);

    parts.push(`**${f.title}** — ${f.description}`);
    parts.push(`${openFence}\n${f.snippet}\n${closeFence}`);
    parts.push(details("📋 Copy as prompt", `${promptOpen}\n${f.prompt}\n${promptClose}`));

    if (i < fixes.length - 1) parts.push("");
  }

  return parts.join("\n");
}
