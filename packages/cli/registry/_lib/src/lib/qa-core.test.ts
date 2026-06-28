import assert from "node:assert/strict";
import { test } from "node:test";

import {
  affectedAreas,
  attachStateToResults,
  budgetFor,
  buildPrContext,
  buildReport,
  buildTurnHint,
  classifyDownload,
  classifyLocale,
  dedupeFindings,
  denormalize,
  downloadFinding,
  isAllowedUrl,
  isDestructiveIntent,
  localeFindings,
  localeRootUrl,
  looksLikePinScreen,
  normalizeFinding,
  offlineFindings,
  offlineWindowFor,
  parseQaCommand,
  QA_CONFIG,
  renderCoverage,
  renderDownloads,
  renderI18nSweep,
  renderOfflineProbe,
  RTL_LOCALES,
  severityCounts,
  sortFindings,
  trailingRepeats,
  type ConsoleError,
  type DownloadVerdict,
  type LocaleVerdict,
  type PrComment,
  type QaFinding,
  type TurnResult,
} from "./qa-core.js";
import { coverageFor } from "./qa-map.js";
import type { Coverage, QaMap } from "./qa-map.js";

// ---- parseQaCommand ----

test("bare /qa → scoped, no url", () => {
  const p = parseQaCommand("/qa");
  assert.equal(p.mode, "scoped");
  assert.equal(p.url, null);
});

test("/qa all → full sweep", () => {
  assert.equal(parseQaCommand("/qa all").mode, "full");
  // 'all' anywhere in the prose still triggers a full sweep.
  assert.equal(parseQaCommand("/qa please test all of it").mode, "full");
});

test("/qa <url> captures an explicit target and trims trailing punctuation", () => {
  assert.equal(parseQaCommand("/qa https://preview.example.app").url, "https://preview.example.app");
  assert.equal(parseQaCommand("/qa see https://preview.example.app.").url, "https://preview.example.app");
  // Parenthetical / quoted / bracketed prose punctuation is stripped too.
  assert.equal(parseQaCommand("/qa (https://preview.example.app)").url, "https://preview.example.app");
  assert.equal(parseQaCommand('/qa "https://preview.example.app",').url, "https://preview.example.app");
  assert.equal(parseQaCommand("/qa try https://preview.example.app!").url, "https://preview.example.app");
});

test("/qa all <url> → full sweep against an explicit url", () => {
  const p = parseQaCommand("/qa all https://x.vercel.app");
  assert.equal(p.mode, "full");
  assert.equal(p.url, "https://x.vercel.app");
});

test("only the first url token is taken", () => {
  const p = parseQaCommand("/qa https://a.app https://b.app");
  assert.equal(p.url, "https://a.app");
});

// ---- budgets ----

test("budgetFor reflects QA_CONFIG and full > scoped", () => {
  assert.equal(budgetFor("scoped"), QA_CONFIG.budgets.scoped);
  assert.equal(budgetFor("full"), QA_CONFIG.budgets.full);
  assert.ok(QA_CONFIG.budgets.full > QA_CONFIG.budgets.scoped);
});

test("navigate and go_forward are excluded so exploration is human-like", () => {
  assert.ok(QA_CONFIG.excludedFunctions.includes("navigate"));
  assert.ok(QA_CONFIG.excludedFunctions.includes("go_forward"));
});

// ---- denormalize ----

test("denormalize scales 0–999 coords to pixels", () => {
  assert.equal(denormalize(0, 1440), 0);
  assert.equal(denormalize(500, 1000), 500);
  assert.equal(denormalize(999, 900), 899); // floor((999/1000)*900)
});

// ---- isAllowedUrl ----

test("isAllowedUrl keeps the agent on the target origin", () => {
  const origin = "https://app.example.com";
  assert.equal(isAllowedUrl("https://app.example.com/coach", origin), true);
  assert.equal(isAllowedUrl("https://evil.com/phish", origin), false);
  assert.equal(isAllowedUrl("not a url", origin), false);
});

