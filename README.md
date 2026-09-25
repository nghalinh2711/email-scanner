# Jev Gmail Cleaner

A small Next.js test app that signs into Gmail, classifies recent inbox mail with [TypeSafe Jev](https://vercel.com/ai-gateway/models/jev) via the Vercel AI Gateway + AI SDK `experimental_evaluate`, and lets you approve label / archive / mark-read / trash actions.

Nothing is changed in Gmail until you click **Apply to selected**.

## Prerequisites

- Node.js 20+
- A Google Cloud project with the Gmail API enabled
- A [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) API key

## Google Cloud setup

1. Create (or open) a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Gmail API**.
3. Configure the **OAuth consent screen**:
   - User type: External
   - Publishing status: **Testing**
   - Add your Google account under **Test users**
4. Create credentials → **OAuth client ID** → Application type **Web application**
   - Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
5. Copy the client ID and client secret.

## Environment

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Purpose |
| --- | --- |
| `AUTH_SECRET` | Random secret (`npx auth secret` or `openssl rand -base64 32`) |
| `AUTH_GOOGLE_ID` | Google OAuth client ID |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key |
| `JEV_MODEL` | Optional. Default `typesafe-ai/jev`. Try `typesafe-ai/jev-latest` if needed. |

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, and click **Scan uncategorized**. The scan lists inbox mail that does not already have a `Jev/…` label, then classifies it in waves of 120. Gmail allows 6,000 quota units per minute and each full message costs 20, so a mailbox of about 3,000 takes roughly 30 minutes. A full minute passes between waves, and a quota error waits that minute out instead of stopping the scan. Stop and resume whenever you want; already labeled mail is skipped.

### What the scan does

1. Loads the newest N inbox messages from Gmail.
2. For each message, calls Jev once with atomic questions: category, importance, needs reply, time-sensitive, written-by-person.
3. Maps answers to suggested actions in code (`src/lib/decide.ts`).
4. Shows results in a table. Expand a subject to inspect raw Jev probabilities.

Toggle action chips, select rows, and click **Apply to selected**. Trash is recoverable from Gmail trash for 30 days.

## Jev spike (optional)

Confirms which Gateway model ID works and prints answer + `providerMetadata` shape:

```bash
AI_GATEWAY_API_KEY=... npm run spike:jev
# or
JEV_MODEL=typesafe-ai/jev-latest AI_GATEWAY_API_KEY=... npm run spike:jev
```

## Tests

```bash
npm test
```

Unit tests cover the pure decision rules only.

## Tuning

Thresholds live in `THRESHOLDS` inside [`src/lib/decide.ts`](src/lib/decide.ts). After scanning real mail, adjust confidence floors and probability cutoffs there.

## Out of scope

Database, background sync, auto-apply, unsubscribe handling, token refresh (sign in again after ~1 hour), multiple accounts, and production deployment.
