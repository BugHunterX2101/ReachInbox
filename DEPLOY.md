# Deployment

## What deploys where

| Piece | Host | Why |
|---|---|---|
| `apps/web` (Next.js dashboard) | **Vercel** | Made for it — rewrites proxy `/api/*` and `/admin/*` to the API URL |
| `apps/api` (Express REST API) | **Vercel** (serverless) or any Node host | `api/index.js` entry included; long-running hosts (Render/Railway/Fly/your VPS) are simpler for websockets-style features like Bull Board |
| BullMQ **send worker** (`apps/worker`) | **Any always-on Node host** (Render worker/Railway/Fly/VPS) | Background workers are long-lived processes; they must NOT run on serverless |
| Postgres / Redis / Elasticsearch | **Managed services** (Neon/Supabase, Upstash/Redis Cloud, Elastic Cloud/Bonsai) | Vercel has no durable stateful add-ons for this stack |

> **Honest constraint:** Vercel is first-class for `apps/web`, workable for
> `apps/api` (stateless HTTP — sessions live in Postgres, so serverless is safe),
> and wrong for `apps/worker`. The engine's guarantees (restart reconciliation,
> deferral, lease reclamation) assume a long-lived worker. Free tiers of
> Render/Railway/Fly all fit.

## 1. Managed data stores

Provision Postgres, Redis, and Elasticsearch (any providers), then collect:

```
DATABASE_URL=postgres://…        # e.g. Neon/Supabase
REDIS_URL=redis://…              # e.g. Upstash (use rediss:// for TLS)
ELASTICSEARCH_URL=https://…      # e.g. Elastic Cloud / Bonsai
```

## 2. OAuth apps (fixes `Error 400: redirect_uri_mismatch`)

**Google Cloud Console → APIs & Services → Credentials** → your OAuth client:

1. **Authorized JavaScript origins**: your Vercel web URL(s), e.g.
   `https://reachinbox.vercel.app` (and `http://localhost:3000` for local dev).
2. **Authorized redirect URIs** — add ALL of these that apply, exactly:
   - `https://<your-web>.vercel.app/api/auth/google/callback` (dashboard via proxy)
   - `https://<your-api>.vercel.app/api/auth/google/callback` (only if you also deploy the API to Vercel and will browse it directly)
   - `http://localhost:3000/api/auth/google/callback` + `http://localhost:3001/api/auth/google/callback` (local dev)

   After deploy, `GET /api/health` returns `googleRedirectUris` — the exact list
   the running deployment expects. What Google receives is derived from the
   browsing origin (or `GOOGLE_REDIRECT_URI` if set), so a mismatch is always
   visible there.

**Slack app settings** → OAuth & Permissions → Redirect URLs:
`https://<host>/api/integrations/slack/callback` (same origin rule).

## 3. Vercel — web + api

```bash
npm i -g vercel
vercel login

# Dashboard
cd apps/web
vercel link
vercel env add API_INTERNAL_URL        # e.g. https://reachinbox-api.vercel.app
vercel env add NEXT_PUBLIC_API_URL     # same value, for the browser
vercel env add WEB_URL                 # e.g. https://reachinbox.vercel.app
vercel --prod

# API
cd apps/api
vercel link
vercel env add DATABASE_URL
vercel env add REDIS_URL
vercel env add ELASTICSEARCH_URL
vercel env add SESSION_SECRET          # 32+ random chars
vercel env add ENCRYPTION_KEY          # 64 hex chars (openssl rand -hex 32)
vercel env add GOOGLE_CLIENT_ID
vercel env add GOOGLE_CLIENT_SECRET
vercel env add WEB_URL                 # the Vercel web URL (OAuth redirect target)
# Optional — leave unset to auto-derive per-origin:
# vercel env add GOOGLE_REDIRECT_URI
# vercel env add SLACK_CLIENT_ID / SLACK_CLIENT_SECRET
vercel --prod
```

`apps/api/index.js` is the serverless entry (wraps `dist/app.js`). Sessions are
server-side in Postgres, so serverless instances stay stateless and safe.

## 4. Worker — one always-on host

```bash
# On Render/Railway/Fly/VPS with Node 20+:
git clone https://github.com/BugHunterX2101/ReachInbox && cd ReachInbox
corepack enable && pnpm install && pnpm -r build
# Env: DATABASE_URL, REDIS_URL, ELASTICSEARCH_URL, ENCRYPTION_KEY, SESSION_SECRET,
#      QUEUE_PREFIX (use a DIFFERENT prefix from local dev!), WORKER_CONCURRENCY…
node apps/worker/dist/index.js
```

The worker runs the boot reconciler on start (FR-9/10/11), so even after long
downtime it resumes exactly where Postgres says things left off.

## 5. Migrate + seed (run once, from anywhere with access to the stores)

```bash
pnpm db:migrate && pnpm db:seed && pnpm db:seed:ethereal && pnpm db:verify:senders
```

## 6. Verify

1. `GET <api>/api/health` → `ok:true` and the expected `googleRedirectUris`.
2. Open the web app → **Login with Google** → consent → dashboard.
3. Compose a 2-recipient batch → watch it deliver, then check **Bull Board**
   (`/admin/queues`) and the **Sent** view.