// ---- isDestructiveIntent ----

test("isDestructiveIntent flags account/data-destruction, payment, and registration intents", () => {
  for (const intent of [
    "Click the Delete account button",
    "Confirm and erase all my data",
    "Proceed to checkout and pay",
    "Place order",
    "Sign up for a new account",
    "Press the Deactivate button",
  ]) {
    assert.equal(isDestructiveIntent(intent), true, intent);
  }
});

test("isDestructiveIntent allows ordinary form/exploration intents", () => {
  for (const intent of [
    "Click the Home tab",
    "Type a workout note into the field",
    "Toggle the dark-mode setting",
    "Save the draft",
    "Search for climbing",
    undefined,
    "",
  ]) {
    assert.equal(isDestructiveIntent(intent), false, String(intent));
  }
});

// ---- affectedAreas ----

test("affectedAreas derives screen names from changed paths, sorted & unique", () => {
  const files = [
    "src/presentation/screens/coach/CoachScreen.tsx",
    "src/presentation/screens/coach/load-coach-data.ts",
    "src/presentation/screens/home/Home.tsx",
    "src/domain/coach/models.ts", // not a screen → ignored
    "README.md",
  ];
  assert.deepEqual(affectedAreas(files), ["coach", "home"]);
});

test("affectedAreas is empty when nothing maps to a screen", () => {
  assert.deepEqual(affectedAreas(["api/quote.ts", "docs/05-screens.md"]), []);
});

// ---- normalizeFinding ----

test("normalizeFinding fills defaults and clamps unknown severity to info", () => {
  const f = normalizeFinding({ title: "Button does nothing", severity: "bogus", area: "home" });
  assert.equal(f?.severity, "info");
  assert.equal(f?.area, "home");
  assert.equal(f?.description, "");
});

test("normalizeFinding accepts steps_to_reproduce or steps", () => {
  assert.equal(normalizeFinding({ title: "x", steps_to_reproduce: "click A" })?.steps, "click A");
  assert.equal(normalizeFinding({ title: "x", steps: "click B" })?.steps, "click B");
});

test("normalizeFinding returns null without a title", () => {
  assert.equal(normalizeFinding({ severity: "major" }), null);
  assert.equal(normalizeFinding(null), null);
});

// ---- dedupe / sort / counts ----

const mk = (severity: QaFinding["severity"], area: string, title: string): QaFinding => ({
  severity,
  area,
  title,
  description: "",
  steps: "",
  expected: "",
  actual: "",
});

