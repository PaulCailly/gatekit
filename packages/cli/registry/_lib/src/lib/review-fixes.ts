import type { FixApproach } from "./types.js";

/**
 * Heuristic: does the snippet look like TSX/JSX?
 * Checks for an opening angle-bracket tag (`<Letter`) or an arrow (`=>`).
 */
function looksLikeTsx(snippet: string): boolean {
  return /<[A-Za-z]/.test(snippet) || /=>/.test(snippet);
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
    const fence = looksLikeTsx(f.snippet) ? "```tsx" : "```";

    parts.push(`**${f.title}** — ${f.description}`);
    parts.push(`${fence}\n${f.snippet}\n\`\`\``);
    parts.push(
      `<details><summary>📋 Copy as prompt</summary>\n\n\`\`\`\n${f.prompt}\n\`\`\`\n</details>`,
    );

    if (i < fixes.length - 1) parts.push("");
  }

  return parts.join("\n");
}
