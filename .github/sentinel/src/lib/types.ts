export type Severity = "error" | "warning" | "info";

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
