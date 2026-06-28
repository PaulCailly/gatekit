import type { QaConfig } from "./route-extract.js";

/**
 * Return a copy of the parsed gatekit.json with its `qa` block's routing +
 * strategy params replaced by `resolved`, preserving non-strategy keys
 * (bibleModel, docsForBible, localesDir, modulePrefix, enabled, mode, …).
 */
export function mergeQaConfig(
  gatekitJson: Record<string, unknown>,
  resolved: QaConfig,
): Record<string, unknown> {
  const prevQa = (gatekitJson.qa as Record<string, unknown>) ?? {};
  // Drop strategy-specific keys so a stale pagesDir/glob/etc. does not linger.
  const {
    routing: _r,
    pagesDir: _p,
    appDir: _a,
    glob: _g,
    routerFiles: _rf,
    pathPattern: _pp,
    exclude: _e,
    ...keep
  } = prevQa as Record<string, unknown>;
  void _r; void _p; void _a; void _g; void _rf; void _pp; void _e;
  return { ...gatekitJson, qa: { ...keep, ...resolved } };
}
