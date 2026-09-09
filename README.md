# ReachInbox — Email Job Scheduler & Dashboard

A standalone scheduling-and-sending engine with a companion dashboard: accepts email-send
requests, schedules them precisely with BullMQ delayed jobs, throttles them like a real
deliverability-conscious sender (dual per-sender/per-tenant hourly caps + delay-between-sends),
survives crashes and restarts **without losing or duplicating a single email**, and gives
users and engineers live visibility into what's queued, sending, and sent.

## Design principles

- **Postgres is the durable record of intent and outcome.** Job existence and status are
  decided here (FR-9). Never bypassed for a decision that matters.
- **Redis/BullMQ is the durable *mechanism* for making it happen on time** — never trusted
  alone; boot-time reconciliation makes restart-safety real rather than assumed.
- **Elasticsearch is a read-optimization, never a dependency.** The send path doesn't touch
  it; the read path falls back to Postgres when ES is unavailable.
- **No cron, anywhere** (FR-7). Periodic maintenance (reindex drift correction) is a BullMQ
  *repeatable* job.
- **Rate limits defer, never drop** (FR-21). A send that would exceed an hourly cap moves to
  the next hour window — the lead is never silently lost, and deferral is not a failure.

## Repository layout

```
apps/
  api/       Express REST API — auth, schedule, query, integrations, Bull Board, boot reconciler
  worker/    BullMQ worker pool — send worker, index worker, reindex repeatable
  web/       Next.js dashboard — login, Scheduled/Sent, Compose, detail, settings
packages/
  db-schema/     canonical DDL, pg pool, AES-GCM secrets, deterministic jobId
  shared-types/  zod schemas + DTOs shared FE<->BE (typed end-to-end, FR-33)
  config/        typed env parsing — every limit env-driven (FR-16/18/19)
  queues/        BullMQ queues, atomic rate limiter (Lua), backoff, SMTP taxonomy, reconciler
  search/        Elasticsearch client — mapping, idempotent upsert, ES-first query
infra/       Dockerfiles, ES mapping
```

## Architecture — who owns what

Each concern lives in exactly one place; state has one owner; data flows one way:

| Concern | Owner | Notes |
|---|---|---|
| Job existence & status | **Postgres** (`email_jobs`) | Every transition is a guarded SQL UPDATE; Redis is never the truth |
| Timing, counters, fan-out | **Redis/BullMQ** (`packages/queues`) | Deterministic jobIds make re-enqueue idempotent; hourly counter keys are Lua-atomic |
| Read/search | **Elasticsearch** (`packages/search`) | Written only by the index worker; API falls back to Postgres when ES is down |
| Env policy (caps, ladders, intervals) | **`packages/config`** | Parsed once, typed, shared by API + worker — no duplicated defaults |
| Contracts & parsing | **`packages/shared-types`** | Zod schemas used by API validation *and* the dashboard |
| Secrets | **Postgres (AES-256-GCM)**, key only in env | `packages/db-schema/src/crypto.ts` is the single encrypt/decrypt path |
| Sessions | **Postgres** (`session` table) | Server-side; `requireAuth` always re-reads the user |

Flow: `web → API → Postgres (+ async fan-out → BullMQ) → send worker → SMTP →
index worker → ES → API → web`. The send path never touches Elasticsearch; the
read path never mutates job state. Cross-cutting policy (backoff ladder, rate
window keys, SMTP failure taxonomy, reconciliation) lives in `packages/queues`
so the API's boot reconciler and the worker's maintenance share one
implementation.

## Quickstart

Prereqs: Docker + Node 20+.

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env
# Fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (required, real OAuth — no mocked auth).
# Optionally fill SLACK_* for breach notifications.
# Fill SEED_SENDER_1_EMAIL / SEED_SENDER_1_PASSWORD (+ sender 2) with real free
# accounts from https://ethereal.email (Nodemailer's fake SMTP — mail never
# leaves the test system, but every message is viewable in Ethereal's inbox).

# 3. Boot Postgres / Redis / Elasticsearch
docker compose up -d postgres redis elasticsearch

# 4. Migrate + seed
#    - `db:seed:ethereal` provisions REAL Ethereal accounts via Nodemailer's
#      account API, upserts them as senders, caches creds in .ethereal-accounts.json
#    - `db:verify:senders` proves every sender passes a real SMTP handshake + AUTH
pnpm db:migrate
pnpm db:seed
pnpm db:seed:ethereal
pnpm db:verify:senders

