/**
 * Playwright execution of the browser computer-use actions Gemini emits. Each
 * action's normalised (0–999) coordinates are scaled to the real viewport, then
 * carried out with the same primitives a person has — mouse, keyboard, scroll —
 * never page scripts or dev tools. `captureState` takes the screenshot fed back
 * to the model each turn.
 */
import type { Page } from "playwright";

import { denormalize, isDestructiveIntent, QA_CONFIG } from "./qa-core.js";
import type { FunctionCall } from "./gemini.js";

const { width, height } = QA_CONFIG.screen;

/** Actions that can actuate / submit and so could trigger an irreversible flow.
 *  These are gated by the destructive-intent deny-list; passive actions (move,
 *  scroll, screenshot, go_back, wait) are never blocked. */
const ACTUATING_ACTIONS = new Set([
  "click",
  "double_click",
  "triple_click",
  "middle_click",
  "right_click",
  "mouse_down",
  "mouse_up",
  "type",
  "press_key",
  "hotkey",
  "drag_and_drop",
]);

function xy(args: Record<string, unknown>): { x: number; y: number } {
  return {
    x: denormalize(Number(args.x ?? 0), width),
    y: denormalize(Number(args.y ?? 0), height),
  };
}

/** Pointer actions worth a visible pulse in the session video. */
const PULSE_ACTIONS = new Set(["click", "double_click", "triple_click", "right_click", "middle_click", "mouse_down", "type"]);

/** Drop a short-lived pulsing ripple at (x, y) so the session video shows where
 *  the agent clicked/tapped. The inserted element is real DOM, so Playwright's
 *  viewport screencast captures its CSS animation. Best-effort — never throws. */
async function pulseAt(page: Page, x: number, y: number): Promise<void> {
  await page
    .evaluate(
      ([px, py]) => {
        const STYLE_ID = "__qa_pulse_style";
        if (!document.getElementById(STYLE_ID)) {
          const s = document.createElement("style");
          s.id = STYLE_ID;
          s.textContent =
            "@keyframes __qaPulse{0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}100%{transform:translate(-50%,-50%) scale(2.4);opacity:0}}" +
            ".__qa_pulse{position:fixed;width:46px;height:46px;border-radius:50%;background:rgba(56,189,248,.45);" +
            "border:2px solid rgba(56,189,248,.95);pointer-events:none;z-index:2147483647;animation:__qaPulse .6s ease-out forwards}";
          document.head.appendChild(s);
        }
        const d = document.createElement("div");
        d.className = "__qa_pulse";
        d.style.left = px + "px";
        d.style.top = py + "px";
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 750);
      },
      [x, y],
    )
    .catch(() => {});
}

const WHEEL: Record<string, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * Execute one browser action. Returns a short status string for the function
 * result (the screenshot is attached separately by the caller). Unknown or
 * client-handled actions (e.g. take_screenshot) are no-ops — the fresh
 * screenshot the loop always sends back is the real answer.
 */
export async function executeAction(page: Page, call: FunctionCall): Promise<string> {
  const a = call.arguments;

  // Deny-list (defense-in-depth atop the system prompt): refuse to actuate an
  // action whose stated intent looks destructive/irreversible (delete account,
  // payment, sign-up, …). The agent is told to record it as a finding instead.
  if (ACTUATING_ACTIONS.has(call.name) && isDestructiveIntent(a.intent)) {
    return "blocked: this looks like a destructive or irreversible action (account/data deletion, payment, or registration). Skipped for safety — do not retry it; record it as a finding and continue exploring elsewhere.";
  }

  // Visual pulse at the action point for the session video (before the action, so
  // the ripple and its effect are recorded close together).
  if (PULSE_ACTIONS.has(call.name) && a.x !== undefined && a.y !== undefined) {
    await pulseAt(page, xy(a).x, xy(a).y);
  }

  switch (call.name) {
    case "click":
      await page.mouse.click(xy(a).x, xy(a).y);
      break;
    case "double_click":
      await page.mouse.dblclick(xy(a).x, xy(a).y);
      break;
    case "triple_click": {
      const { x, y } = xy(a);
      await page.mouse.click(x, y, { clickCount: 3 });
      break;
    }
    case "right_click":
      await page.mouse.click(xy(a).x, xy(a).y, { button: "right" });
      break;
    case "middle_click":
      await page.mouse.click(xy(a).x, xy(a).y, { button: "middle" });
      break;
    case "move":
      await page.mouse.move(xy(a).x, xy(a).y);
      break;
    case "mouse_down":
      await page.mouse.move(xy(a).x, xy(a).y);
      await page.mouse.down();
      break;
    case "mouse_up":
      await page.mouse.move(xy(a).x, xy(a).y);
      await page.mouse.up();
      break;
    case "type": {
      if (a.x !== undefined && a.y !== undefined) {
        const { x, y } = xy(a);
        await page.mouse.click(x, y);
      }
      // Clear an existing value the way a person would: select-all then delete.
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(a.text ?? ""));
      if (a.press_enter) await page.keyboard.press("Enter");
      break;
    }
    case "drag_and_drop": {
      const sx = denormalize(Number(a.start_x ?? 0), width);
      const sy = denormalize(Number(a.start_y ?? 0), height);
      const ex = denormalize(Number(a.end_x ?? 0), width);
      const ey = denormalize(Number(a.end_y ?? 0), height);
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey);
      await page.mouse.up();
      break;
    }
    case "scroll": {
      const { x, y } = xy(a);
      await page.mouse.move(x, y);
      const [dx, dy] = WHEEL[String(a.direction ?? "down")] ?? WHEEL.down;
      const mag = Number(a.magnitude_in_pixels ?? 300);
      await page.mouse.wheel(dx * mag, dy * mag);
      break;
    }
    case "press_key":
      await page.keyboard.press(String(a.key ?? ""));
      break;
    case "key_down":
      await page.keyboard.down(String(a.key ?? ""));
      break;
    case "key_up":
      await page.keyboard.up(String(a.key ?? ""));
      break;
    case "hotkey": {
      const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
      if (keys.length) await page.keyboard.press(keys.join("+"));
      break;
    }
    case "go_back":
      await page.goBack().catch(() => {});
      break;
    case "wait":
      await page.waitForTimeout(Math.min(Number(a.seconds ?? 1), 5) * 1000);
      break;
    case "take_screenshot":
      break; // handled by the always-on capture below
    default:
      return `unhandled action: ${call.name}`;
  }

  // Let the UI settle before the next screenshot, without hanging on slow networks.
  await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  return "ok";
}

export interface PageState {
  url: string;
  screenshotBase64: string;
}

/** Capture the current page as a base64 PNG plus its URL, for the next turn.
 *  Viewport-only (`fullPage: false`) on purpose — the model sees what a user
 *  sees, and it keeps the per-turn image payload bounded over a long sweep. */
export async function captureState(page: Page): Promise<PageState> {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return { url: page.url(), screenshotBase64: buf.toString("base64") };
}
