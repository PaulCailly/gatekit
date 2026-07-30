/**
 * Pure, dependency-free logic for the `/qa` command — everything that can be
 * unit-tested without a browser or the Gemini API: command parsing, exploration
 * budgets, coordinate denormalisation, the origin allowlist, the loop's
 * "stuck on one screen" detector, finding normalisation, and the report
 * markdown. The IO (Playwright + Gemini computer use) lives in `qa.ts`,
 * `lib/gemini.ts`, and `lib/browser.ts`.
 */

import type { Coverage } from "./qa-map.js";

/** `/qa` (scoped, the default) vs `/qa all` (full-app sweep) vs `/qa focus <domain>` vs `/qa i18n` vs `/qa offline`. */
export type QaMode = "scoped" | "full" | "focus" | "i18n" | "offline";

/** Which device viewport the run emulates. */
export type QaViewport = "desktop" | "mobile";

/** Criticality of a QA finding, most → least severe. Mirrors `/review`'s
 *  three-tier scale but adds a top "critical" rung for outright broken flows. */
export type QaSeverity = "critical" | "major" | "minor" | "info";

export const SEVERITY_ORDER: QaSeverity[] = ["critical", "major", "minor", "info"];

export const SEVERITY_EMOJI: Record<QaSeverity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  info: "🔵",
};

/**
 * Knobs for the QA run, kept in one place so the cost/behaviour is transparent.
 * `budgets` are the maximum number of model turns (each ≈ one screenshot + one
 * batch of actions) — the scoped default is deliberately small so a per-PR `/qa`
 * stays cheap; `/qa all` gets a much larger ceiling for a release sweep.
 */
export const QA_CONFIG = {
  /** The only model we use for now (per request). */
  model: "gemini-3.5-flash",
  environment: "browser" as const,
  /** Viewport the screenshots are taken at; coordinates are scaled to this. */
  screen: { width: 1440, height: 900 },
  /** Named viewports for `/qa mobile`. `screen` (above) stays the desktop default
   *  used wherever a viewport isn't passed explicitly. */
  viewports: {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  } as Record<QaViewport, { width: number; height: number }>,
  /**
   * Direct address-bar navigation and history-forward let the agent teleport to
   * routes instead of discovering them by clicking, and aren't how a real user
   * without dev tools explores. We exclude them so exploration is genuine
   * click-through; `go_back` (the browser back button) stays — a human has that.
   */
  excludedFunctions: ["navigate", "go_forward"],
  /**
   * Computer-use safety policies we disable. Otherwise the model attaches a
   * `safety_decision` to flagged clicks (login/account/data actions) and the
   * Interactions API 400s the next turn unless the function response *echoes an
   * acknowledgement* — which this exploration loop doesn't send. Safe to disable
   * here: the QA target is always a throwaway preview, and `isDestructiveIntent`
   * (browser.ts) still blocks the actually-destructive actions client-side
   * regardless of what the model proposes.
   */
  disabledSafetyPolicies: [
    "financial_transactions",
    "sensitive_data_modification",
    "communication_tool",
    "account_creation",
    "data_modification",
    "user_consent_management",
    "legal_terms_and_agreements",
  ],
  budgets: { scoped: 40, full: 900, focus: 120, i18n: 20, offline: 50 } as Record<QaMode, number>,
  /** Same screen seen this many times in a row → the agent is stuck/looping. */
  stuckThreshold: 4,
  /** Gemini 3.5 Flash computer-use pricing, USD per 1M tokens — an ESTIMATE for
   *  the run-cost line (screenshots count as input tokens). */
  pricing: { input: 0.3, output: 2.5 },
} as const;

export interface ParsedQa {
  mode: QaMode;
  /** Explicit target URL from the comment, or null → resolve the PR preview. */
  url: string | null;
  /** Focus-mode domain key (lower-cased), or null. */
  focus: string | null;
  /** Device viewport for the run (default desktop). */
  viewport: QaViewport;
}

