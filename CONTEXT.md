# Context

ReachInbox Email Job Scheduler & Dashboard — schedule batches of emails, fan them out
per-recipient with pacing, send through per-sender SMTP with dual (tenant + sender)
hourly caps, retry transient failures up a jittered ladder, and give the dashboard a
fast read model (Elasticsearch-first with Postgres fallback).

## Glossary (domain language)

- **Tenant** — a workspace; owns senders, batches, and the tenant-wide hourly cap.
- **Sender** — an SMTP identity (host/port/credentials + per-sender hourly cap).
- **Batch** — one subject/body fan-out to many recipients, with pacing and an optional per-batch hourly cap override.
- **Email job** — one batch → recipient row; the unit the send engine transitions through `scheduled → processing → sent | failed`.
- **Schedule API** — `POST /api/emails/schedule`; inserts the Batch, responds 202 immediately, fan-out runs async.
- **Fan-out** — bulk-insert email jobs + enqueue one delayed BullMQ send job per row (deterministic jobId; idempotent).
- **Send engine** — the send worker state machine: redelivery guard, processing lease, rate-limit check, SMTP send, terminal writes.
- **Send policy** — the pure decision "this send failed: retry, defer, or fail, and after how long" (classification + ladder + jitter + attempts arithmetic).
- **Rate limiter** — atomic multi-cap hourly counters in Redis (tenant + sender + optional batch).
- **Reconciler** — boot/periodic pass: re-enqueue `scheduled` rows missing from Redis; reclaim expired `processing` leases.
- **Reindex drift pass** — periodic repeatable job that re-enqueues recently-updated email jobs so the search index heals.
- **Search** — Elasticsearch read model over email jobs; disabled means everything degrades to Postgres.
- **Slack integration** — per-tenant OAuth bot token; rate-limit breach notifications.

## Structure (after the architecture pass, 2026-09-11)

```
packages/
  config/         env schema + getConfig (single owner of configuration state)
  shared-types/   zod request schemas + API DTOs + recipient parsing (shared with web)
  db-schema/      Postgres pool + row types + AES-GCM secret crypto + deterministic jobId
  queues/         ONE owner of Redis/queue state and retry policy:
                    connections (producer + blocking), all queues as singletons,
                    rate limiter (Lua), backoff + smtpErrors + sendPolicy (pure),
                    scheduler (fan-out), reconciler, enqueue helpers
  search/         Elasticsearch client + availability policy (disabled ⇒ PG fallback)
apps/
  api/            HTTP module: routes parse/validate/respond; services own SQL;
                  session/auth middleware. Thin process adapter in server.ts.
  worker/         Send engine (processors/sendWorker.ts — I/O only: SQL, lease,
                  transport) + index/reindex processors + mailer + slack notify.
                  workers.ts owns BullMQ lifecycle; index.ts is the process wrapper.
  web/            Next.js dashboard; talks to the API through lib/api-client.
```

Data flow: `web → api (schedule) → batches row → fan-out (queues/scheduler) →
delayed send jobs → send engine (worker) → send policy on failure → email_jobs
status → index jobs → search → api (query, ES-first with PG fallback)`.

Rules the structure keeps:

- **State owners**: Postgres pool in db-schema; Redis connections and every queue in
  queues; env config in config; ES client in search. Exactly one owner each.
- **Policy is pure**: `packages/queues/src/sendPolicy.ts` answers retry/defer/fail +
  delay (`nextAction`); the send engine executes the answer; BullMQ's backoff derives
  from the same module (`retryDelayForAttempt`). Change the ladder in one place.
- **Apps are adapters**: `apps/worker/src/index.ts` and `apps/api/src/server.ts` are
  thin process wrappers (signals, listen). The engine and its lifecycle
  (`startWorkers`) are imported as a module — in-process mode (`WORKER_INPROCESS=true`)
  reuses the exact same implementation.
- **No indirection shims**: re-export files between apps/packages are deleted on sight
  (the boot reconciler shim was the first).
- **Deferred decisions** (do not "fix" without a behavior pass):
  - the schedule module does not enqueue an index job for newly scheduled rows —
    with ES enabled, new rows surface in search only after the reindex drift pass;
    giving the dual-write one owner (search-index module) is a behavior change
    (faster visibility), tracked as the follow-up.
  - `rateLimitBreachMessage` reads env defaults at format time (kept — notify is the
    Slack concern's only cfg touch).

## Deployed topology (Render, 2026-09-11)

- `reachinbox-api` (free web service, `WORKER_INPROCESS=true`) + `reachinbox-web`
  (Next.js) + `reachinbox-kv` (Render Key Value) + external **Neon** Postgres.
- Deployed via `scripts/render-deploy.mjs` (stores → services → env); secrets
  come from the local `.env` through `DEPLOY_FROM_ENV=1`, never from git.
- Session auth runs against Neon (sessions table), Redis holds only BullMQ
  state + rate counters. The API builds without the web app (`--filter=!@reachinbox/web`)
  to fit the free tier's 512MB.
- Known issue (see DEPLOY.md §4): SMTP egress from free instances is blocked
  on 25/465/587 and Ethereal's 2525 was mid-outage at deploy time — all
  non-SMTP surfaces verified green via `scripts/e2e-cloud-nosmtp.mjs` (14/14);
  the full send path was verified locally end-to-end with real Ethereal SMTP.

## Verification story (what later passes must keep green)

- `pnpm -r typecheck` — strict TS across the workspace.
- `pnpm -r test` — node:test suites (queues compile to dist first: `pnpm --filter @reachinbox/queues build`).
- Real run: `docker compose up`-equivalent Redis + `DATABASE_URL`, then
  `pnpm dev:api` boots the API (health at `/api/health`) and runs the reconciler;
  `WORKER_INPROCESS=true` boots the send/index/reindex workers in the same process.
