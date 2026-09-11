# Deployment — Render (free tier)

The whole product deploys to **Render's free tier** with zero code changes:

| Piece | Render service | Why this fits |
|---|---|---|
| `apps/api` + **all BullMQ workers** | 1 × free **web service** (`WORKER_INPROCESS=true`) | The engine's guarantees (boot reconciliation, lease reclamation, deferral) need a **long-lived process** — exactly what a Render web service is. Workers run in-process via the same `startWorkers()` the standalone worker uses — no duplicated logic. |
| `apps/web` (Next.js dashboard) | 1 × free **web service** | `next start` + the `/api` + `/admin` rewrites proxy to the API — browser talks to one origin, cookies stay first-party. |
| Postgres | free **database** | Connection string auto-injected as `DATABASE_URL`. |
| Redis | free **Key Value** instance | BullMQ + rate-limit counters + sessions' store backend (sessions persist in PG). |
| Elasticsearch | **none (optional)** | No free managed ES exists. `packages/search` owns availability: unset `ELASTICSEARCH_URL` → index writes are no-ops and **search falls back to Postgres (§7.3)**. Set it anytime to enable ES with zero code changes. |

Free-tier notes: web services spin down after ~15 min idle (first request wakes
in ~50 s — schedule sends run while the service is awake; the reconciler
re-enqueues anything missed after a cold start). The free Postgres expires
after 30 days — recreate it and the preDeploy command re-migrates and re-seeds.

## 1. One-click-ish: Blueprint

1. Push this repo to GitHub (done: `github.com/BugHunterX2101/ReachInbox`).
2. Render Dashboard → **New → Blueprint** → select the repo → Render reads
   `render.yaml` (databases + both services + wiring).
3. Fill the `sync: false` env vars when prompted:
- `DATABASE_URL` — external Neon Postgres (no 30-day expiry). The `stores`
  phase provisions only the Render Key Value; Postgres is never Render-managed.
- `ENCRYPTION_KEY` — `openssl rand -hex 32` — **must match** the key that
  encrypted the sender passwords already in the Neon DB
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
   - `WEB_URL` — the **web** service URL, e.g. `https://reachinbox-web.onrender.com`
   - `API_INTERNAL_URL` + `NEXT_PUBLIC_API_URL` (web service) — the **API**
     service URL, e.g. `https://reachinbox-api.onrender.com`
   - `ELASTICSEARCH_URL` — leave empty (PG fallback) or point at a host
   - `GOOGLE_REDIRECT_URI` — leave empty (auto-derived per origin)

Every deploy then runs `predeploy.sh`: idempotent schema migration, tenant +
sender seeding, and best-effort Ethereal SMTP provisioning (cached in
`.ethereal-accounts.json`, which is deliberately not committed).

## 2. Google OAuth — fixing `Error 400: redirect_uri_mismatch`

Google rejects the sign-in unless the `redirect_uri` the app sends matches a
URI registered on the OAuth client **exactly** (scheme, host, port, path).

After the first deploy, open `https://<api>.onrender.com/api/health` — it
returns `googleRedirectUris`, the exact list the running deployment expects.
Add **all** of these in **Google Cloud Console → APIs & Services → Credentials
→ your OAuth client → Authorized redirect URIs**:

```
https://<web>.onrender.com/api/auth/google/callback
https://<api>.onrender.com/api/auth/google/callback
http://localhost:3000/api/auth/google/callback        (local dashboard)
http://localhost:3001/api/auth/google/callback        (local API direct)
```

Also add **Authorized JavaScript origins**: both `https://<web>.onrender.com`
and `http://localhost:3000`.

How it works: with `GOOGLE_REDIRECT_URI` unset (recommended), the redirect URI
is derived from the origin the browser actually uses — browsing the dashboard
at `<web>` sends `<web>/api/auth/google/callback`, hitting the API directly
sends `<api>/…`. PKCE (S256) + `nonce` + session-bound state are always on.

Slack follows the same rule: **OAuth & Permissions → Redirect URLs** →
`https://<web>.onrender.com/api/integrations/slack/callback` (and local).

## 3. First-run checklist

1. `GET https://<api>.onrender.com/api/health` → `ok:true`, `googleConfigured:true`.
2. Open `https://<web>.onrender.com` → **Login with Google** → consent → dashboard.
3. Compose → 2 recipients → schedule → watch **Sent** fill up (Ethereal SMTP;
   view messages at https://ethereal.email with the seeded sender credentials —
   `pnpm db:verify:senders` prints them locally).
4. **Bull Board**: `https://<web>.onrender.com/admin/queues` (auth-gated).
5. Search: the dashboard search box queries ES when enabled, Postgres otherwise —
   identical results either way.

## 3b. Deploying via the API orchestrator

`scripts/render-deploy.mjs` drives everything (idempotent, resumable):

```sh
set -a; source .env; set +a   # provides RENDER_API_KEY + deploy secrets
node scripts/render-deploy.mjs stores    # ensure reachinbox-kv, wait ready
node scripts/render-deploy.mjs services  # ensure reachinbox-api + reachinbox-web
node scripts/render-deploy.mjs env       # fix cross-service URLs, redeploy
node scripts/render-deploy.mjs verify    # health + OAuth URIs to register
node scripts/e2e-cloud.mjs               # full end-to-end pass (needs E2E_CLOUD_API)
```

## 4. Known issue: SMTP egress from Render free instances

Render blocks outbound ports **25, 465, 587** on free web services (platform
policy). The deployment therefore seeds Ethereal senders on port **2525**
(the sanctioned alternate submission port), which delivered real mail in the
full cloud E2E on 2026-09-09.

As of 2026-09-11 `smtp.ethereal.email:2525` accepts TCP but never sends its
220 banner (reproduced from two independent networks, while 587/25 on the
same host banner instantly) — an upstream Ethereal outage. Combined with the
Render port block, free instances currently cannot deliver until Ethereal's
2525 recovers. The engine behaves correctly meanwhile: transient failures
climb the retry ladder, rows end `failed` (or defer to the next hour window
under a rate cap), and the reconciler re-enqueues missed work after restarts.

- Verify the non-SMTP surface during an outage: `scripts/e2e-cloud-nosmtp.mjs`
- Probe SMTP reachability + credentials: `DATABASE_URL=… ENCRYPTION_KEY=… node scripts/smtp-probe.mjs`
- For guaranteed delivery: upgrade the API service to a paid compute plan
  (unblocks 587) or swap the transport for an HTTP email API (no SMTP ports
  involved) — the worker depends only on the `MailTransport` interface, so
  this is one module (`apps/worker/src/mailer/`).

## 5. Legacy: running the split topology anywhere

Any host pairs fine with the classic layout (API and `apps/worker` as separate
long-lived processes; leave `WORKER_INPROCESS` unset). The worker needs the
same env (stores, `ENCRYPTION_KEY`, `QUEUE_PREFIX` — use a **different prefix**
per environment) plus `node apps/worker/dist/index.js`. The boot reconciler
resumes exactly where Postgres says things left off after downtime.