# 5. Run everything (3 terminals, or `docker compose up` for the containerized path)
pnpm dev:api      # Express API on :3001 (runs boot reconciler first)
pnpm dev:worker   # BullMQ worker pool (runs boot reconciler first)
pnpm dev:web      # Next.js dashboard on :3000 (proxies /api and /admin/queues to :3001)
```

Open **http://localhost:3000** → Login with Google → Compose.

### The restart-safety demo (the best local proof of FR-10)

1. Compose a batch scheduled a few minutes out (or with a big delay-between-sends).
2. `kill -9` the worker process mid-batch (in docker: `docker compose kill worker`).
3. Watch jobs stall in `processing` with expired leases.
4. Restart the worker. On boot it: re-enqueues `scheduled` rows missing from Redis,
   reclaims stale `processing` leases (lease timeout `RECONCILE_LEASE_TIMEOUT_MS`), and
   finishes the batch — every job `sent` exactly once, zero manual intervention.

## Live dashboards

- **Bull Board** (FR-26): `/admin/queues` on the API — waiting/active/delayed/completed/failed
  in real time. Linked from the sidebar ("Queue Dashboard"); requires login.
- **Settings page**: queue counts + this hour's Redis rate counters, Slack connect/disconnect.
- **Structured logs** (Observability NFR): every job transition emits one JSON line —
  `{ jobId, dbJobId, batchId, tenantId, senderId, fromStatus, toStatus, attempt, latencyMs, timestamp }`.

## Configuration reference

Every limit is environment-driven — nothing hardcoded (FR-16, FR-18, FR-19):

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | — |
| `REDIS_URL` | Redis (AOF enabled in compose) | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | Elasticsearch endpoint | `http://localhost:9200` |
| `WORKER_CONCURRENCY` | Send-worker concurrency (FR-16) | `10` |
| `MIN_DELAY_BETWEEN_SENDS_MS` | Reserved floor for pacing; per-batch delay is set in Compose | `2000` |
| `MAX_EMAILS_PER_HOUR` | Tenant-wide hourly cap default (FR-19) | `500` |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Per-sender hourly cap default (FR-19) | `100` |
| `RETRY_MAX_ATTEMPTS` | Total attempts before `failed` (§6.4) | `4` |
| `RETRY_BASE_DELAYS_MS` | Backoff ladder | `30000,60000,120000` |
| `RETRY_JITTER_PCT` | ±jitter fraction of base delay | `0.2` |
| `RECONCILE_LEASE_TIMEOUT_MS` | `processing` lease honored before reclaim | `300000` |
| `REINDEX_INTERVAL_SECONDS` | Drift-correction repeatable interval | `900` |
| `QUEUE_PREFIX` | BullMQ key prefix | `reachinbox` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth (FR-1) | — |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_REDIRECT_URI` | Slack OAuth (FR-22) | — |
| `SESSION_SECRET` | Session cookie signing key | — |
| `ENCRYPTION_KEY` | 64-hex AES-256-GCM key for secrets at rest | — |

Caps can also be set per-row (`tenants.max_emails_per_hour`, `senders.max_emails_per_hour`)
or per-batch (`hourlyLimit` in Compose) — the most specific value wins, evaluated atomically
in one Lua script across **all** applicable counters.

## How the guarantees work

| Guarantee | Mechanism |
|---|---|
| Deterministic jobs (FR-8) | `jobId = sha256(batchId + ":" + recipient).slice(0, 32)` — re-adding is a no-op |
| Restart safety (FR-10/11) | Boot reconciler: DB `scheduled` rows missing from Redis are re-enqueued; stale `processing` leases reclaimed; Redis mutex prevents double-run |
| No double-send (FR-12) | Worker re-reads DB status before sending; `sent` write guarded on the lease holder; already-`sent` redeliveries are acked and skipped |
| Rate-limit correctness (FR-20) | One Lua script checks+increments tenant & sender (and optional batch) counters atomically — reject *before* increment, so counters move together or not at all |
| Deferral, never drop (FR-21) | On reject: status stays `scheduled` (no attempt burned), `scheduled_at` → next hour window, `moveToDelayed` + `DelayedError` keeps the job in BullMQ's delayed set |
| Transient vs permanent (FR-15) | 421/450/451/452 + connection errors retry on the 30s/60s/120s ±jitter ladder; 550/551/553/554/auth fail immediately via `job.discard()` |
| CSV hygiene (edge case) | Deduped + validated before scheduling; skipped rows reported back to the user |
| Slack never blocks sending (FR-24) | Token read at notify-time (FR-25); failures logged at warn and swallowed |
| ES drift | Dual-write via index queue + repeatable reindex job + same-request Postgres fallback (§7.3) |

## FR traceability

| FR | Where |
|---|---|
| FR-1–3 Google OAuth + header + logout | `apps/api/src/modules/auth`, `apps/web/src/app/login`, `Sidebar` user card |
| FR-4–6 Schedule API, validation, async fan-out | `apps/api/src/modules/schedule`, `@reachinbox/queues/scheduler` |
| FR-7–9 BullMQ, deterministic jobId, DB truth + reconcile | `@reachinbox/queues` (queues, jobId, reconciler) |
| FR-10–12 Restart persistence, recovery, explicit states | `@reachinbox/queues/reconciler`, `apps/worker/src/processors/sendWorker` |
| FR-13–15 Ethereal sending, multi-sender, retry/backoff | `apps/worker/src/mailer`, `@reachinbox/queues/{smtpErrors,backoff}` |
| FR-16–18 Concurrency, atomicity, delay-between-sends | `WORKER_CONCURRENCY`, Lua limiter, `batches.delay_between_sends_ms` pacing |
| FR-19–21 Hourly caps, Redis-backed, deferral | `@reachinbox/queues/rateLimiter`, `sendWorker.deferJob` |
| FR-22–25 Slack OAuth + live notify + graceful absence | `apps/api/src/modules/integrations/slack`, `apps/worker/src/slack` |
| FR-26 Live queue dashboard | Bull Board at `/admin/queues` |
| FR-27–28 Elasticsearch index + search with filters | `@reachinbox/search`, `apps/api/src/modules/query` |
| FR-29–32 Dashboard shell, Compose, Scheduled/Sent views | `apps/web/src/{app,components}` |
| FR-33 Componentized, typed, DRY, consistent states | `packages/shared-types`, `apps/web/src/components/ui` |

## Tests

```bash
pnpm test                       # recipients parser, backoff ladder, rate-window keys, SMTP taxonomy, jobId
node scripts/e2e.mjs            # 26-check E2E: auth, uploads, schedule, real SMTP send,
                                # rate-limit deferral, ES search, Redis-loss recovery, logout
```

The E2E harness drives the real HTTP API and real stores (API + worker must be
running). `scripts/reconcile-once.mjs` runs a single reconciliation pass, handy
for demonstrating FR-9/10/11: flush Redis (`docker exec email_automation-redis-1
redis-cli FLUSHALL`), run the script, and watch deferred jobs re-enqueue from
Postgres state.
