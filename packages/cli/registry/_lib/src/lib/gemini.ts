/**
 * Thin wrapper around the Gemini Interactions API (computer use) — the only
 * model surface `/qa` uses. Keeps the SDK call and its snake_case request/response
 * shape in one place so the agent loop in `qa.ts` works with plain typed helpers.
 *
 * The Interactions API is documented at
 * https://ai.google.dev/gemini-api/docs/computer-use (Interactions API tab).
 */
import { GoogleGenAI } from "@google/genai";

import { QA_CONFIG } from "./qa-core.js";

/** A UI action (or custom tool call) the model wants the client to perform. */
export interface FunctionCall {
  type: "function_call";
  /** Action name, e.g. "click", "type", "scroll", or our custom "report_finding". */
  name: string;
  /** Arguments — coordinates, text, intent, etc. Shape varies by `name`. */
  arguments: Record<string, unknown>;
  /** Unique id to echo back in the matching function_result. */
  id: string;
}

/** One result fed back to the model after the client executes an action. */
export interface FunctionResult {
  type: "function_result";
  name: string;
  call_id: string;
  result: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mime_type: "image/png" }
  >;
}

/** A piece of model input: free text, an image, or a function result. */
export type InteractionInput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: "image/png" }
  | FunctionResult;

interface InteractionStep {
  type: string;
  // function_call
  name?: string;
  arguments?: Record<string, unknown>;
  id?: string;
  // model_output
  content?: Array<{ type: string; text?: string }>;
}

export interface Interaction {
  id: string;
  steps?: InteractionStep[];
  /** SDK convenience: concatenated text of the last model output, if any. */
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } & Record<string, unknown>;
}

/** A custom (non-predefined) tool the model may call alongside computer use. */
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

let cached: GoogleGenAI | null = null;
export function getGeminiClient(): GoogleGenAI {
  if (cached) return cached;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  cached = new GoogleGenAI({ apiKey });
  return cached;
}

/** The tool array sent on every turn: computer-use (browser) + our custom tools. */
function toolsFor(extra: FunctionTool[]): unknown[] {
  return [
    {
      type: "computer_use",
      environment: QA_CONFIG.environment,
      excluded_predefined_functions: [...QA_CONFIG.excludedFunctions],
      disabled_safety_policies: [...QA_CONFIG.disabledSafetyPolicies],
      enable_prompt_injection_detection: true,
    },
    ...extra,
  ];
}

/** Start a fresh interaction (first turn): system instruction + initial input. */
export async function startInteraction(
  systemInstruction: string,
  input: InteractionInput[],
  extraTools: FunctionTool[],
): Promise<Interaction> {
  const ai = getGeminiClient();
  // The Interactions API uses snake_case fields; the SDK passes them through.
  const resp = await ai.interactions.create({
    model: QA_CONFIG.model,
    system_instruction: systemInstruction,
    tools: toolsFor(extraTools),
    input,
  } as never);
  return resp as unknown as Interaction;
}

/** Continue an interaction by id, sending the results of the executed actions. */
export async function continueInteraction(
  previousInteractionId: string,
  input: InteractionInput[],
  extraTools: FunctionTool[],
): Promise<Interaction> {
  const ai = getGeminiClient();
  const resp = await ai.interactions.create({
    model: QA_CONFIG.model,
    previous_interaction_id: previousInteractionId,
    tools: toolsFor(extraTools),
    input,
  } as never);
  return resp as unknown as Interaction;
}

/** The function calls (UI actions + custom tools) the model emitted this turn. */
export function functionCalls(interaction: Interaction): FunctionCall[] {
  return (interaction.steps ?? [])
    .filter((s) => s.type === "function_call")
    .map((s) => ({
      type: "function_call" as const,
      name: String(s.name),
      arguments: s.arguments ?? {},
      id: String(s.id),
    }));
}

/** Token usage for one interaction, tolerant of the field name the Interactions
 *  API actually returns — it may be `usage`, `usage_metadata` (snake) or
 *  `usageMetadata` (camel), with input/output named `*_tokens`,
 *  `prompt/candidates_token_count`, or the camelCase variants. Zeros if absent. */
export function usageOf(interaction: Interaction): { inputTokens: number; outputTokens: number } {
  const it = interaction as unknown as Record<string, unknown>;
  const u = (it.usage ?? it.usage_metadata ?? it.usageMetadata ?? {}) as Record<string, number>;
  const inputTokens =
    u.total_input_tokens ?? u.input_tokens ?? u.prompt_token_count ?? u.promptTokenCount ?? u.inputTokens ?? 0;
  const outputTokens =
    u.total_output_tokens ?? u.output_tokens ?? u.candidates_token_count ?? u.candidatesTokenCount ?? u.outputTokens ?? 0;
  return { inputTokens, outputTokens };
}

/** The model's final natural-language text for this interaction, if any. */
export function finalText(interaction: Interaction): string {
  if (interaction.text) return interaction.text.trim();
  const out: string[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      if (block.type === "text" && block.text) out.push(block.text);
    }
  }
  return out.join(" ").trim();
}
