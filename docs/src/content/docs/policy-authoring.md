---
title: Policy Authoring
description: How to fill in compliance/config.mjs and controls.mjs — egress allowlist, server secrets, telemetry seam, and controls.
---

## Overview

When you run `npx repo-harness add compliance`, two **owned** files are scaffolded into your repo:

- `compliance/config.mjs` — runtime policy: what egress is allowed, which env vars are server-only, what counts as a secret, where analytics may live
- `compliance/controls.mjs` — documentation: your privacy controls, standards covered, and sub-processors

Because these files are **owned**, `npx repo-harness update` will never touch them. Your policy stays in version control alongside your code, under your team's ownership.

---

## `compliance/config.mjs`

### Egress allowlist

Every network call your app makes should have a corresponding entry. The compliance gate flags any call to a host not listed here.

```js
egressAllowlist: [
  {
    host: 'api.stripe.com',         // exact hostname (no protocol, no path)
    service: 'Stripe',              // human-readable service name
    scope: 'payments',              // what feature uses this service
    data: ['payment_method', 'amount', 'customer_id'],  // data types sent
    lawfulBasis: 'contract',        // GDPR lawful basis
  },
  {
    host: 'sentry.io',
    service: 'Sentry',
    scope: 'error-monitoring',
    data: ['stack_trace', 'user_id', 'session_id'],
    lawfulBasis: 'legitimate_interest',
  },
  {
    host: 'fonts.googleapis.com',
    service: 'Google Fonts',
    scope: 'ui',
    data: [],                       // no personal data
    lawfulBasis: 'legitimate_interest',
  },
],
```

**Tip:** Start with an empty allowlist and run the gate in `report` mode — it will surface every external host your codebase calls. Add them one by one as you verify each is necessary.

### Server-only secrets

List every env var that must never appear in client-side code (e.g. Next.js pages/components, browser bundles):

```js
serverOnlySecrets: [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'OPENROUTER_API_KEY',
  'RESEND_API_KEY',
  'SENTRY_AUTH_TOKEN',
],
```

The gate will flag any import or reference to these variable names in files that could be bundled for the browser.

### Secret patterns

Regex patterns that indicate a hardcoded credential:

```js
secretPatterns: [
  /sk_live_[A-Za-z0-9]{24}/,       // Stripe live secret key
  /ghp_[A-Za-z0-9]{36}/,           // GitHub personal access token
  /AKIA[0-9A-Z]{16}/,              // AWS access key ID
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,  // JWT (broad — tune as needed)
],
```

Keep these patterns narrow to minimise false positives. The default scaffold includes common patterns; add your own for service-specific formats.

### Analytics seam

Specify the file(s) that are the **only** permitted location for analytics/tracking calls. Any tracking call found outside these files is flagged:

```js
analyticsSeam: [
  'src/lib/analytics.ts',
  'src/lib/posthog.ts',
],
```

This enforces a clean architecture: tracking is centralised, not scattered across components.

### Structural checks

Optional: define structural invariants that every file matching a pattern must satisfy:

```js
structuralChecks: [
  {
    // Every API route must call the auth() function
    filePattern: 'src/app/api/**/*.ts',
    mustCall: 'auth',
    message: 'API routes must call auth() to validate the session.',
  },
],
```

---

## `controls.mjs`

This file documents your privacy controls for compliance reports and for the `/compliance` LLM audit. It does not affect static checks — it provides context to the auditor.

### `controls` array

Each entry maps to a privacy control your team has implemented:

```js
export const controls = [
  {
    id: 'PRIV-001',
    title: 'Data minimisation',
    description: 'Only collect data necessary for the stated purpose.',
    implemented: true,
    evidence: 'analyticsSeam enforces tracking is centralised; only page path and anonymous session ID are collected.',
  },
  {
    id: 'PRIV-002',
    title: 'Right to erasure',
    description: 'Users can request deletion of their personal data.',
    implemented: true,
    evidence: 'DELETE /api/users/me removes all rows in users, sessions, and events tables.',
  },
  {
    id: 'PRIV-003',
    title: 'Data breach notification',
    description: 'Breaches reported to supervisory authority within 72 hours.',
    implemented: false,
    evidence: 'Runbook exists at docs/runbooks/breach-response.md; process not yet tested.',
  },
];
```

### `standardsCovered`

Which privacy/security standards your controls map to:

```js
export const standardsCovered = ['GDPR', 'ISO27001', 'SOC2-Type-II'];
```

### `subProcessors`

Third parties that process personal data on your behalf:

```js
export const subProcessors = [
  {
    name: 'Stripe',
    purpose: 'Payment processing',
    dataTypes: ['payment_method', 'billing_address'],
    region: 'US/EU',
    dpa: 'https://stripe.com/legal/dpa',
  },
  {
    name: 'Sentry',
    purpose: 'Error monitoring',
    dataTypes: ['stack_trace', 'user_id'],
    region: 'US',
    dpa: 'https://sentry.io/legal/dpa/',
  },
  {
    name: 'Vercel',
    purpose: 'Hosting and edge functions',
    dataTypes: ['ip_address', 'request_logs'],
    region: 'US/EU',
    dpa: 'https://vercel.com/legal/dpa',
  },
];
```

---

## Worked examples (conceptual)

Two real-world repo-harness adopters illustrate how policy is shaped by the app:

**Event platform (Next.js + Prisma + Neon):** Egress allowlist covers Stripe (payments), Resend (transactional email), and PostHog (analytics). `analyticsSeam` points to `src/lib/posthog.ts`. `serverOnlySecrets` includes `DATABASE_URL` and `STRIPE_SECRET_KEY`. Controls document GDPR Article 30 record of processing and right-to-erasure implementation via a user deletion endpoint.

**Internal monitoring app (Amplify + IAM auth):** No external analytics egress (IAM-authenticated AWS endpoints are exempted as infrastructure calls). `structuralChecks` enforces that every API handler imports from `src/auth/verify-iam.ts`. Controls document that all data stays within the AWS region (eu-west-3) and reference the Amplify DPA.

The key insight: `config.mjs` reflects your app's actual dependency graph (what you call) while `controls.mjs` reflects your team's commitments (what you've promised to users and regulators). Neither file is universal — they are yours to own.
