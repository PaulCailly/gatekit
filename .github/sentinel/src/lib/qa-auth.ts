/**
 * Authenticated exploration for atlas `/qa`.
 *
 * atlas has no email/password login — auth is phone SMS-OTP, Apple, or Google.
 * Apple/Google are interactive OAuth (not automatable headless), but Supabase
 * supports **test phone numbers** with a fixed OTP code (configured in the Auth
 * dashboard): no SMS is sent and the static code verifies. So we mint a session
 * for the test number via the GoTrue OTP-verify endpoint and seed it into the
 * browser's localStorage before the agent explores. supabase-js reads
 * `sb-<project-ref>-auth-token` on init and adopts the session.
 *
 * Setup (repo secrets): QA_LOGIN_PHONE + QA_LOGIN_OTP (a Supabase test number and
 * its fixed code), and QA_SUPABASE_URL + QA_SUPABASE_ANON_KEY (same project as
 * the app's VITE_SUPABASE_URL).
 *
 * Best-effort throughout: if any secret is missing or verify fails, QA simply
 * explores the logged-out surface — login must never fail the run.
 */
import type { Page } from "playwright";

import { core } from "./gh.js";

export interface QaSession {
  /** localStorage key supabase-js reads: `sb-<project-ref>-auth-token`. */
  storageKey: string;
  /** The serialized session value supabase-js expects under that key. */
  storageValue: string;
  /** The test identity (phone), for logging only. */
  label: string;
}

/** Mint a Supabase session for the test phone number via the GoTrue SMS-OTP
 *  verify endpoint. Returns null when the QA_LOGIN_* / QA_SUPABASE_* env is absent
 *  or verify fails, so the caller explores logged-out. */
export async function mintSession(): Promise<QaSession | null> {
  const phone = process.env.QA_LOGIN_PHONE;
  const otp = process.env.QA_LOGIN_OTP;
  const url = process.env.QA_SUPABASE_URL;
  const anonKey = process.env.QA_SUPABASE_ANON_KEY;
  if (!phone || !otp || !url || !anonKey) return null;

  const base = url.replace(/\/$/, "");
  // Normalize to E.164 uniformly: strip everything but digits and re-prefix `+`,
  // so spaces/dashes are dropped whether or not the input already had a `+`.
  const e164 = `+${phone.replace(/[^\d]/g, "")}`;
  const headers = { apikey: anonKey, "Content-Type": "application/json" };
  try {
    // Request the OTP challenge. For a Supabase test number no SMS is sent and
    // the configured fixed code is accepted on verify; best-effort, so ignore
    // any failure and go straight to verify.
    await fetch(`${base}/auth/v1/otp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phone: e164, create_user: true }),
    }).catch(() => {});

    const res = await fetch(`${base}/auth/v1/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "sms", phone: e164, token: otp }),
    });
    if (!res.ok) {
      core.warning(`QA login: OTP verify failed (${res.status} ${res.statusText}); exploring logged-out.`);
      return null;
    }
    const session = (await res.json()) as Record<string, unknown>;
    if (!session.access_token) {
      core.warning("QA login: verify returned no access_token; exploring logged-out.");
      return null;
    }
    // supabase-js derives the localStorage key from the project ref (the first
    // hostname label of the Supabase URL), and stores the raw session JSON.
    const ref = new URL(url).hostname.split(".")[0];
    return { storageKey: `sb-${ref}-auth-token`, storageValue: JSON.stringify(session), label: e164 };
  } catch (err) {
    core.warning(`QA login failed (${err instanceof Error ? err.message : String(err)}); exploring logged-out.`);
    return null;
  }
}

/** Seed the session into localStorage BEFORE the app's scripts run, so supabase-js
 *  adopts it on init and the agent lands signed in. Registered before `goto`;
 *  runs on that navigation ahead of page scripts. Best-effort. */
export async function seedSession(page: Page, session: QaSession): Promise<void> {
  await page
    .addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* storage blocked — fall through to logged-out exploration */
        }
      },
      [session.storageKey, session.storageValue] as [string, string],
    )
    .catch(() => {});
}