/**
 * Parse a `/qa [all] [url]` comment.
 * - `all` anywhere → full-app sweep (else scoped to the PR's changes).
 * - the first `http(s)://…` token → an explicit target URL (trailing
 *   punctuation from prose like "see https://x.app." or "(https://x.app)" is
 *   trimmed).
 * Everything else is ignored, so `/qa please test all` still works.
 */
export function parseQaCommand(body: string): ParsedQa {
  const after = body.trim().replace(/^\/qa\b/i, "").trim();
  const tokens = after.split(/\s+/).filter(Boolean);

  let mode: QaMode = "scoped";
  let url: string | null = null;
  let focus: string | null = null;
  let viewport: QaViewport = "desktop";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (lower === "all") {
      mode = "full";
      continue;
    }
    if (lower === "focus") {
      mode = "focus";
      // The next non-URL token is the domain.
      const next = tokens[i + 1];
      if (next && !/^https?:\/\//i.test(next)) {
        focus = next.toLowerCase();
        i++;
      }
      continue;
    }
    if (lower === "i18n") {
      mode = "i18n";
      continue;
    }
    if (lower === "offline") {
      mode = "offline";
      continue;
    }
    if (lower === "mobile") {
      viewport = "mobile";
      continue;
    }
    if (lower === "desktop") {
      viewport = "desktop";
      continue;
    }
    if (url === null) {
      // Strip wrapping/trailing prose punctuation a human might add in a
      // sentence — a leading paren/quote/angle, or a trailing one / sentence
      // punctuation — before deciding whether the token is a URL.
      const cleaned = t.replace(/^[([{<"']+/, "").replace(/[)\]}>"'.,;:!?]+$/, "");
      if (/^https?:\/\//i.test(cleaned)) url = cleaned;
    }
  }
  return { mode, url, focus, viewport };
}

export function budgetFor(mode: QaMode): number {
  return QA_CONFIG.budgets[mode];
}

/** Scale a normalised computer-use coordinate (0–999) to a real pixel. */
export function denormalize(coord: number, size: number): number {
  return Math.floor((coord / 1000) * size);
}

/** True when `url` is on the same origin as the target app. The QA agent is
 *  kept on-origin: a click that leaves the app (an external link, an OAuth
 *  provider) is not part of testing the app and is where it could wander into
 *  untrusted pages, so the loop sends it back. Malformed URLs are disallowed. */
export function isAllowedUrl(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** True when a URL path ends in `/pin` — a loose match for the staff-PIN login
 *  gate. NOTE: this is a suffix heuristic, so a future `/settings/.../pin` index
 *  route could also match; callers detecting the *login* gate must corroborate
 *  (e.g. `signIn` ANDs this with a 4-field Chakra PinInput check). */
export function looksLikePinScreen(url: string): boolean {
  try {
    return /\/pin$/.test(new URL(url).pathname.replace(/\/$/, ""));
  } catch {
    return false;
  }
}

/** Turn indices to cut the network at (~30% in) and restore (~70% in), so the
 *  middle of the run is offline. */
export function offlineWindowFor(budget: number): { start: number; end: number } {
  return { start: Math.floor(budget * 0.3), end: Math.floor(budget * 0.7) };
}

export interface ConsoleError {
  phase: "online" | "offline" | "resync";
  kind: "pageerror" | "console";
  text: string;
}

/** Uncaught exceptions during the offline or resync window become `major`
 *  findings (the app broke without a connection or failed to recover). Plain
 *  console noise and anything from the online baseline are ignored. */
export function offlineFindings(errors: ConsoleError[]): QaFinding[] {
  return errors
    .filter((e) => e.kind === "pageerror" && (e.phase === "offline" || e.phase === "resync"))
    .map((e) => {
      const phaseLabel = e.phase === "resync" ? "reconnecting (resync)" : "offline";
      return {
        severity: "major" as QaSeverity,
        area: "offline",
        title: `Uncaught error while ${phaseLabel}: ${e.text.slice(0, 80)}`,
        description: `The app threw an uncaught exception during the ${e.phase} phase — the offline-first experience is broken here.`,
        steps: "Explored the app, cut the network mid-session, then restored it.",
        expected: "The app keeps working offline (queuing writes) and resyncs cleanly on reconnect.",
        actual: e.text,
      };
    });
}

/** One-line probe summary for the report. */
export function renderOfflineProbe(errors: ConsoleError[], offlineTurns: number): string {
  if (offlineTurns <= 0) {
    return [
      "### 📡 Offline probe",
      "",
      "_The agent finished before the offline window — the network was never cut, so this run did not test offline behaviour._",
      "",
    ].join("\n");
  }
  const offline = errors.filter((e) => e.phase === "offline").length;
  const resync = errors.filter((e) => e.phase === "resync").length;
  return [
    "### 📡 Offline probe",
    "",
    `Explored ~${offlineTurns} step(s) with the network cut. Uncaught errors — offline: ${offline}, on resync: ${resync}.`,
    "",
  ].join("\n");
}

/**
 * Lowercased substrings that mark an action's `intent` as potentially
 * destructive / irreversible. This is the deny-list layer of defence (atop the
 * system-prompt rule + origin allowlist): the agent describes every action with
 * an `intent`, and `executeAction` refuses to actuate one matching these,
 * telling the model to record it as a finding instead. Kept deliberately
 * targeted at account/data-destruction and payment/registration verbs so it
 * doesn't block ordinary form exploration (toggles, filters, search, saving a
 * draft), which the agent is meant to do.
 */
export const DESTRUCTIVE_INTENT_PATTERNS = [
  "delete account",
  "delete my account",
  "delete all",
  "remove account",
  "close account",
  "deactivate",
  "erase",
  "wipe",
  "reset all",
  "pay",
  "payment",
  "checkout",
  "place order",
  "purchase",
  "buy now",
  "subscribe",
  "sign up",
  "signup",
  "create account",
  "register",
] as const;

/** True when an action's `intent` looks destructive/irreversible per the
 *  deny-list. Empty/absent intent is treated as safe (the action is allowed). */
export function isDestructiveIntent(intent: unknown): boolean {
  if (typeof intent !== "string" || !intent) return false;
  const t = intent.toLowerCase();
  return DESTRUCTIVE_INTENT_PATTERNS.some((p) => t.includes(p));
}

/**
 * Derive the app areas a PR touches from its changed-file paths, so a scoped
 * `/qa` can tell the agent where to concentrate. Supports two layouts:
 *   - Legacy:    `src/presentation/screens/<area>/…`
 *   - Backresto: `src/pages/[locale]/[modules/]<area>/…`
 * Returns a sorted, de-duplicated list (empty when nothing maps to a page —
 * the caller then falls back to a light whole-app pass).
 */
export function affectedAreas(files: string[]): string[] {
  const areas = new Set<string>();
  for (const f of files) {
    const m = /(?:^|\/)src\/(?:pages\/(?:\[locale\]\/)?(?:modules\/)?|presentation\/screens\/)([a-z0-9][a-z0-9-]*)(?:\/|\.tsx?$)/i.exec(f);
    if (m && !["_app", "_document", "_error"].includes(m[1].toLowerCase())) areas.add(m[1]);
  }
  return [...areas].sort();
}

export interface PrComment {
  author: string;
  body: string;
}

/** HTML-comment markers the QA bot stamps on its own PR comments; we exclude
 *  those from the PR context so the agent never reads its own past output. */
const QA_SELF_MARKERS = ["<!-- qa:report -->", "<!-- qa:status -->"];

/**
 * Build the "what this PR is about" prompt section from the PR title, body, and
 * discussion comments — so the agent tests the actual change and re-checks what
 * reviewers raised. The QA bot's own status/report comments are excluded
 * (self-reference), bodies are truncated, and the comment list is capped.
 * Returns "" when there's nothing useful to add.
 */
export function buildPrContext(
  input: { title: string; body: string | null; comments: PrComment[] },
  opts: { maxBodyChars?: number; maxComments?: number; maxCommentChars?: number } = {},
): string {
  const maxBody = opts.maxBodyChars ?? 1200;
  const maxComments = opts.maxComments ?? 12;
  const maxComment = opts.maxCommentChars ?? 280;
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …" : s);

  const lines: string[] = [];
  const title = input.title?.trim();
  const body = input.body?.trim();
  if (title) lines.push(`**Title:** ${title}`);
  if (body) lines.push("", `**Description:**`, trunc(body, maxBody));

  const relevant = input.comments
    .filter((c) => c.body && !QA_SELF_MARKERS.some((m) => c.body.includes(m)))
    .slice(0, maxComments)
    .map((c) => `- [${c.author}] ${trunc(c.body.replace(/\s+/g, " ").trim(), maxComment)}`);
  if (relevant.length > 0) {
    lines.push("", "**Reviewers / discussion raised (re-check these):**", ...relevant);
  }

  if (lines.length === 0) return "";
  return ["## What this PR is about (test the actual change)", "", ...lines].join("\n");
}

export interface QaFinding {
  severity: QaSeverity;
  /** Screen / feature the issue is in, e.g. "coach", "onboarding". */
  area: string;
  title: string;
  description: string;
  /** How to reproduce, as the agent did it. */
  steps: string;
  expected: string;
  actual: string;
}

/** Coerce one raw `report_finding` tool payload into a well-formed finding, or
 *  null if it lacks a title. Defends every field — the model's output varies. */
export function normalizeFinding(raw: unknown): QaFinding | null {
  const f = (raw ?? {}) as Record<string, unknown>;
  if (!f.title) return null;
  const sev = String(f.severity ?? "").toLowerCase();
  const severity = (SEVERITY_ORDER as string[]).includes(sev) ? (sev as QaSeverity) : "info";
  const str = (v: unknown) => (v == null ? "" : String(v));
  return {
    severity,
    area: str(f.area) || "general",
    title: String(f.title),
    description: str(f.description),
    steps: str(f.steps_to_reproduce ?? f.steps),
    expected: str(f.expected),
    actual: str(f.actual),
  };
}

/** Drop duplicate findings (same area + title, case-insensitively) the agent
 *  may report twice when it revisits a screen; keeps the first occurrence. */
export function dedupeFindings(findings: QaFinding[]): QaFinding[] {
  const seen = new Set<string>();
  const out: QaFinding[] = [];
  for (const f of findings) {
    const key = `${f.area}::${f.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Order findings by severity (critical first), then area, then title — the
 *  order they're rendered in the report. Stable and non-mutating. */
export function sortFindings(findings: QaFinding[]): QaFinding[] {
  const rank = (s: QaSeverity) => SEVERITY_ORDER.indexOf(s);
  return [...findings].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      a.area.localeCompare(b.area) ||
      a.title.localeCompare(b.title),
  );
}

export function severityCounts(findings: QaFinding[]): Record<QaSeverity, number> {
  const counts: Record<QaSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * Count how many times the *last* screen signature repeats consecutively at the
 * end of the visit history. The loop uses this to detect that the agent is
 * stuck on / looping over one screen and nudge or stop it (token-efficiency).
 * Empty history → 0; a lone last entry → 1.
 */
export function trailingRepeats(history: string[]): number {
  if (history.length === 0) return 0;
  const last = history[history.length - 1];
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === last; i--) n++;
  return n;
}

/** Minimal shape of a per-turn function result the loop attaches state to.
 *  Structural on purpose — `gemini.ts`'s `FunctionResult` satisfies it, so this
 *  pure module never has to import the Gemini SDK. */
export interface TurnResult {
  name: string;
  result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mime_type: "image/png" }>;
}

export interface TurnHintOptions {
  url: string;
  /** The agent clicked off-origin this turn and was sent back. */
  leftApp: boolean;
  /** Consecutive turns on the same screen (from `trailingRepeats`). */
  repeats: number;
  stuckThreshold: number;
}

/** Build the text sent alongside the screenshot each turn: the current URL, an
 *  off-origin recovery note, and a nudge once the agent looks stuck looping. */
export function buildTurnHint(o: TurnHintOptions): string {
  let hint = `url: ${o.url}`;
  if (o.leftApp) hint += " (you left the app; returned you to it — stay inside the app)";
  if (o.repeats >= o.stuckThreshold) {
    hint += " — you've been on this screen a while; move to an area you haven't explored yet, or wrap up.";
  }
  return hint;
}

/**
 * Attach the turn's hint + screenshot to the function results, returning a new
 * array (non-mutating). The screenshot rides on the last computer-use action
 * result if there is one, else the last result — and is **appended**, so a
 * `report_finding` result keeps its "recorded" ack instead of being overwritten
 * by the image. Empty input is returned unchanged (the loop never sends an empty
 * turn, but the helper stays total so that guarantee isn't load-bearing).
 */
export function attachStateToResults<T extends TurnResult>(
  results: T[],
  hint: string,
  screenshotBase64: string,
): T[] {
  if (results.length === 0) return results;
  let target = results.length - 1;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].name !== "report_finding") {
      target = i;
      break;
    }
  }
  return results.map((r, i) =>
    i === target
      ? {
          ...r,
          result: [
            ...r.result,
            { type: "text" as const, text: hint },
            { type: "image" as const, data: screenshotBase64, mime_type: "image/png" as const },
          ],
        }
      : r,
  );
}

/** Run cost/metrics for the benchmark line (mirrors the `/review` job's data). */
export interface RunMetrics {
  /** Model turns actually spent. */
  steps: number;
  /** Step budget for this mode. */
  budget: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD, or null when pricing is unknown. */
  costUsd: number | null;
  durationMs: number;
}

export interface DownloadRecord {
  filename: string;
  sizeBytes: number;
}

export type DownloadKind = "pdf" | "csv" | "zip" | "unknown";

export interface DownloadVerdict {
  filename: string;
  kind: DownloadKind;
  sizeBytes: number;
  ok: boolean;
  reason: string;
}

/** Locales whose UI must render right-to-left. */
export const RTL_LOCALES = ["ar"] as const;

export interface LocaleObservation {
  locale: string;
  /** Navigation succeeded and the page rendered (not an error page). */
  loaded: boolean;
  htmlLang: string | null;
  /** Resolved text direction ("ltr" | "rtl" | null when unknown). */
  dir: string | null;
  /** documentElement.scrollWidth − clientWidth; >0 means horizontal overflow. */
  horizontalOverflowPx: number;
  /** Visible strings that look like untranslated i18n keys (kebab, 3+ segments). */
  rawKeyHits: string[];
  /** Visible `{{ … }}` placeholders that were not replaced by i18next (interpolation leak). */
  interpolationLeaks?: string[];
}

export interface LocaleVerdict {
  locale: string;
  ok: boolean;
  issues: string[];
}

/** Build a same-origin locale-root URL, e.g. ("https://x.app/", "ar") → "https://x.app/ar". */
export function localeRootUrl(origin: string, locale: string): string {
  return new URL(`/${locale}`, origin).toString().replace(/\/$/, "");
}

/** Overflow beyond this many pixels counts as a layout problem (sub-pixel/rounding noise tolerated). */
const OVERFLOW_TOLERANCE_PX = 4;

export function classifyLocale(obs: LocaleObservation): LocaleVerdict {
  const issues: string[] = [];
  if (!obs.loaded) {
    issues.push("locale page failed to load");
  } else {
    if ((RTL_LOCALES as readonly string[]).includes(obs.locale) && obs.dir !== "rtl") {
      issues.push(`expected RTL direction, got "${obs.dir ?? "none"}"`);
    }
    if (obs.horizontalOverflowPx > OVERFLOW_TOLERANCE_PX) {
      issues.push(`horizontal overflow (${obs.horizontalOverflowPx}px) — content clipped or layout broken`);
    }
    if (obs.rawKeyHits.length > 0) {
      issues.push(`possible untranslated keys visible: ${obs.rawKeyHits.slice(0, 5).join(", ")}`);
    }
    const leaks = obs.interpolationLeaks ?? [];
    if (leaks.length > 0) {
      issues.push(`raw interpolation placeholders visible (untranslated): ${leaks.slice(0, 5).join(", ")}`);
    }
    if (obs.htmlLang && obs.htmlLang.split("-")[0].toLowerCase() !== obs.locale.toLowerCase()) {
      issues.push(`locale redirected — page rendered as "${obs.htmlLang}" instead of "${obs.locale}"`);
    }
  }
  return { locale: obs.locale, ok: issues.length === 0, issues };
}

/** One finding per issue. Load failures, wrong RTL, and locale redirects are
 *  `major`; overflow and untranslated keys are `minor`. */
export function localeFindings(v: LocaleVerdict): QaFinding[] {
  return v.issues.map((issue) => {
    const severity: QaSeverity = /failed to load|expected RTL|rendered as|interpolation placeholders/i.test(issue) ? "major" : "minor";
    return {
      severity,
      area: `i18n/${v.locale}`,
      title: `[${v.locale}] ${issue}`,
      description: `Localisation check for "${v.locale}": ${issue}.`,
      steps: `Loaded the ${v.locale} locale root and inspected the page.`,
      expected: "A correctly localised, well-laid-out page (RTL for Arabic), with no raw translation keys.",
      actual: issue,
    };
  });
}

/** Render the i18n sweep as a report section: an ok/issue count + a per-locale table.
 *  Empty string when no locales were swept. */
export function renderI18nSweep(verdicts: LocaleVerdict[]): string {
  if (verdicts.length === 0) return "";
  const okCount = verdicts.filter((v) => v.ok).length;
  const lines = [
    "### 🌍 Localisation (i18n) sweep",
    "",
    `${okCount} ok · ${verdicts.length - okCount} with issues (of ${verdicts.length} locales)`,
    "",
    "| Locale | Status | Issues |",
    "| --- | --- | --- |",
  ];
  for (const v of verdicts) {
    lines.push(`| ${v.locale} | ${v.ok ? "✅" : "⚠️"} | ${v.ok ? "—" : v.issues.join("; ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface ReportOptions {
  mode: QaMode;
  targetUrl: string;
  findings: QaFinding[];
  /** Model turns spent — surfaced so the cost of the run is visible. */
  turns: number;
  /** Scope note for scoped runs, e.g. "Focused on changed areas: coach, home". */
  scopeNote?: string;
  /** A warning to show at the top (e.g. prompt-injection halt, no preview URL). */
  note?: string;
  /** The agent's free-text wrap-up of what it exercised (when it finished on
   *  its own) — the coverage narrative that contextualises the findings. */
  summary?: string;
  /** HTML-comment marker that makes the comment updatable in place. */
  marker: string;
  /** Optional run cost/metrics, rendered as a benchmark line under the findings. */
  metrics?: RunMetrics;
  /** Optional published rrweb replay URL, linked near the top of the report. */
  replayUrl?: string | null;
  /** Optional coverage block (overall + per-domain) rendered above the metrics. */
  coverage?: Coverage | null;
  /** Optional export-download verdicts, rendered as a section above coverage. */
  downloads?: DownloadVerdict[] | null;
  /** Device viewport the run used, shown in the metrics line. */
  viewport?: QaViewport;
  /** Optional i18n sweep verdicts, rendered as a section above coverage. */
  i18n?: LocaleVerdict[] | null;
  /** Optional offline-probe data, rendered as a section above downloads. */
  offline?: { errors: ConsoleError[]; offlineTurns: number } | null;
  /** Aggregate (fan-out) runs: per-domain shard status so a crashed shard shows
   *  ✗ <reason> in the coverage table instead of a misleading 0%. */
  domainStatus?: Array<{ domain: string; ok: boolean; reason?: string }>;
}

const DOWNLOAD_KINDS: Record<string, DownloadKind> = { pdf: "pdf", csv: "csv", zip: "zip" };

/** Grade a captured download: a known export type (pdf/csv/zip) with non-zero
 *  bytes passes; anything empty or of an unrecognised type fails. Content is
 *  never parsed — size + extension are the signal. */
export function classifyDownload(rec: DownloadRecord): DownloadVerdict {
  const ext = (rec.filename.split(".").pop() ?? "").toLowerCase();
  const kind = DOWNLOAD_KINDS[ext] ?? "unknown";
  let ok = true;
  let reason = "ok";
  if (kind === "unknown") {
    ok = false;
    reason = `unrecognised export type ".${ext || "(none)"}"`;
  } else if (rec.sizeBytes <= 0) {
    ok = false;
    reason = "downloaded file is empty (0 bytes)";
  }
  return { filename: rec.filename, kind, sizeBytes: rec.sizeBytes, ok, reason };
}

/** A graded export problem becomes a `major` finding so it shows in the report's
 *  findings list; a good download produces no finding (it's expected behaviour). */
export function downloadFinding(v: DownloadVerdict): QaFinding | null {
  if (v.ok) return null;
  return {
    severity: "major",
    area: "exports",
    title: `Export download problem: ${v.filename}`,
    description: `An export the agent triggered did not produce a valid file: ${v.reason}.`,
    steps: "Triggered an export (PDF/CSV) and captured the resulting download.",
    expected: "A non-empty PDF, CSV, or ZIP file.",
    actual: `${v.filename} (${v.sizeBytes} bytes) — ${v.reason}.`,
  };
}

/** Compact, human-readable B/kB/MB for the download size column. */
function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

/** Render the export-downloads section: a verified/failed count line and a table.
 *  Empty string when no downloads were captured (so the report omits it). */
export function renderDownloads(verdicts: DownloadVerdict[]): string {
  if (verdicts.length === 0) return "";
  const verified = verdicts.filter((v) => v.ok).length;
  const failed = verdicts.length - verified;
  const lines = [
    "### 📥 Export downloads",
    "",
    `${verified} verified · ${failed} failed`,
    "",
    "| File | Type | Size | OK |",
    "| --- | --- | --- | --- |",
  ];
  for (const v of verdicts) {
    lines.push(`| \`${v.filename}\` | ${v.kind} | ${fmtBytes(v.sizeBytes)} | ${v.ok ? "✅" : "❌"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Render the coverage block: overall %, a per-domain table, and the out-of-scope
 *  note. Scoped/focus runs are labelled partial-by-design (only `/qa all` aims at
 *  full coverage). Pass `domainStatus` (from `ReportOptions`) so aggregate fan-out
 *  runs can show `✗ <reason>` for a crashed shard instead of a misleading 0%. */
export function renderCoverage(cov: Coverage, mode: QaMode, domainStatus?: Array<{ domain: string; ok: boolean; reason?: string }>): string {
  const lines = ["### 🗺️ Coverage", ""];
  const partial = mode !== "full";
  lines.push(
    `Overall: **${cov.overall.covered}/${cov.overall.total} routes (${cov.overall.pct}%)**` +
      (cov.outOfScopeCount > 0 ? ` · excludes ${cov.outOfScopeCount} out-of-scope` : "") +
      (partial ? " · _partial by design (this run is not a full sweep)_" : ""),
    "",
  );
  if (cov.domains.length > 0) {
    lines.push("| Domain | Covered | % |", "| --- | --- | --- |");
    for (const d of cov.domains) {
      const flag = d.total > 0 && d.pct === 0 ? " 🔴" : "";
      const st = domainStatus?.find((s) => s.domain === d.key);
      const cell = st && !st.ok ? `✗ | ${st.reason ?? "shard failed"}` : `${d.covered}/${d.total} | ${d.pct}%${flag}`;
      lines.push(`| ${d.label} \`${d.key}\` | ${cell} |`);
    }
    lines.push("");
  }
  if (cov.outOfScopeRoutes.length > 0) {
    lines.push(`Out of scope (not counted): ${cov.outOfScopeRoutes.map((r) => `\`${r}\``).join(", ")}`, "");
  }
  return lines.join("\n");
}

function findingBlock(f: QaFinding): string {
  const lines = [`### ${SEVERITY_EMOJI[f.severity]} ${f.title} · \`${f.area}\``, ""];
  if (f.description) lines.push(f.description, "");
  if (f.steps) lines.push(`**Steps:** ${f.steps}`);
  if (f.expected || f.actual) {
    lines.push(`**Expected:** ${f.expected || "—"}`, `**Actual:** ${f.actual || "—"}`);
  }
  return lines.join("\n");
}

/**
 * Render the QA run as a sticky PR comment body. Groups findings by severity
 * (critical → info), leads with a count line (or a clean-bill-of-health note),
 * and ends with the run footprint and the in-place-update marker.
 */
export function buildReport(opts: ReportOptions): string {
  const findings = sortFindings(dedupeFindings(opts.findings));
  const counts = severityCounts(findings);
  const label =
    opts.mode === "full" ? "full-app sweep" :
    opts.mode === "focus" ? "focused run" :
    opts.mode === "i18n" ? "i18n sweep" :
    opts.mode === "offline" ? "offline probe" :
    "scoped to PR changes";

  const parts = [`## 🕵️ QA exploration · ${label}`, "", `**Target:** ${opts.targetUrl}`];
  if (opts.scopeNote) parts.push(opts.scopeNote);
  if (opts.replayUrl) {
    parts.push(
      "",
      `▶ **[Watch the session recording](${opts.replayUrl})** — pulsing markers show every click & tap. _(link valid 7 days)_`,
    );
  }
  parts.push("");
  if (opts.note) parts.push(`> ${opts.note}`, "");

  if (findings.length === 0) {
    parts.push("No issues found — the explored flows behaved as expected. ✅");
  } else {
    parts.push(
      `Found **${findings.length}** issue(s): ` +
        SEVERITY_ORDER.filter((s) => counts[s] > 0)
          .map((s) => `${counts[s]} ${SEVERITY_EMOJI[s]}`)
          .join(" · "),
      "",
    );
    for (const f of findings) parts.push(findingBlock(f), "");
  }

  if (opts.summary) {
    // Inline <details> (this module stays import-free) so the agent's coverage
    // narrative is available but doesn't dominate the findings.
    parts.push("<details>", "<summary>🧭 What the agent exercised</summary>", "", opts.summary, "", "</details>", "");
  }

  if (opts.i18n && opts.i18n.length > 0) {
    parts.push(renderI18nSweep(opts.i18n), "");
  }

  if (opts.offline) {
    parts.push(renderOfflineProbe(opts.offline.errors, opts.offline.offlineTurns), "");
  }

  if (opts.downloads && opts.downloads.length > 0) {
    parts.push(renderDownloads(opts.downloads), "");
  }

  if (opts.coverage) {
    parts.push(renderCoverage(opts.coverage, opts.mode, opts.domainStatus), "");
  }

  if (opts.metrics) {
    const m = opts.metrics;
    const cost =
      m.costUsd === null ? "—" : `~$${m.costUsd < 0.01 ? m.costUsd.toFixed(4) : m.costUsd.toFixed(2)}`;
    const findingsCell =
      findings.length === 0
        ? "none"
        : SEVERITY_ORDER.filter((s) => counts[s] > 0)
            .map((s) => `${counts[s]} ${SEVERITY_EMOJI[s]}`)
            .join(" · ");
    parts.push(
      "---",
      "",
      `**📊 Run metrics** · \`${QA_CONFIG.model}\` · ${label}${opts.viewport ? ` · ${opts.viewport}` : ""}`,
      "",
      "| Steps | Tokens (in/out) | Est. cost | Duration | Findings |",
      "| --- | --- | --- | --- | --- |",
      `| ${m.steps} / ${m.budget} | ${fmtTokens(m.inputTokens)} / ${fmtTokens(m.outputTokens)} | ${cost} | ${fmtDuration(m.durationMs)} | ${findingsCell} |`,
      "",
    );
  }

  parts.push(
    "",
    `<sub>Explored ${opts.turns} step(s) like a user via \`${QA_CONFIG.model}\` computer use — ` +
      `no dev tools, no direct URL entry.</sub>`,
    "",
    opts.marker,
  );
  return parts.join("\n");
}

/** Compact token count: 1234567 → "1.2M", 4100 → "4.1k". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Wall-clock: 42000 → "42s", 702000 → "11m 42s". */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
