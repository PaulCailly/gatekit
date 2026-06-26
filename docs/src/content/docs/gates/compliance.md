---
title: Compliance Gate
description: Privacy and egress gate — un-allowlisted egress, server secrets in client, hardcoded secrets, and telemetry seam validation.
---

## What it does

The compliance gate runs on every pull request and audits the diff for four categories of privacy/security violation:

| Check | What it detects |
|-------|-----------------|
| **Un-allowlisted egress** | Network calls (`fetch`, `axios`, `http.get`, …) to hosts not present in `config.mjs` allowlist |
| **Server secret in client bundle** | References to server-only env vars (listed in `config.mjs`) inside files that may be bundled client-side |
| **Hardcoded secrets** | Patterns matching API keys, tokens, passwords (configurable via `config.mjs` `secretPatterns`) |
| **Telemetry outside seam** | Analytics/tracking calls outside the designated telemetry seam file(s) defined in `config.mjs` |

In addition, the `/compliance` bot command triggers an on-demand **LLM audit**: it sends the PR diff to an OpenRouter model which reasons about privacy risk beyond what static patterns can catch — data minimisation, lawful basis, third-party data sharing, GDPR Article 30 obligations.

## Required secret

```
OPENROUTER_API_KEY
```

Add this to your repo's Actions secrets (Settings → Secrets → Actions). The bot uses it for the `/compliance` LLM audit. The static checks run without it using only `GITHUB_TOKEN`.

## Mode semantics

| Mode | Behaviour |
|------|-----------|
| `report` | Gate always passes; violations appear as PR annotations only |
| `block` | Gate fails if any un-allowlisted egress, hardcoded secret, or server-secret-in-client is detected |

```json
{
  "features": {
    "compliance": {
      "enabled": true,
      "mode": "block"
    }
  }
}
```

## Owned config files

Two files are scaffolded and **never overwritten** by `update`:

### `compliance/config.mjs`

Defines what is allowed:

```js
export default {
  // Hosts your app is permitted to call. Each entry must justify the call.
  egressAllowlist: [
    {
      host: 'api.stripe.com',
      service: 'Stripe',
      scope: 'server',
      data: ['payment_method', 'amount'],
      lawfulBasis: 'contract',
    },
    {
      host: 'sentry.io',
      service: 'Sentry',
      scope: 'server',
      data: ['stack_trace', 'user_id'],
      lawfulBasis: 'legitimate_interest',
    },
  ],

  // Env var names that must never appear in client-side code
  serverOnlySecrets: ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'OPENROUTER_API_KEY'],

  // Regex patterns that indicate a hardcoded secret
  secretPatterns: [
    /sk_live_[A-Za-z0-9]{24}/,
    /ghp_[A-Za-z0-9]{36}/,
  ],

  // Analytics seam: vendor capture calls only permitted inside seamDir
  analytics: {
    seamDir: 'src/analytics/',
    vendorCapture: /\bposthog\.capture\s*\(/,
    forbiddenKeyFragments: ['name', 'email', 'phone', 'password'],
  },

  // Optional: structural checks (e.g. every API route must call auth())
  structuralChecks: [],
};
```

### `compliance/controls.mjs`

Documents your privacy controls for the LLM audit and compliance reports:

```js
export const controls = [
  {
    id: 'PRIV-001',
    title: 'Data minimisation',
    description: 'Only collect data necessary for the stated purpose.',
    implemented: true,
    evidence: 'See src/lib/analytics.ts — only page path and session ID collected.',
  },
];

export const standardsCovered = ['GDPR', 'ISO27001'];

export const subProcessors = [
  { name: 'Stripe', purpose: 'Payment processing', dataTypes: ['payment_method'] },
  { name: 'Sentry', purpose: 'Error monitoring', dataTypes: ['stack_trace'] },
];
```

## `/compliance` bot command

Post `/compliance` as a PR comment to trigger an on-demand LLM audit. The bot:

1. Fetches the PR diff via the GitHub API
2. Sends diff + your `controls.mjs` context to an OpenRouter model
3. Posts an audit report as a PR comment covering: privacy risk rating, GDPR considerations, data flow concerns, and recommended changes

The bot requires `OPENROUTER_API_KEY` to be set.

## Install

```bash
npx repo-harness add compliance
```
