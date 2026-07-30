export type Severity = "error" | "warning" | "info";

export interface FixApproach {
  /** Short approach name, e.g. "Stream", "Cache", "Block". */
  title: string;
  /** One-line description of what this approach does. */
  description: string;
  /** A small code snippet illustrating the fix (no fences). */
  snippet: string;
  /** A copy-pasteable prompt instructing an AI agent to apply THIS approach. */
  prompt: string;
}

export interface Finding {
  /** Path of the changed file the finding applies to. */
  path: string;
  /** Line number in the new version of the file, or null for a file-level note. */
  line: number | null;
  severity: Severity;
  /** Model's confidence the finding is real, 0-100. */
  confidence: number;
  /** bug | security | performance | logic | syntax | style */
  category: string;
  title: string;
  description: string;
  /** What goes wrong if this ships. */
  impact: string;
  /** Exactly 3 distinct fix approaches; may be empty/absent for older model output. */
  fixes?: FixApproach[];
}

export interface ReviewResult {
  summary: string;
  /** Mermaid `sequenceDiagram` body (no fences) tracing the change's main flow; empty for trivial changes. */
  walkthrough: string;
  findings: Finding[];
}

/** Token usage accumulated across all turns of the agentic review. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
