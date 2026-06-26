# QA memory

A living knowledge base the `/qa` agent reads at the start of every run and
rewrites at the end (see `lib/qa-memory.ts`). It accumulates what past
exploratory runs learned so each run starts smarter. Keep it concise — the run's
synthesis step merges and dedupes, aiming under ~250 lines.

## 🗺️ Map / paths explored

- **Login page** — landing/unauthenticated entry point. Contains Email Address and Password fields. Currently blocked by a critical bug (see Known issues).

## ⚠️ Gotchas & quirks

- Login page Email Address input is non-functional — clicking it navigates to `about:blank` (white screen). Browser "back" does not reliably return. Workaround: none found yet; may need direct URL navigation or devtools intervention to get past login.

## 🐞 Known issues

- [ ] **CRITICAL — Login Email Address field click redirects to `about:blank`** — clicking the input navigates away to a blank page; back button ineffective. Blocks all further exploration. (last seen 2026-06-25)

## 💡 Exploration tips

- The app could not be explored beyond the login page due to the critical `about:blank` redirect bug.
- Next run: try navigating directly to authenticated routes via URL (e.g. `/dashboard`, `/settings`) to bypass login, or inspect the Email Address input's event handlers in devtools to understand the redirect trigger.
- Areas still unexplored: everything past login — settings, dashboard, and all authenticated screens.
- Consider checking if the bug is environment-specific (Vercel preview URL) vs. reproducible locally.