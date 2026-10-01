# FieldMind Research

FieldMind Research is a research-preparation workspace for KoboToolbox questionnaires and evidence-grounded synthetic QA fixtures.

## Architecture

React/Vite frontend -> Vercel Function -> Supabase/Postgres.

Kobo inspection first resolves the deployed XForm through Kobo's v2 API when an Asset UID/project URL is available, then falls back to the public form and structured extraction. AI runs stay server-side.

## Synthetic-data boundary

Generated records are **synthetic QA fixtures only**, explicitly marked synthetic and kept behind human review. The final action prepares a controlled QA package and does **not** submit records to live Kobo.

## Vercel environment variables

- SUPABASE_URL
- SUPABASE_SECRET_KEY (preferred current Supabase server secret) or SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY
- OPENAI_MODEL (optional)
- KOBO_API_TOKEN (optional, for private Kobo forms)

Never commit real keys.

## Supabase setup

Run supabase/schema.sql once in the Supabase SQL Editor. The table is protected by RLS and the browser never receives the server key.

## Kobo

For exact questionnaire mapping, the UI accepts a Kobo project URL or Asset UID. A temporary Kobo API key can also be supplied for private forms; it is sent only for that inspection request and is not persisted.

## Development

npm install
npm run dev


## Accounts and workspace isolation

FieldMind now uses Supabase Auth with email/password sign-in. Each research project, evidence source and synthetic QA draft is owned by the authenticated account. The configured administrator is `victormurimiofficial@gmail.com`; the admin can see all workspaces and has the workspace reset control. Other users can only access records owned by their account.

Sessions are kept server-side in secure cookies. Do not expose the Supabase secret key in browser code.

## AI quota fallback

The research QA compiler treats OpenAI as an optional reasoning provider. When OpenAI returns a quota/credit error, FieldMind automatically switches to a deterministic local synthetic QA compiler so questionnaire mapping, fixture generation, review and export can continue. This is not a way to bypass OpenAI billing: it deliberately avoids the paid model call and produces clearly labelled synthetic QA fixtures using the Kobo form definition. When AI credits are available, the OpenAI brain remains available.

## Resetting the previous workspace

Sign in as the configured admin and use **Reset old workspace** once. It permanently clears the existing FieldMind project/source/draft records so the new multi-user workspace starts clean.