test("dedupeFindings drops same area+title (case-insensitive), keeps first", () => {
  const out = dedupeFindings([mk("major", "home", "Crash"), mk("minor", "Home", "crash"), mk("info", "coach", "Slow")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, "major"); // first wins
});

test("sortFindings orders by severity then area then title", () => {
  const out = sortFindings([mk("info", "z", "a"), mk("critical", "b", "x"), mk("major", "a", "y")]);
  assert.deepEqual(
    out.map((f) => f.severity),
    ["critical", "major", "info"],
  );
});

test("severityCounts tallies each rung", () => {
  const c = severityCounts([mk("critical", "a", "1"), mk("info", "b", "2"), mk("info", "c", "3")]);
  assert.deepEqual(c, { critical: 1, major: 0, minor: 0, info: 2 });
});

// ---- trailingRepeats ----

test("trailingRepeats counts consecutive identical tail entries", () => {
  assert.equal(trailingRepeats([]), 0);
  assert.equal(trailingRepeats(["/a"]), 1);
  assert.equal(trailingRepeats(["/a", "/b", "/b", "/b"]), 3);
  assert.equal(trailingRepeats(["/b", "/b", "/a"]), 1); // tail differs from earlier run
});

// ---- buildTurnHint ----

test("buildTurnHint reports the url; adds recovery + stuck nudges when due", () => {
  assert.equal(
    buildTurnHint({ url: "https://x.app/home", leftApp: false, repeats: 1, stuckThreshold: 4 }),
    "url: https://x.app/home",
  );
  assert.match(
    buildTurnHint({ url: "https://x.app", leftApp: true, repeats: 1, stuckThreshold: 4 }),
    /left the app/,
  );
  assert.match(
    buildTurnHint({ url: "https://x.app", leftApp: false, repeats: 4, stuckThreshold: 4 }),
    /explored yet, or wrap up/,
  );
});

// ---- attachStateToResults ----

const tr = (name: string, text: string): TurnResult => ({ name, result: [{ type: "text", text }] });

test("attachStateToResults appends hint+image to the last non-report_finding result", () => {
  const out = attachStateToResults([tr("report_finding", "recorded"), tr("click", "ok")], "hint", "BASE64");
  // report_finding ack is untouched...
  assert.deepEqual(out[0].result, [{ type: "text", text: "recorded" }]);
  // ...the action result gets hint + image appended (not overwritten).
  assert.equal(out[1].result.length, 3);
  assert.deepEqual(out[1].result[0], { type: "text", text: "ok" });
  assert.deepEqual(out[1].result[1], { type: "text", text: "hint" });
  assert.deepEqual(out[1].result[2], { type: "image", data: "BASE64", mime_type: "image/png" });
});

test("attachStateToResults preserves the ack when only report_finding calls exist", () => {
  // The bug this guards: with no action result, the screenshot must be APPENDED
  // to a report_finding result, never replace its "recorded" ack.
  const out = attachStateToResults([tr("report_finding", "recorded")], "hint", "BASE64");
  assert.equal(out[0].result.length, 3);
  assert.deepEqual(out[0].result[0], { type: "text", text: "recorded" });
  assert.equal(out[0].result[2].type, "image");
});

test("attachStateToResults is total on empty input and non-mutating", () => {
  assert.deepEqual(attachStateToResults([], "hint", "B"), []);
  const input = [tr("click", "ok")];
  const out = attachStateToResults(input, "hint", "B");
  assert.equal(input[0].result.length, 1); // original untouched
  assert.notEqual(out[0], input[0]);
});

// ---- buildReport ----

test("buildReport shows a clean bill of health with no findings", () => {
  const body = buildReport({ mode: "scoped", targetUrl: "https://x.app", findings: [], turns: 10, marker: "<!--m-->" });
  assert.match(body, /No issues found/);
  assert.match(body, /scoped to PR changes/);
  assert.match(body, /https:\/\/x\.app/);
  assert.ok(body.trim().endsWith("<!--m-->"));
});

test("buildReport groups findings, counts by severity, and notes full sweeps", () => {
  const findings = [mk("critical", "coach", "White screen"), mk("minor", "home", "Misaligned icon")];
  const body = buildReport({
    mode: "full",
    targetUrl: "https://x.app",
    findings,
    turns: 42,
    note: "hit budget",
    marker: "<!--m-->",
  });
  assert.match(body, /full-app sweep/);
  assert.match(body, /Found \*\*2\*\* issue\(s\)/);
  assert.match(body, /🔴.*White screen/s);
  assert.match(body, /🟡.*Misaligned icon/s);
  assert.match(body, /> hit budget/); // note rendered as a blockquote
  assert.match(body, /42 step/);
});

test("buildReport dedupes before rendering", () => {
  const findings = [mk("major", "home", "Dup"), mk("major", "home", "Dup")];
  const body = buildReport({ mode: "scoped", targetUrl: "https://x.app", findings, turns: 1, marker: "<!--m-->" });
  assert.match(body, /Found \*\*1\*\* issue\(s\)/);
});

// ---- parseQaCommand — focus mode ----

test("/qa focus <domain> → focus mode with the domain", () => {
  const p = parseQaCommand("/qa focus cold-chain");
  assert.equal(p.mode, "focus");
  assert.equal(p.focus, "cold-chain");
  assert.equal(p.url, null);
});

test("/qa focus is case-insensitive and trims the domain", () => {
  assert.equal(parseQaCommand("/qa focus Cold-Chain").focus, "cold-chain");
});

test("/qa focus with no domain stays focus mode with null domain (caller rejects)", () => {
  const p = parseQaCommand("/qa focus");
  assert.equal(p.mode, "focus");
  assert.equal(p.focus, null);
});

test("bare /qa still has a null focus", () => {
  assert.equal(parseQaCommand("/qa").focus, null);
});

test("focus budget is configured", () => {
  assert.equal(QA_CONFIG.budgets.focus, 120);
});

test("buildReport surfaces the agent's wrap-up summary in a details block when present", () => {
  const withSummary = buildReport({
    mode: "scoped",
    targetUrl: "https://x.app",
    findings: [],
    turns: 5,
    summary: "Exercised onboarding, logged a session, and opened the coach.",
    marker: "<!--m-->",
  });
  assert.match(withSummary, /What the agent exercised/);
  assert.match(withSummary, /Exercised onboarding/);
  // Omitted entirely when there's no summary.
  const without = buildReport({ mode: "scoped", targetUrl: "https://x.app", findings: [], turns: 5, marker: "<!--m-->" });
  assert.doesNotMatch(without, /What the agent exercised/);
});

// ---- renderCoverage + coverage block in buildReport ----

const SAMPLE_COV: Coverage = {
  overall: { covered: 3, total: 10, pct: 30 },
  domains: [
    { key: "cold-chain", label: "Cold chain", covered: 0, total: 4, pct: 0 },
    { key: "settings", label: "Settings", covered: 3, total: 6, pct: 50 },
  ],
  outOfScopeCount: 2,
  outOfScopeRoutes: ["/modules/sensors/offer", "/modules/labels/offer"],
  coveredPaths: ["/x"],
};

test("renderCoverage shows overall %, per-domain rows and the out-of-scope note", () => {
  const md = renderCoverage(SAMPLE_COV, "full");
  assert.match(md, /Coverage/);
  assert.match(md, /3\/10 routes \(30%\)/);
  assert.match(md, /cold-chain/);
  assert.match(md, /0\/4/);
  assert.match(md, /excludes 2 out-of-scope/);
  assert.match(md, /Out of scope \(not counted\)/);
  assert.match(md, /\/modules\/sensors\/offer/);
});

test("renderCoverage flags scoped/focus runs as partial by design", () => {
  assert.match(renderCoverage(SAMPLE_COV, "focus"), /partial by design/i);
  assert.doesNotMatch(renderCoverage(SAMPLE_COV, "full"), /partial by design/i);
});

test("buildReport includes the coverage block when coverage is provided", () => {
  const body = buildReport({
    mode: "full",
    targetUrl: "https://x.app",
    findings: [],
    turns: 5,
    marker: "<!-- qa:report -->",
    coverage: SAMPLE_COV,
  });
  assert.match(body, /Coverage/);
  assert.match(body, /3\/10 routes \(30%\)/);
});

test("buildReport labels focus runs as 'focused run' not 'scoped to PR changes'", () => {
  const body = buildReport({
    mode: "focus",
    targetUrl: "https://x.app",
    findings: [],
    turns: 5,
    marker: "<!-- qa:report -->",
  });
  assert.match(body, /focused run/);
  assert.doesNotMatch(body, /scoped to PR changes/);
});

// ---- classifyDownload ----

test("classifyDownload grades a non-empty PDF as ok", () => {
  const v = classifyDownload({ filename: "haccp-report.pdf", sizeBytes: 12000 });
  assert.equal(v.kind, "pdf");
  assert.equal(v.ok, true);
});

test("classifyDownload grades a CSV and a ZIP by extension", () => {
  assert.equal(classifyDownload({ filename: "export.csv", sizeBytes: 50 }).kind, "csv");
  assert.equal(classifyDownload({ filename: "haccp-export.zip", sizeBytes: 99 }).kind, "zip");
});

test("classifyDownload fails an empty file", () => {
  const v = classifyDownload({ filename: "report.pdf", sizeBytes: 0 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /empty/i);
});

test("classifyDownload fails an unknown extension", () => {
  const v = classifyDownload({ filename: "mystery.bin", sizeBytes: 10 });
  assert.equal(v.kind, "unknown");
  assert.equal(v.ok, false);
});

test("classifyDownload normalises an uppercase extension", () => {
  const v = classifyDownload({ filename: "REPORT.PDF", sizeBytes: 1 });
  assert.equal(v.kind, "pdf");
  assert.equal(v.ok, true);
});

test("downloadFinding returns a major finding for a bad download, null for a good one", () => {
  assert.equal(downloadFinding(classifyDownload({ filename: "a.pdf", sizeBytes: 100 })), null);
  const f = downloadFinding(classifyDownload({ filename: "a.pdf", sizeBytes: 0 }));
  assert.equal(f?.severity, "major");
  assert.equal(f?.area, "exports");
  assert.match(f?.title ?? "", /a\.pdf/);
});

test("renderDownloads summarises verified and failed downloads; empty for none", () => {
  assert.equal(renderDownloads([]), "");
  const md = renderDownloads([
    classifyDownload({ filename: "ok.pdf", sizeBytes: 2048 }),
    classifyDownload({ filename: "bad.pdf", sizeBytes: 0 }),
  ]);
  assert.match(md, /Export downloads/);
  assert.match(md, /1 verified/);
  assert.match(md, /1 failed/);
  assert.match(md, /ok\.pdf/);
});

test("buildReport includes the downloads section when downloads are provided", () => {
  const body = buildReport({
    mode: "full",
    targetUrl: "https://x.app",
    findings: [],
    turns: 3,
    marker: "<!-- qa:report -->",
    downloads: [classifyDownload({ filename: "r.csv", sizeBytes: 500 })],
  });
  assert.match(body, /Export downloads/);
  assert.match(body, /r\.csv/);
});

// ---- viewport parsing & config (Phase 3 Task 1) ----

test("/qa mobile → mobile viewport, scoped mode", () => {
  const p = parseQaCommand("/qa mobile");
  assert.equal(p.viewport, "mobile");
  assert.equal(p.mode, "scoped");
});

test("mobile combines with all and focus", () => {
  assert.equal(parseQaCommand("/qa all mobile").viewport, "mobile");
  assert.equal(parseQaCommand("/qa all mobile").mode, "full");
  const f = parseQaCommand("/qa focus cold-chain mobile");
  assert.equal(f.viewport, "mobile");
  assert.equal(f.mode, "focus");
  assert.equal(f.focus, "cold-chain");
});

test("default viewport is desktop", () => {
  assert.equal(parseQaCommand("/qa").viewport, "desktop");
  assert.equal(parseQaCommand("/qa all").viewport, "desktop");
});

test("viewports are configured (desktop 1440x900, mobile 390x844)", () => {
  assert.deepEqual(QA_CONFIG.viewports.desktop, { width: 1440, height: 900 });
  assert.deepEqual(QA_CONFIG.viewports.mobile, { width: 390, height: 844 });
});

test("buildReport shows the viewport in the metrics line when provided", () => {
  const body = buildReport({
    mode: "full",
    targetUrl: "https://x.app",
    findings: [],
    turns: 2,
    marker: "<!-- qa:report -->",
    viewport: "mobile",
    metrics: { steps: 2, budget: 160, inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000 },
  });
  assert.match(body, /mobile/);
});

// ---- i18n sweep (Phase 3 Task 1) ----

test("/qa i18n → i18n mode", () => {
  assert.equal(parseQaCommand("/qa i18n").mode, "i18n");
});

test("localeRootUrl builds a same-origin locale path", () => {
  assert.equal(localeRootUrl("https://x.app", "ar"), "https://x.app/ar");
  assert.equal(localeRootUrl("https://x.app/", "fr"), "https://x.app/fr");
});

test("classifyLocale passes a clean LTR locale", () => {
  const v = classifyLocale({ locale: "fr", loaded: true, htmlLang: "fr", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(v.ok, true);
  assert.equal(v.issues.length, 0);
});

test("classifyLocale flags Arabic that is not RTL", () => {
  const v = classifyLocale({ locale: "ar", loaded: true, htmlLang: "ar", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(v.ok, false);
  assert.match(v.issues.join(" "), /rtl/i);
});

test("classifyLocale accepts Arabic that is RTL", () => {
  assert.equal(classifyLocale({ locale: "ar", loaded: true, htmlLang: "ar", dir: "rtl", horizontalOverflowPx: 0, rawKeyHits: [] }).ok, true);
});

test("classifyLocale flags overflow, untranslated keys, and load failure", () => {
  assert.match(classifyLocale({ locale: "de", loaded: true, htmlLang: "de", dir: "ltr", horizontalOverflowPx: 40, rawKeyHits: [] }).issues.join(" "), /overflow/i);
  assert.match(classifyLocale({ locale: "en", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: ["module-label-cooling"] }).issues.join(" "), /untranslated|key/i);
  const nf = classifyLocale({ locale: "pl", loaded: false, htmlLang: null, dir: null, horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(nf.ok, false);
  assert.match(nf.issues.join(" "), /load/i);
  assert.equal(nf.issues.length, 1); // a not-loaded page stacks no other issues
});

test("classifyLocale detects locale redirect when htmlLang base differs from locale", () => {
  // fr locale but page rendered in English — a redirect occurred
  const v = classifyLocale({ locale: "fr", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => /rendered as/i.test(i)));
});

test("classifyLocale accepts htmlLang with region subtag matching base locale", () => {
  // fr-FR base is "fr" === locale "fr" → no redirect issue
  const v = classifyLocale({ locale: "fr", loaded: true, htmlLang: "fr-FR", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(v.ok, true);
});

test("classifyLocale does not emit redirect issue when htmlLang is null", () => {
  const v = classifyLocale({ locale: "de", loaded: true, htmlLang: null, dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.ok(!v.issues.some((i) => /rendered as/i.test(i)));
});

test("localeFindings treats locale-redirect as major severity", () => {
  const v = classifyLocale({ locale: "fr", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  const fs = localeFindings(v);
  assert.ok(fs.length > 0);
  const redirectFinding = fs.find((f) => /rendered as/i.test(f.title));
  assert.ok(redirectFinding, "expected a finding matching /rendered as/i");
  assert.equal(redirectFinding!.severity, "major");
});

test("localeFindings returns a finding per issue, none when ok", () => {
  assert.deepEqual(localeFindings({ locale: "fr", ok: true, issues: [] }), []);
  const fs = localeFindings({ locale: "ar", ok: false, issues: ["expected RTL direction, got ltr"] });
  assert.equal(fs.length, 1);
  assert.equal(fs[0].area, "i18n/ar");
  assert.equal(fs[0].severity, "major"); // wrong RTL is a major
  // Load failures are major too...
  const lf = localeFindings({ locale: "pl", ok: false, issues: ["locale page failed to load"] });
  assert.equal(lf[0].severity, "major");
  // ...while overflow (and untranslated keys) are minor.
  const ov = localeFindings({ locale: "de", ok: false, issues: ["horizontal overflow (40px) — content clipped or layout broken"] });
  assert.equal(ov[0].severity, "minor");
});

test("renderI18nSweep summarises locales; empty for none", () => {
  assert.equal(renderI18nSweep([]), "");
  const md = renderI18nSweep([
    { locale: "fr", ok: true, issues: [] },
    { locale: "ar", ok: false, issues: ["expected RTL direction, got ltr"] },
  ]);
  assert.match(md, /Localisation|i18n/i);
  assert.match(md, /ar/);
  assert.match(md, /1 ok/);
});

test("buildReport includes the i18n section when provided", () => {
  const body = buildReport({
    mode: "i18n", targetUrl: "https://x.app", findings: [], turns: 0,
    marker: "<!-- qa:report -->",
    i18n: [{ locale: "ar", ok: false, issues: ["expected RTL direction, got ltr"] }],
  });
  assert.match(body, /i18n|Localisation/i);
});

test("buildReport labels an i18n run", () => {
  const body = buildReport({ mode: "i18n", targetUrl: "https://x.app", findings: [], turns: 0, marker: "<!-- qa:report -->" });
  assert.match(body, /i18n sweep/);
});

// ---- offline mode (Task 1) ----

test("/qa offline → offline mode", () => {
  assert.equal(parseQaCommand("/qa offline").mode, "offline");
});

test("looksLikePinScreen matches the /pin route", () => {
  assert.equal(looksLikePinScreen("https://x.app/en/pin"), true);
  assert.equal(looksLikePinScreen("https://x.app/fr/pin?x=1"), true);
  assert.equal(looksLikePinScreen("https://x.app/en/home"), false);
  assert.equal(looksLikePinScreen("https://x.app/en/pinned"), false);
});

test("offlineWindowFor splits the budget ~30/70", () => {
  const w = offlineWindowFor(50);
  assert.equal(w.start, 15);
  assert.equal(w.end, 35);
  assert.ok(w.start < w.end);
});

test("offlineFindings flags only uncaught errors during offline/resync", () => {
  const errors = [
    { phase: "online", kind: "pageerror", text: "ignored — happened online" },
    { phase: "offline", kind: "console", text: "noisy console, ignored" },
    { phase: "offline", kind: "pageerror", text: "TypeError: cannot read x offline" },
    { phase: "resync", kind: "pageerror", text: "DataStore sync failed" },
  ] as const;
  const fs = offlineFindings([...errors]);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].severity, "major");
  assert.equal(fs[0].area, "offline");
  assert.match(fs.map((f) => f.title).join(" "), /offline|resync/i);
});

test("offlineFindings: two distinct offline errors get distinct titles (survive dedupe)", () => {
  const errors: ConsoleError[] = [
    { phase: "offline", kind: "pageerror", text: "TypeError: cannot read property x of undefined" },
    { phase: "offline", kind: "pageerror", text: "ReferenceError: db is not defined" },
  ];
  const fs = offlineFindings(errors);
  assert.equal(fs.length, 2);
  // Titles must differ so dedupeFindings keeps both
  assert.notEqual(fs[0].title, fs[1].title);
  // Each title contains a snippet of the error text
  assert.match(fs[0].title, /TypeError/);
  assert.match(fs[1].title, /ReferenceError/);
});

test("renderOfflineProbe summarises; mentions offline turn count", () => {
  const md = renderOfflineProbe([{ phase: "offline", kind: "pageerror", text: "x" }], 20);
  assert.match(md, /offline/i);
  assert.match(md, /20/);
});

test("renderOfflineProbe with offlineTurns=0 says did not run and not Explored ~0", () => {
  const md = renderOfflineProbe([], 0);
  assert.match(md, /did not run|never cut|did not test/i);
  assert.doesNotMatch(md, /Explored ~0/);
});

test("buildReport labels an offline run", () => {
  const body = buildReport({ mode: "offline", targetUrl: "https://x.app", findings: [], turns: 0, marker: "<!-- qa:report -->" });
  assert.match(body, /offline probe/);
});

// ---- affectedAreas — backresto src/pages routes ----

test("affectedAreas derives areas from backresto src/pages routes", () => {
  assert.deepEqual(
    affectedAreas([
      "src/pages/[locale]/modules/cooling/index.tsx",
      "src/pages/[locale]/preparations/list.tsx",
      "src/pages/[locale]/settings/advanced/multi-site.tsx",
      "src/components/common/Foo.tsx", // not a page → ignored
    ]).sort(),
    ["cooling", "preparations", "settings"],
  );
});

test("affectedAreas dedupes and ignores non-page files", () => {
  assert.deepEqual(affectedAreas(["src/utils/x.ts", "README.md"]), []);
  assert.deepEqual(
    affectedAreas(["src/pages/[locale]/modules/cooling/index.tsx", "src/pages/[locale]/modules/cooling/settings/index.tsx"]),
    ["cooling"],
  );
});

// ---- buildPrContext ----

test("buildPrContext includes title, truncated body, and reviewer comments", () => {
  const md = buildPrContext({
    title: "Add cooling batch timer",
    body: "Adds a countdown to the cooling module.",
    comments: [
      { author: "alice", body: "Please check the timer resets on navigation." },
      { author: "qa-bot", body: "## QA exploration\n<!-- qa:report -->" }, // excluded (self)
    ],
  });
  assert.match(md, /Add cooling batch timer/);
  assert.match(md, /countdown to the cooling module/);
  assert.match(md, /timer resets on navigation/);
  assert.doesNotMatch(md, /QA exploration/); // qa: self-comment excluded
});

test("buildPrContext returns empty string when there's nothing useful", () => {
  assert.equal(buildPrContext({ title: "", body: null, comments: [] }), "");
});

test("buildPrContext truncates a very long body", () => {
  const md = buildPrContext({ title: "T", body: "x".repeat(5000), comments: [] }, { maxBodyChars: 100 });
  assert.ok(md.length < 600);
  assert.match(md, /…/);
});

// ---- i18n interpolation leaks ----

test("classifyLocale flags interpolation leaks as not ok with a matching issue", () => {
  const v = classifyLocale({ locale: "en", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [], interpolationLeaks: ["{{count}}"] });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => /interpolation|placeholder/i.test(i)));
});

test("localeFindings grades interpolation leak as major severity", () => {
  const v = classifyLocale({ locale: "en", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [], interpolationLeaks: ["{{count}}"] });
  const fs = localeFindings(v);
  assert.ok(fs.length > 0);
  const leakFinding = fs.find((f) => /interpolation|placeholder/i.test(f.title));
  assert.ok(leakFinding, "expected a finding matching /interpolation|placeholder/i");
  assert.equal(leakFinding!.severity, "major");
});

test("classifyLocale with empty or absent interpolationLeaks adds no interpolation issue", () => {
  const withEmpty = classifyLocale({ locale: "en", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [], interpolationLeaks: [] });
  assert.equal(withEmpty.ok, true);
  assert.ok(!withEmpty.issues.some((i) => /interpolation|placeholder/i.test(i)));
  // omitted field (existing observations without the field)
  const omitted = classifyLocale({ locale: "en", loaded: true, htmlLang: "en", dir: "ltr", horizontalOverflowPx: 0, rawKeyHits: [] });
  assert.equal(omitted.ok, true);
  assert.ok(!omitted.issues.some((i) => /interpolation|placeholder/i.test(i)));
});

// ---- domainStatus — failed shard in coverage table ----

test("buildReport marks a failed domain shard in the coverage table", () => {
  // Inline fixture — no consumer bible needed; exercises the shard-status rendering path.
  const FIXTURE_MAP: QaMap = {
    locales: ["en"],
    routes: [
      { path: "/a", section: "a", module: null, domain: "d1", preconditions: [] },
      { path: "/b", section: "b", module: null, domain: "d2", preconditions: [] },
    ],
    domains: [
      { key: "d1", label: "D1", routes: ["/a"], preconditions: [] },
      { key: "d2", label: "D2", routes: ["/b"], preconditions: [] },
    ],
    outOfScope: [],
    enabledModules: [],
  };
  const body = buildReport({
    mode: "full", targetUrl: "https://x.app", findings: [], turns: 0, marker: "<!-- qa:report -->",
    coverage: coverageFor(FIXTURE_MAP, []),
    domainStatus: [{ domain: "d1", ok: false, reason: "shard timed out" }],
  });
  assert.match(body, /shard timed out/);
  assert.match(body, /✗/);
});
