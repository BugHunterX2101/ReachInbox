# Technical Architecture & Implementation Document
## Email Job Scheduler & Dashboard

| | |
|---|---|
| **Product** | Email Job Scheduler & Dashboard |
| **Team** | Outbox Labs — ReachInbox.ai |
| **Document type** | Unified Technical Architecture & Implementation Document |
| **Source documents** | PRD v1.0 (Sep 9, 2026) · Technical Design Document v1.0 (Sep 9, 2026) |
| **Status** | Draft — Ready for Engineering Review |
| **Version** | 1.0 |
| **Last updated** | September 9, 2026 |

---

### Table of Contents

0. [Purpose and How to Use This Document](#0-purpose-and-how-to-use-this-document)
1. [Executive Summary](#1-executive-summary)
2. [Problem Statement and Goals](#2-problem-statement-and-goals)
3. [System Architecture](#3-system-architecture)
4. [Tech Stack](#4-tech-stack)
5. [Repository and File Structure](#5-repository-and-file-structure)
6. [Data Architecture](#6-data-architecture)
7. [Queueing and Redis Design](#7-queueing-and-redis-design)
8. [Core Flows and Algorithms](#8-core-flows-and-algorithms)
9. [Search Architecture (Elasticsearch)](#9-search-architecture-elasticsearch)
10. [API Specification](#10-api-specification)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Third-Party Integrations](#12-third-party-integrations)
13. [Security Architecture](#13-security-architecture)
14. [Observability and Monitoring](#14-observability-and-monitoring)
15. [Deployment Architecture](#15-deployment-architecture)
16. [Testing Strategy](#16-testing-strategy)
17. [Environment Variables Reference](#17-environment-variables-reference)
18. [Non-Functional Requirements and Success Metrics](#18-non-functional-requirements-and-success-metrics)
19. [Risks and Mitigations](#19-risks-and-mitigations)
20. [Build Roadmap](#20-build-roadmap)
21. [Requirements Traceability Matrix](#21-requirements-traceability-matrix)
22. [Glossary](#22-glossary)
23. [Appendix A — Resolved Open Questions](#23-appendix-a--resolved-open-questions)

---

## 0. Purpose and How to Use This Document

The PRD defines **what** the Email Job Scheduler must do and **why**. The Technical Design Document defines **how** — schemas, algorithms, contracts. This document is the third layer: a single **implementation-ready blueprint** that merges both into one artifact an engineer can build directly against, including two things neither source document specifies — a concrete **repository layout** and a set of **consolidated diagrams** that trace a request across every subsystem in one picture.

Nothing here contradicts the PRD or Design Document. Where a decision was made (the four open questions, the three UI gaps), it's carried forward and marked. Where this document adds something new — the file structure, the end-to-end lifecycle diagram, the deployment topology diagram, the Slack sequence diagram — it's additive detail in service of implementation, not a scope change.

**Quick navigation:**

| If you need... | Go to |
|---|---|
| The 30-second pitch | §1 Executive Summary |
| Why this exists, and what's explicitly out of scope | §2 Problem Statement and Goals |
| The system diagram | §3 System Architecture |
| What framework/library to reach for | §4 Tech Stack |
| Where a new file should live | §5 Repository and File Structure |
| Table schemas and the ER diagram | §6 Data Architecture |
| How the dual rate limiter actually works | §8.4 |
| Why a crash never causes a double-send | §8.6 |
| Exact request/response contracts | §10 API Specification |
| Which screenshot maps to which route/component | §11 Frontend Architecture |
| What's still an open assumption | §19, Appendix A |

---

## 1. Executive Summary

ReachInbox's product promise — one prompt, and the system prospects, verifies, personalizes, and sends — depends entirely on infrastructure most users will never see: a scheduler that fires emails at exactly the right moment, at a pace that looks human, and that never loses or duplicates a send even when a process crashes mid-flight.

This document describes that engine: a **standalone scheduling and sending service** with a companion operator dashboard, built on the principle that **persistence, idempotency, and throttling are first-class architectural concerns**, not features layered on afterward. Concretely, the system guarantees:

- **No duplicate sends and no lost jobs**, across any crash or restart — enforced structurally through a deterministic job-ID scheme and a boot-time reconciliation pass, not through operational discipline.
- **No cron, anywhere.** All scheduling — one-off delayed sends and periodic maintenance work alike — runs through BullMQ (delayed jobs and repeatable jobs), because cron-style polling doesn't persist mid-flight state, races across instances, and has no natural backpressure.
- **Rate limits that defer, never drop.** A send that would exceed an hourly cap is rescheduled into the next window — the lead is never silently lost.
- **A single source of truth.** Postgres owns intent and outcome. Redis is the durable mechanism that makes timing happen. Elasticsearch is a read-optimization that the send path never depends on being healthy.
- **Live operational visibility**, via a real-time BullMQ dashboard (Bull Board) and structured, per-transition logs that map directly to the PRD's success metrics.

This is foundational infrastructure — the engine room every future ReachInbox feature (sequences, drip campaigns, one-off blasts) will eventually sit on top of. It is explicitly **not** a campaign builder, and this phase explicitly does **not** cover real SMTP providers, multi-step sequences, billing tiers, or multi-region failover (§2.3).

---

## 2. Problem Statement and Goals

### 2.1 Why This Exists

Cold email at scale is governed by two forces: **timing** and **restraint**.

- Send too fast from one sender identity and mailbox providers throttle or blacklist it — this is a customer's sender reputation on the line, not an abstract SLA.
- Lose track of what's already gone out after a crash, and the system either double-sends (reputation damage, spam complaints) or silently drops a lead (lost revenue).
- The naive fix — "poll every minute, send what's due" — falls apart at scale: it doesn't durably persist mid-flight work, it races across multiple worker instances, and it has no natural backpressure when a rate limit is hit.

The engineering brief behind this system treats reliability as the top-line requirement: **zero data loss and zero duplicate execution across crashes and restarts is the single most important property of the system**, ranked above scalability, security, and every other non-functional requirement.

### 2.2 Goals

| Category | Goals |
|---|---|
| **Business** | Establish a sending backbone reliable enough to underwrite ReachInbox's "set it and forget it" promise · Eliminate the operational burden of duplicate sends, silently dropped jobs, or invisible rate-limit failures · Build a foundation that scales to many senders/tenants without a rewrite when real SMTP providers replace Ethereal |
| **Campaign Owners** | Schedule a batch and trust it goes out once, on time, in order — even if the backend crashes mid-batch |
| **Workspace Admins** | See what's scheduled and sent at a glance; get alerted the instant a sender is throttled |
| **On-call Engineers** | One dashboard that shows exactly what the queue is doing right now; a restart that requires zero manual intervention |

### 2.3 Non-Goals (This Iteration)

Explicitly out of scope, to keep the engine's core guarantees sharp rather than diluted across features:

- Multi-step drip sequences or conditional/branching journeys — this engine schedules **discrete sends**, not campaigns.
- Real production SMTP providers (SES, SendGrid, Postmark) — **Ethereal** is the sending target for this phase; the transport layer is built as a swappable interface for later (§4).
- Deliverability tooling — warm-up schedules, spam-score checks, domain reputation monitoring.
- Plan-based billing or quota tiers.
- Multi-region failover or geo-distributed workers — Postgres, Redis, and Elasticsearch are each a single instance this phase (§15).

### 2.4 Target Users

| Persona | Who they are | What they need from this system |
|---|---|---|
| **Campaign Owner** | Sales/growth user scheduling a lead batch | Confidence a batch sends completely, once, on time |
| **Workspace Admin** | Owns sender accounts and the Slack connection | Rate-limit configuration, Slack alerts, oversight across senders |
| **On-call Engineer** | Backend engineer supporting production | Live queue visibility, clear failure modes, safe restart behavior |

---

## 3. System Architecture

### 3.1 High-Level Architecture

This diagram consolidates the PRD's system-level view with the Design Document's module-level breakdown into one authoritative picture: four API modules, a boot-time reconciler, a three-worker BullMQ pool, the three data stores, and every external dependency.

```mermaid
flowchart TB
    subgraph CLIENT["Client Layer"]
        FE["Next.js Dashboard<br/>Login · Scheduled · Sent · Compose · Detail"]
    end

    subgraph API_LAYER["API Layer — Express (TypeScript)"]
        MW["API rate limiter<br/>(express-rate-limit)"]
        AUTH["Auth Module"]
        SCHED["Schedule Module"]
        QUERY["Query Module"]
        INTEG["Integrations Module"]
        RECON["Boot Reconciler"]
    end

    subgraph WORKERS["BullMQ Worker Pool"]
        SENDW["Send Worker"]
        IDXW["Index Worker"]
        REIDXW["Reindex Worker<br/>(repeatable job)"]
    end

    subgraph DATA["Data Plane"]
        DB[("Postgres<br/>source of truth")]
        REDIS[("Redis<br/>queues + rate counters")]
        ES[("Elasticsearch<br/>search index")]
    end

    subgraph EXTERNAL["External Services"]
        GOOGLE["Google OAuth"]
        SLACK["Slack API"]
        SMTP["Ethereal SMTP"]
    end

    BOARD["Bull Board<br/>/admin/queues"]

    FE -->|"REST / JSON"| MW
    MW --> AUTH
    MW --> SCHED
    MW --> QUERY
    MW --> INTEG
    FE -.->|"OAuth redirect"| GOOGLE

    AUTH --> DB
    SCHED --> DB
    SCHED -->|"enqueue delayed job"| REDIS
    QUERY --> ES
    QUERY -.->|"fallback if ES down"| DB
    INTEG --> SLACK
    INTEG --> DB
    RECON --> DB
    RECON --> REDIS

    REDIS --> SENDW
    SENDW --> DB
    SENDW -->|"atomic rate check"| REDIS
    SENDW --> SMTP
    SENDW -.->|"breach notify"| SLACK
    SENDW -->|"enqueue index job"| REDIS
    REDIS --> IDXW
    IDXW --> DB
    IDXW --> ES
    REIDXW --> DB
    REIDXW --> ES

    BOARD --> REDIS
    FE --> BOARD
```

**Reading this diagram:** every write to durable state flows into Postgres. Redis never holds anything that Postgres doesn't already know about — it's the timing mechanism, not the record. Elasticsearch sits entirely off to the side of the send path, fed asynchronously, with the Query Module able to bypass it entirely if it's unavailable.

### 3.2 Component Responsibility Matrix

| Component | Responsibility | Talks to | Satisfies |
|---|---|---|---|
| Auth Module | Google OAuth handshake, session issuance, `GET /api/me` | Google, Postgres | FR-1–FR-3 |
| Schedule Module | Validate schedule requests, persist batch + jobs, enqueue delayed BullMQ jobs | Postgres, Redis | FR-4–FR-9 |
| Query Module | Serve Scheduled/Sent list and search, with fallback | Elasticsearch (primary), Postgres (fallback) | FR-27, FR-28, FR-31, FR-32 |
| Integrations Module | Slack OAuth connect/disconnect, token storage | Slack, Postgres | FR-22, FR-25 |
| Boot Reconciler | On every process start, diff DB `scheduled`/stale-`processing` rows against Redis and repair | Postgres, Redis | FR-10, FR-11 |
| Send Worker | Dequeue jobs, enforce the dual rate limit, send via SMTP, transition status, trigger indexing | Redis, Postgres, Ethereal, Slack | FR-12–FR-21 |
| Index Worker | Consume "index this job" events, write to Elasticsearch, retry on failure | Redis, Postgres, Elasticsearch | FR-27 |
| Reindex Worker | Periodic (BullMQ repeatable, never cron) drift correction between DB and ES | Postgres, Elasticsearch | FR-7 |
| Bull Board | Live view of waiting/active/delayed/completed/failed jobs | Redis | FR-26 |

### 3.3 Design Principles

> **Postgres is the durable record of intent and outcome.** What should happen, and what did happen. It is never bypassed for a decision that matters.

> **Redis/BullMQ is the durable mechanism for making it happen on time.** It is trusted to fire jobs at the right moment, but never trusted alone — the boot-time reconciliation step is what makes restart-safety real rather than assumed.

> **Elasticsearch is a read-optimization, never a dependency.** Nothing about correctness depends on ES being up; the send path doesn't touch it, and the read path falls back around it.

> **No cron, anywhere — not even for "just a periodic job."** The reindex drift-correction job is exactly the kind of task that's tempting to reach for `node-cron` on; it runs as a BullMQ repeatable job instead, going through the same Redis-backed infrastructure as everything else.

> **Clear layer separation for swappability.** The API, scheduling, and sending layers are independent enough that any one can be replaced later — Ethereal → SES/SendGrid, for instance — by touching one module, not by touching the worker logic that depends on it.

---

## 4. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router, TypeScript), Tailwind CSS | App Router gives clean route separation for `/login`, `/`, `/compose`, `/emails/[id]` |
| API | Express (TypeScript) | Kept thin — business logic lives in the four modules from §3.2 |
| Validation | Zod | Schema-validates every request body against the "actionable errors" requirement (FR-5) |
| Scheduling | BullMQ | Delayed jobs, deterministic `jobId`, repeatable jobs for the reindex worker (FR-7, FR-8) |
| Queue / cache / rate-limit store | Redis (`ioredis` client) | AOF persistence enabled — see §7 |
| Relational DB | Postgres 14+ | Chosen over MySQL for native `UUID`/`gen_random_uuid()`, partial indexes, and `SELECT … FOR UPDATE SKIP LOCKED`; schema is portable to MySQL with minor syntax changes if ever needed |
| Search | Elasticsearch 8.x | Dual-written index, described in §9 |
| Mail transport | Nodemailer, pointed at Ethereal SMTP | Transport is an injected interface so swapping to SES/SendGrid later touches one module, not the worker logic |
| Auth | `passport-google-oauth20` (or equivalent), server-side session (signed, httpOnly cookie) | No client-side token handling |
| Slack | `@slack/oauth`, `@slack/web-api` | OAuth v2 connect flow + `chat.postMessage` / incoming webhook for breach notifications |
| Live dashboard | `@bull-board/express` mounted at `/admin/queues` | FR-26 |
| Logging | Pino (structured JSON logs) | One log line per job-lifecycle transition |
| Containerization | Docker Compose for local dev (API, worker, web, Postgres, Redis, Elasticsearch) | `docker compose up` should reproduce full restart-safety locally |

---

## 5. Repository and File Structure

The codebase is organized as a **monorepo** — three deployable apps sharing typed contracts and a single schema, so "typed end-to-end (API responses and props)" (FR-33) is a structural property, not a discipline problem.

```mermaid
flowchart TB
    subgraph apps["apps/"]
        web["web/ — Next.js dashboard"]
        api["api/ — Express REST API"]
        worker["worker/ — BullMQ workers"]
    end
    subgraph packages["packages/"]
        shared["shared-types/"]
        dbschema["db-schema/"]
        config["config/"]
    end
    subgraph infra["infra/"]
        docker["docker/ — Dockerfiles"]
        compose["docker-compose.yml"]
    end

    web -.->|imports| shared
    api -.->|imports| shared
    api -.->|imports| dbschema
    worker -.->|imports| shared
    worker -.->|imports| dbschema
    docker -.->|builds| web
    docker -.->|builds| api
    docker -.->|builds| worker
```

### 5.1 Full Directory Layout

```text
reachinbox-email-scheduler/
├── apps/
│   ├── web/                                 # Next.js 14+ dashboard (App Router, TypeScript, Tailwind)
│   │   ├── app/
│   │   │   ├── login/
│   │   │   │   └── page.tsx                 # Screenshot 1 — Google OAuth entry point (FR-1)
│   │   │   ├── (dashboard)/
│   │   │   │   ├── layout.tsx               # AppShell: Sidebar + TopBar wrapper
│   │   │   │   ├── page.tsx                 # "/" — Scheduled/Sent tab state (Screenshots 2-3)
│   │   │   │   └── emails/
│   │   │   │       └── [id]/
│   │   │   │           └── page.tsx         # Email detail (Screenshot 4)
│   │   │   ├── compose/
│   │   │   │   └── page.tsx                 # Compose (Screenshots 5-7)
│   │   │   ├── layout.tsx                   # Root layout, providers
│   │   │   └── globals.css
│   │   ├── components/
│   │   │   ├── shell/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── Logo.tsx
│   │   │   │   ├── UserMenu.tsx             # avatar, name, email, Logout (FR-2, FR-3)
│   │   │   │   ├── ComposeButton.tsx
│   │   │   │   ├── NavList.tsx              # Scheduled/Sent live counts
│   │   │   │   └── TopBar.tsx               # SearchInput, FilterButton, RefreshButton
│   │   │   ├── emails/
│   │   │   │   ├── EmailList.tsx            # shared by Scheduled + Sent tabs
│   │   │   │   ├── EmailListRow.tsx
│   │   │   │   ├── StatusPill.tsx           # scheduled(amber) / sent(gray) / failed(red)
│   │   │   │   ├── EmailDetail.tsx
│   │   │   │   ├── DetailHeader.tsx         # back, star, archive, delete
│   │   │   │   ├── SenderMeta.tsx
│   │   │   │   ├── BodyRenderer.tsx         # shared with Compose preview
│   │   │   │   └── AttachmentCard.tsx
│   │   │   ├── compose/
│   │   │   │   ├── ComposeForm.tsx
│   │   │   │   ├── FromSelect.tsx           # sender dropdown
│   │   │   │   ├── ToField.tsx              # ChipInput + UploadListAction
│   │   │   │   ├── ChipInput.tsx
│   │   │   │   ├── UploadListAction.tsx     # CSV/text upload, parsed-count feedback (FR-30)
│   │   │   │   ├── SubjectInput.tsx
│   │   │   │   ├── PacingInputs.tsx         # DelayInput + HourlyLimitInput
│   │   │   │   ├── RichTextEditor.tsx
│   │   │   │   ├── AttachmentTray.tsx
│   │   │   │   ├── SendLaterPopover.tsx     # date/time picker + presets
│   │   │   │   └── PrimaryCTA.tsx           # "Send" | "Send Later", state-driven
│   │   │   └── ui/                          # Button, Input, Modal, Table, Skeleton primitives
│   │   ├── lib/
│   │   │   ├── api-client.ts                # typed fetch wrapper, uses packages/shared-types
│   │   │   ├── hooks/
│   │   │   │   ├── useEmails.ts             # SWR/React Query — [tab, searchTerm, filters, page]
│   │   │   │   └── useSession.ts
│   │   │   └── utils.ts
│   │   ├── public/
│   │   ├── next.config.js
│   │   ├── tailwind.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── api/                                 # Express REST API (TypeScript)
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── auth.routes.ts       # /api/auth/google, /callback, /logout, /me
│   │   │   │   │   ├── auth.controller.ts
│   │   │   │   │   ├── auth.service.ts      # Google OAuth handshake, tenant auto-create
│   │   │   │   │   └── session.ts           # signed httpOnly cookie session
│   │   │   │   ├── schedule/
│   │   │   │   │   ├── schedule.routes.ts   # POST /api/emails/schedule
│   │   │   │   │   ├── schedule.controller.ts
│   │   │   │   │   ├── schedule.service.ts  # validation + async fan-out (§8.2)
│   │   │   │   │   └── schedule.schema.ts   # Zod request schemas
│   │   │   │   ├── query/
│   │   │   │   │   ├── query.routes.ts      # GET /api/emails/scheduled, /sent
│   │   │   │   │   ├── query.controller.ts
│   │   │   │   │   └── query.service.ts     # ES-first, Postgres-fallback (§9.3)
│   │   │   │   └── integrations/
│   │   │   │       └── slack/
│   │   │   │           ├── slack.routes.ts  # /connect, /callback, DELETE /
│   │   │   │           ├── slack.controller.ts
│   │   │   │           └── slack.service.ts
│   │   │   ├── reconciler/
│   │   │   │   └── bootReconciler.ts        # runs on process start (§8.6)
│   │   │   ├── middleware/
│   │   │   │   ├── requireAuth.ts
│   │   │   │   ├── apiRateLimit.ts          # express-rate-limit, §13
│   │   │   │   ├── validateBody.ts          # Zod middleware
│   │   │   │   └── errorHandler.ts          # shared error envelope
│   │   │   ├── db/
│   │   │   │   ├── client.ts                # Postgres pool
│   │   │   │   └── migrations/
│   │   │   │       ├── 0001_init.sql
│   │   │   │       ├── 0002_batch_attachments.sql
│   │   │   │       └── 0003_indexes.sql
│   │   │   ├── config/
│   │   │   │   └── env.ts                   # typed env parsing (§17)
│   │   │   ├── app.ts                       # Express app assembly
│   │   │   └── server.ts                    # entrypoint — runs reconciler, then listens
│   │   ├── tests/
│   │   │   ├── integration/
│   │   │   └── unit/
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── worker/                              # BullMQ worker pool (TypeScript)
│       ├── src/
│       │   ├── queues/
│       │   │   ├── emailSendQueue.ts        # deterministic jobId, delayed jobs (§7)
│       │   │   ├── indexQueue.ts            # "index-email" jobs
│       │   │   └── reindexQueue.ts          # BullMQ repeatable job, not cron (§9.4)
│       │   ├── processors/
│       │   │   ├── sendWorker.ts            # §8.3, §8.4, §8.5
│       │   │   ├── indexWorker.ts           # §9.2
│       │   │   └── reindexWorker.ts         # §9.4
│       │   ├── rateLimiter/
│       │   │   ├── dualRateLimit.lua        # §8.4 atomic Lua script
│       │   │   └── rateLimiter.ts           # loads/evaluates the Lua script
│       │   ├── mailer/
│       │   │   └── etherealTransport.ts     # Nodemailer, injected-interface (FR-13)
│       │   ├── slack/
│       │   │   └── notifySlack.ts           # token read at call-time (FR-25)
│       │   ├── reconciler/
│       │   │   └── leaseReclaimer.ts        # stale `processing` lease reclaim (§8.6)
│       │   ├── config/
│       │   │   └── env.ts
│       │   └── index.ts                     # worker entrypoint, WORKER_CONCURRENCY
│       ├── tests/
│       ├── tsconfig.json
│       └── package.json
│
├── packages/
│   ├── shared-types/                        # API contracts + DTOs shared FE <-> BE (FR-33)
│   │   ├── src/
│   │   │   ├── email.ts
│   │   │   ├── batch.ts
│   │   │   ├── api-contracts.ts             # request/response shapes from §10
│   │   │   └── index.ts
│   │   └── package.json
│   ├── db-schema/                           # schema shared by api + worker
│   │   ├── schema.sql                       # canonical DDL, §6.2
│   │   └── package.json
│   └── config/                              # shared eslint/tsconfig/prettier
│       ├── eslint-preset.js
│       └── tsconfig.base.json
│
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.web
│   │   ├── Dockerfile.api
│   │   └── Dockerfile.worker
│   ├── elasticsearch/
│   │   └── email_jobs.mapping.json          # §9.1
│   └── docker-compose.yml                   # api + worker + web + postgres + redis + es
│
├── .env.example                             # mirrors §17
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── README.md                                # setup, env vars, "kill -9 the worker" restart demo
```

**Why a monorepo:** `packages/shared-types` is what makes FR-33's "typed end-to-end" a compile-time guarantee rather than a convention — if the API's response shape drifts from what the frontend expects, the build fails before code review, not in QA. `packages/db-schema` gives the API and the worker one schema to agree on, instead of two hand-maintained copies drifting apart.


---

## 6. Data Architecture

### 6.1 Entity-Relationship Diagram

```mermaid
erDiagram
    TENANTS ||--o{ USERS : has
    TENANTS ||--o{ SENDERS : owns
    TENANTS ||--o{ BATCHES : owns
    TENANTS ||--o| SLACK_INTEGRATIONS : connects
    USERS ||--o{ BATCHES : creates
    SENDERS ||--o{ BATCHES : "sent via"
    BATCHES ||--o{ EMAIL_JOBS : "expands to"
    BATCHES ||--o{ BATCH_ATTACHMENTS : has
    SENDERS ||--o{ EMAIL_JOBS : sends

    TENANTS {
        uuid id PK
        text name
        int max_emails_per_hour
    }
    USERS {
        uuid id PK
        uuid tenant_id FK
        text google_id
        text email
        text avatar_url
    }
    SENDERS {
        uuid id PK
        uuid tenant_id FK
        text from_address
        int max_emails_per_hour
    }
    BATCHES {
        uuid id PK
        uuid tenant_id FK
        uuid sender_id FK
        uuid created_by FK
        timestamptz start_time
        int delay_between_sends_ms
        int hourly_limit_override
        int requested_count
        int scheduled_count
    }
    EMAIL_JOBS {
        uuid id PK
        uuid batch_id FK
        uuid tenant_id FK
        uuid sender_id FK
        text recipient
        text status
        text bullmq_job_id
        int attempts
        timestamptz scheduled_at
        timestamptz sent_at
        timestamptz locked_at
    }
    BATCH_ATTACHMENTS {
        uuid id PK
        uuid batch_id FK
        text filename
        text storage_url
    }
    SLACK_INTEGRATIONS {
        uuid tenant_id PK
        text webhook_url
    }
```

### 6.2 Schema (DDL — Postgres)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE tenants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  max_emails_per_hour   INT NOT NULL DEFAULT 500, -- tenant-wide cap; overrides MAX_EMAILS_PER_HOUR env default
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  google_id     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE senders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  name                  TEXT NOT NULL,
  from_address          TEXT NOT NULL,
  smtp_host             TEXT NOT NULL,
  smtp_port             INT NOT NULL,
  smtp_user             TEXT NOT NULL,
  smtp_pass_encrypted   TEXT NOT NULL,          -- app-level AES-GCM, never plaintext (see §13)
  max_emails_per_hour   INT NOT NULL DEFAULT 100, -- per-sender cap; overrides MAX_EMAILS_PER_HOUR_PER_SENDER env default
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_address)
);

CREATE TABLE batches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id),
  created_by                UUID NOT NULL REFERENCES users(id),
  sender_id                 UUID NOT NULL REFERENCES senders(id),
  subject                   TEXT NOT NULL,
  body                      TEXT NOT NULL,
  start_time                TIMESTAMPTZ NOT NULL,
  delay_between_sends_ms    INT NOT NULL DEFAULT 0,
  hourly_limit_override     INT,                -- optional per-batch cap; falls back to sender/tenant defaults
  requested_count           INT NOT NULL,
  scheduled_count           INT NOT NULL DEFAULT 0, -- filled in as async expansion completes (FR-6)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_time >= created_at - interval '1 minute') -- guards FR-5's "start time not in the past"
);

CREATE TABLE batch_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  storage_url     TEXT NOT NULL,     -- S3-compatible object storage
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID NOT NULL REFERENCES batches(id),
  tenant_id         UUID NOT NULL REFERENCES tenants(id), -- denormalized: hot-path rate checks & tenant-scoped queries avoid a join
  sender_id         UUID NOT NULL REFERENCES senders(id),
  recipient         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'processing', 'sent', 'failed')), -- exact enum from PRD §11
  bullmq_job_id     TEXT NOT NULL UNIQUE,     -- deterministic: derived from (batch_id, recipient) — see §7
  attempts          INT NOT NULL DEFAULT 0,   -- mirrors BullMQ's attemptsMade for dashboard visibility (§8.5)
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,              -- processing-lease start; NULL unless status = processing
  locked_by         TEXT,                     -- worker instance id holding the lease
  scheduled_at      TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (batch, recipient): app-level idempotency backstop in addition to BullMQ's own jobId dedup (FR-8, FR-12)
CREATE UNIQUE INDEX idx_email_jobs_batch_recipient ON email_jobs (batch_id, recipient);

-- Dashboard list queries (Scheduled/Sent) and the reconciler's boot-time scan
CREATE INDEX idx_email_jobs_status_scheduled_at ON email_jobs (status, scheduled_at);
CREATE INDEX idx_email_jobs_tenant_status ON email_jobs (tenant_id, status);
CREATE INDEX idx_email_jobs_sender_status ON email_jobs (sender_id, status);

-- Fast lookup of leases the reconciler needs to reclaim (§8.6)
CREATE INDEX idx_email_jobs_processing_locked_at ON email_jobs (locked_at) WHERE status = 'processing';

CREATE TABLE slack_integrations (
  tenant_id                 UUID PRIMARY KEY REFERENCES tenants(id),
  access_token_encrypted    TEXT,
  webhook_url               TEXT,
  connected_by              UUID REFERENCES users(id),
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Absence of a row for a tenant means "not connected" (FR-24) — no boolean flag needed.
```

### 6.3 Key Design Decisions

- **`status` is `TEXT` + `CHECK`, not a native `ENUM`.** Postgres enums require a type-altering migration to extend; a check constraint is a one-line migration if a future status (e.g. `cancelled`) is ever needed. The value set stays exactly the four states the PRD specifies — nothing added speculatively.
- **`tenant_id` is denormalized onto `email_jobs`**, even though it's derivable via `batch_id → batches.tenant_id`. The dual rate limiter (§8.4) and the Scheduled/Sent queries both filter by tenant on the hot path; skipping the join is a direct lever on the dashboard's p95 < 300ms target and per-send rate-check latency.
- **The unique index on `(batch_id, recipient)`** is a second, independent idempotency guard beneath BullMQ's deterministic `jobId`. If the Schedule Module's async expansion (§8.2) is ever re-triggered for the same batch, the DB itself refuses the duplicate row rather than relying solely on Redis being correct.
- **`locked_at` / `locked_by`** implement a lease, not a permanent claim. A worker crashing mid-send leaves a row parked in `processing`; without a lease timeout, that row would need a human to notice and fix it. §8.6 covers how the reconciler reclaims expired leases automatically.
- **Tenant creation** isn't specified anywhere in the PRD (billing/quota tiers and multi-user tenant invites are explicit non-goals). This design assumes a tenant is created automatically on first Google login — one tenant per first-login user for this phase — which keeps FR-1/FR-2 self-contained without inventing an onboarding flow the PRD never asked for. Flagged as an assumption, not a requirement.

---

## 7. Queueing and Redis Design

| Key pattern | Purpose | TTL / lifecycle |
|---|---|---|
| `bull:email-send:*` | BullMQ's own queue state (waiting/active/delayed/completed/failed) for the `email-send` queue | Managed by BullMQ |
| `bull:reindex:*` | BullMQ repeatable-job state for the Reindex Worker (§9) | Managed by BullMQ |
| `rate:tenant:{tenantId}:{YYYYMMDDHH}` | Per-tenant hourly send counter | Expires at the top of the next hour + 5s buffer |
| `rate:sender:{senderId}:{YYYYMMDDHH}` | Per-sender hourly send counter | Expires at the top of the next hour + 5s buffer |
| `lock:reconcile` | Mutex so only one process instance runs boot reconciliation at a time | 60s, released on completion |

**Deterministic `jobId`:**

```
jobId = sha256(batchId + ":" + recipient.trim().toLowerCase()).slice(0, 32)
```

This is what makes FR-8 real. Re-adding a job with the same `batchId` + `recipient` — from a retried API call, a re-run reconciliation, or a redeployed worker re-processing a partially-expanded batch — resolves to the *same* BullMQ job. BullMQ itself treats `add()` with an existing, not-yet-removed `jobId` as a no-op that returns the existing job, so double-enqueueing is safe by construction, not just by convention.

**Why AOF persistence, not just RDB snapshots:** RDB snapshots lose everything since the last snapshot on a crash; AOF (append-only file, `appendfsync everysec` is a reasonable default) bounds the loss window to roughly one second. This is the first line of defense against Redis data loss; DB-based reconciliation on boot (§8.6) is the second line, and is what makes the guarantee real even if AOF is disabled or corrupted.

---

## 8. Core Flows and Algorithms

### 8.1 End-to-End Job Lifecycle

Before drilling into each sub-flow individually, this diagram traces one email's complete journey — from the moment Compose is submitted to the moment it's visible and searchable in the Sent view — touching every subsystem described in the rest of this section.

```mermaid
flowchart TD
    A(["Compose form submitted"]) --> B{"Validation passes?"}
    B -- No --> B1[["Return 400 + field errors"]]
    B -- Yes --> C["Insert batches row<br/>Respond 202 + batchId"]
    C --> D["Async fan-out:<br/>bulk insert email_jobs, status = scheduled"]
    D --> E["Enqueue delayed BullMQ job per row<br/>deterministic jobId"]
    E --> F{{"Delay elapses — job due"}}
    F --> G["Send Worker dequeues job"]
    G --> H{"DB status already sent?"}
    H -- Yes --> H1[["No-op: ack and skip"]]
    H -- No --> I["Acquire lease: status = processing"]
    I --> J{"Dual rate limiter:<br/>tenant AND sender caps"}
    J -- Reject --> K["Defer to next hour window<br/>status stays scheduled"]
    K -.-> K1[/"Notify Slack, if connected"/]
    K --> F
    J -- Allow --> L["Send via Nodemailer to Ethereal"]
    L -- Success --> M["status = sent, sent_at set"]
    L -- "Transient failure" --> N{"attempts below 4?"}
    N -- Yes --> O["status back to scheduled<br/>backoff 30s / 60s / 120s plus jitter"]
    O --> F
    N -- No --> P["status = failed, reason recorded"]
    L -- "Permanent failure" --> P
    M --> Q["Enqueue index-email job"]
    Q --> R["Index Worker upserts into Elasticsearch"]
    R --> S(["Visible in Sent view"])
    P --> S
```

### 8.2 Idempotent Batch Scheduling

Satisfies FR-4, FR-5, FR-6, FR-8. The API must never block on inserting a large batch (FR-6), so batch creation and job expansion are split into a fast synchronous step and an async fan-out.

```mermaid
sequenceDiagram
    participant FE as Dashboard
    participant API as Schedule Module
    participant DB as Postgres
    participant Q as BullMQ / Redis

    FE->>API: POST /api/emails/schedule
    API->>API: Validate (addresses, non-empty subject/body, start time not in past)
    API->>DB: INSERT batches row, requested_count = N
    API-->>FE: 202 Accepted { batchId, requestedCount }
    Note over API,Q: Everything below happens asynchronously — the caller already has a response
    API->>DB: Bulk INSERT email_jobs (status=scheduled, deterministic bullmq_job_id per row)
    API->>Q: Add one delayed job per row (jobId = bullmq_job_id, delay = scheduled_at - now)
    API->>DB: UPDATE batches SET scheduled_count = N
```

Each row's `scheduled_at` is derived from `start_time + (row_index * delay_between_sends_ms)` — even before the hourly cap ever engages, sends are already spread out rather than fired in a burst, giving the "natural pacing" the product needs to look human to mailbox providers.

Because `bullmq_job_id` is computed the same way every time (§7), re-running this expansion for the same batch — say, a worker crash mid-fan-out followed by a resumed job — is safe: the DB insert either succeeds (new row) or is rejected by the `(batch_id, recipient)` unique index (already exists, skip), and the BullMQ `add()` call either creates the delayed job or silently matches the existing one.

### 8.3 Send Worker State Machine

Satisfies FR-12. `processing` is the only state a crash can leave a job stranded in — the diagram below is intentionally explicit about that, since it's the state the reconciler (§8.6) has to reason about.

```mermaid
stateDiagram-v2
    [*] --> scheduled
    scheduled --> processing: worker dequeues job, acquires lease
    processing --> sent: SMTP ack received, DB write commits
    processing --> scheduled: transient failure, attempts < 4 (wait per backoff ladder)
    processing --> failed: permanent failure, or attempts exhausted
    processing --> processing: reconciler reclaims an expired lease, re-attempts
    sent --> [*]
    failed --> [*]
```

Before flipping a row to `processing`, the worker re-reads its DB status inside the same transaction. If it's already `sent` — the classic redelivery case, where BullMQ or the reconciler hands the worker a job that was actually already completed — the worker acks and no-ops instead of sending again. This is the concrete mechanism behind FR-12's guarantee that a crash mid-send can never cause a silent double-send on retry.

### 8.4 Dual Rate Limiting — Per-Sender and Per-Tenant

Resolves Open Question 2 (Appendix A). Satisfies FR-19, FR-20, FR-21. A send has to clear **two** independent hourly caps — its sender's and its tenant's — and the check against both has to be atomic across concurrently-running workers, or two workers racing the same boundary could both read "one slot left" and both send, breaching the cap.

```mermaid
flowchart LR
    Start(["Job due for sending"]) --> Read["Lua script:<br/>GET tenant count, GET sender count"]
    Read --> Check{"tenant count over cap<br/>OR sender count over cap?"}
    Check -- Yes --> Reject["Return 0 — reject<br/>(neither counter incremented)"]
    Check -- No --> Incr["INCR tenant counter<br/>INCR sender counter<br/>EXPIRE both at hour boundary"]
    Incr --> Allow["Return 1 — allow<br/>caller proceeds to SMTP"]
    Reject --> Defer["Job deferred to next hour window<br/>status stays scheduled"]
```

Redis Lua scripts execute atomically (Redis is single-threaded per script), so the check-and-increment for both counters happens as one indivisible operation:

```lua
-- KEYS[1] = tenant rate key   e.g. rate:tenant:{tenantId}:{hourWindow}
-- KEYS[2] = sender rate key   e.g. rate:sender:{senderId}:{hourWindow}
-- ARGV[1] = tenant cap (tenants.max_emails_per_hour, or MAX_EMAILS_PER_HOUR env default)
-- ARGV[2] = sender cap (senders.max_emails_per_hour, or MAX_EMAILS_PER_HOUR_PER_SENDER env default)
-- ARGV[3] = seconds until the hour window boundary (TTL for both keys)

local tenantCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local senderCount  = tonumber(redis.call('GET', KEYS[2]) or '0')

if tenantCount >= tonumber(ARGV[1]) or senderCount >= tonumber(ARGV[2]) then
  return 0 -- reject: caller defers the job (§8.7)
end

redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1 -- allow: caller proceeds to SMTP send
```

Rejecting *before* incrementing either counter means a denied attempt never partially consumes tenant quota without consuming sender quota (or vice versa) — the two counters move together or not at all. Caps are read from `senders.max_emails_per_hour` / `tenants.max_emails_per_hour` (falling back to the `MAX_EMAILS_PER_HOUR*` env defaults when the DB column is null), giving workspace admins real per-sender and per-tenant configurability without a redeploy.

### 8.5 Retry and Backoff for Transient SMTP Failures

Resolves Open Question 4 (Appendix A). Satisfies FR-15. Four total attempts; the wait is exponential with jitter; only transient failures consume the ladder.

| Attempt | Trigger | Wait before this attempt | Cumulative elapsed |
|---|---|---|---|
| 1 | Job becomes due | 0s | 0s |
| 2 | Attempt 1 failed (transient) | ~30s ± jitter | ~30s |
| 3 | Attempt 2 failed (transient) | ~60s ± jitter | ~90s |
| 4 | Attempt 3 failed (transient) | ~120s ± jitter | ~210s |
| — | Attempt 4 failed (transient) | — | Status → `failed`, reason = "max attempts exceeded" |

Jitter is ±20% of the base delay (`delay = base + base * 0.2 * (2 * random() - 1)`), which spreads out a batch of jobs that all failed at the same instant — e.g. a brief Ethereal outage — instead of them all retrying in lockstep and re-hammering the same failure.

```js
// BullMQ custom backoff strategy, registered on the email-send queue
function backoffStrategy(attemptsMade) {
  const table = [30_000, 60_000, 120_000]; // ms
  const base = table[Math.min(attemptsMade - 1, table.length - 1)];
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // +/- 20%
  return Math.max(0, Math.round(base + jitter));
}
// Queue registration: { attempts: 4, backoff: { type: 'custom' } }
```

Classifying a failure as transient or permanent decides whether it ever reaches that ladder:

| Classification | Examples | Worker behavior |
|---|---|---|
| Transient | Connection timeout/reset, `421` (service unavailable), `450`/`451`/`452` (mailbox busy, local error, insufficient storage) | Increment `attempts`, status back to `scheduled`, let BullMQ's backoff schedule the retry |
| Permanent | `550`/`551`/`553`/`554` (mailbox unavailable, user unknown, exceeded quota, transaction failed), address failed validation | Status → `failed` immediately, `job.discard()` so BullMQ doesn't burn a retry on something that will never succeed |

`email_jobs.attempts` is a DB mirror of BullMQ's own internal `attemptsMade` — deliberately duplicated, not the single source of truth. BullMQ's counter drives the actual retry logic; the DB copy exists so the Sent/Scheduled dashboard and an on-call engineer can see retry history by querying Postgres, without reaching into Redis internals. This mirrors the DB-truth / Redis-mechanism split from §3.3, just at a smaller scale.

### 8.6 Restart Reconciliation and Crash Recovery

Satisfies FR-9, FR-10, FR-11. This elaborates the one case a simpler restart diagram doesn't fully resolve: a job stuck in `processing` because its worker died mid-send.

```mermaid
sequenceDiagram
    participant P as Process (API or Worker) on boot
    participant DB as Postgres
    participant Q as Redis / BullMQ

    P->>DB: SETNX lock:reconcile (skip entirely if another instance already holds it)
    P->>DB: SELECT * FROM email_jobs WHERE status='scheduled'
    loop each scheduled row
        P->>Q: getJob(bullmq_job_id)
        alt job missing from Redis
            P->>Q: add delayed job, delay = max(0, scheduled_at - now)
        else job already present
            P->>P: leave untouched — already correctly queued
        end
    end
    P->>DB: SELECT * FROM email_jobs WHERE status='processing' AND locked_at < now() - lease_timeout
    loop each stale-lease row
        P->>DB: UPDATE status='scheduled', locked_at=NULL, locked_by=NULL
        P->>Q: add delayed job, delay = 0 (retry immediately)
    end
    P->>DB: release lock:reconcile
    P->>P: log {reconciled, reclaimed, alreadyHealthy}
```

Two passes, two different failure modes:

1. **`scheduled` rows missing from Redis** — Redis lost data, or the job was never successfully enqueued in the first place. Deterministic `jobId` means re-adding is always safe, whether or not the job secretly still existed.
2. **`processing` rows with an expired lease** — a worker died between marking a row `processing` and confirming `sent`. A short, generous lease timeout (e.g. 5 minutes — long enough that a live worker's genuine in-flight SMTP call won't be mistaken for dead) distinguishes "still being handled by a live worker" from "orphaned by a crash." Only expired leases get reclaimed; a fresh lease is left alone even though the row is sitting in `processing`, because another instance may legitimately still be mid-send.

> **A residual risk worth naming rather than hiding:** if a worker crashes in the narrow window *after* Ethereal acknowledges the send but *before* the `sent` write commits, reconciliation will correctly see an expired lease and retry — sending a second, genuinely duplicate email. Nothing in this design (or, for what it's worth, in most at-least-once delivery systems without an idempotent downstream) closes that window to zero, because Ethereal has no idempotency-key concept to lean on. The mitigation is making the window as small as possible — the `sent` write is the very next statement after the SMTP call returns, with nothing else in between — and accepting the residual risk for this phase. A future move to a provider with idempotent send APIs (e.g. an idempotency key SES/SendGrid can dedupe on) would close this properly.

### 8.7 Rate-Limit Deferral

Satisfies FR-21. When §8.4's Lua script returns "reject," the job is deferred, never failed:

- `email_jobs.scheduled_at` is updated to the start of the next hour window.
- Status stays `scheduled` — deferral isn't a failure, so `attempts` is **not** incremented and no `last_error` is recorded.
- The BullMQ job is re-added with a delay matching the new `scheduled_at`.
- If Slack is connected, the breach is reported (§12.2) — fire-and-forget, off the send path, per FR-24.

This deliberately doesn't try to look further ahead than "the next hour" — if that hour is also projected to be full given queue volume, the same worker hits the same deferral logic again when the job becomes due a second time. That keeps the mechanism simple and self-correcting rather than building a capacity-forecasting scheduler nothing in the requirements asks for; the natural backpressure loop is the point.

---

## 9. Search Architecture (Elasticsearch)

Resolves Open Question 3 (Appendix A). Postgres decides a job's existence and status; Elasticsearch only makes that decided state searchable, faster than Postgres alone would for free-text/multi-field queries at scale. **Nothing about correctness depends on ES being up.**

### 9.1 Index Mapping

```json
{
  "mappings": {
    "properties": {
      "id":          { "type": "keyword" },
      "batchId":     { "type": "keyword" },
      "tenantId":    { "type": "keyword" },
      "senderId":    { "type": "keyword" },
      "senderEmail": { "type": "keyword" },
      "recipient":   { "type": "text", "fields": { "raw": { "type": "keyword" } } },
      "subject":     { "type": "text" },
      "status":      { "type": "keyword" },
      "scheduledAt": { "type": "date" },
      "sentAt":      { "type": "date" },
      "createdAt":   { "type": "date" },
      "error":       { "type": "text" }
    }
  }
}
```

`recipient` gets both a `text` field (partial/analyzed matching) and a `.raw` `keyword` sub-field (exact filters and sorting) — the same pattern applied consistently wherever a field needs both.

### 9.2 Dual-Write, Decoupled From the Send Path

Every DB write to `email_jobs` that changes status (insert on schedule, update on send/fail/defer) enqueues a small `index-email` job — `{ emailJobId }`, nothing heavier — onto its own BullMQ queue, consumed by the Index Worker. That worker reads the current row from Postgres and upserts it into ES by `id`, which makes the write idempotent: replaying the same index job twice (a retried job, a redelivered one) just overwrites with the same data.

This is deliberately **not** inline in the Send Worker's hot path. A slow or momentarily-unavailable Elasticsearch cluster should never add latency to sending an email or deciding its status — it can only ever add latency to *finding* that email in a search result a few seconds later. If the index job itself fails, BullMQ's own retry (a simpler, short fixed backoff — ES hiccups are usually transient infrastructure blips, not the SMTP failure taxonomy of §8.5) handles it without any special-casing in the Send Worker.

### 9.3 Read-Path Fallback

```mermaid
sequenceDiagram
    participant FE as Dashboard
    participant Q as Query Module
    participant ES as Elasticsearch
    participant DB as Postgres

    FE->>Q: GET /api/emails/scheduled?q=&status=&page=
    Q->>ES: Search (tenantId filter mandatory)
    alt ES healthy
        ES-->>Q: Results
    else ES error or timeout
        Q->>DB: Fallback query (indexed columns + ILIKE)
        DB-->>Q: Results
    end
    Q-->>FE: { items, page, pageSize, total }
```

The Query Module tries Elasticsearch first for `GET /api/emails/scheduled` and `GET /api/emails/sent`. On an ES error or timeout, it falls back to a direct Postgres query using the indexes from §6.2 (`idx_email_jobs_tenant_status`, plus a simple `ILIKE` on `recipient`/`subject` for the fallback's search term) rather than surfacing an error to the dashboard. This is the concrete answer to the risk of Elasticsearch/DB drift — the two are never allowed to disagree in a way the user can see, because the user-facing read always has a path back to the source of truth.

### 9.4 Reindex Worker — Drift Correction

A periodic full or partial reindex is exactly the kind of job it'd be easy to reach for `node-cron` on — and exactly what FR-7 prohibits. Instead it runs as a **BullMQ repeatable job** (e.g. every 15 minutes): still Redis-backed, still going through the same worker infrastructure as everything else, satisfying "no cron, anywhere" while still being periodic. It compares recently-updated DB rows (by `updated_at`) against their ES counterparts and re-indexes anything that's missing or stale — a second line of defense under the dual-write in §9.2, the same belt-and-suspenders pattern as the reconciler in §8.6. A manual full-reindex trigger (an admin-only endpoint) is also worth exposing for the rare case of standing up a new ES cluster or recovering from a larger drift.

### 9.5 Example Query — Scheduled View, Filtered and Paginated

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "tenantId": "<tenantId>" } },
        { "term": { "status": "scheduled" } },
        { "range": { "scheduledAt": { "gte": "<from>", "lte": "<to>" } } }
      ],
      "must": [
        { "multi_match": { "query": "<searchTerm>", "fields": ["subject", "recipient"] } }
      ]
    }
  },
  "sort": [{ "scheduledAt": "asc" }],
  "from": 0,
  "size": 25
}
```

`tenantId` is always a mandatory filter, never optional — it comes from the authenticated session server-side, never from a client-supplied parameter (§13).

---

## 10. API Specification

All responses share one error envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "recipient[3] is not a valid email address", "details": {} } }
```

### 10.1 Endpoint Reference

| Method & Path | Purpose | Auth | Satisfies |
|---|---|---|---|
| `GET /api/auth/google` | Begin Google OAuth flow | Public | FR-1 |
| `GET /api/auth/google/callback` | OAuth callback, issues session | Public | FR-1, FR-2 |
| `GET /api/auth/logout` | End session | Session | FR-3 |
| `GET /api/me` | Current user for header (name/email/avatar) | Session | FR-2 |
| `POST /api/emails/schedule` | Create a batch of scheduled emails | Session | FR-4–FR-6, FR-30 |
| `GET /api/emails/scheduled` | List/search scheduled emails | Session | FR-27, FR-28, FR-31 |
| `GET /api/emails/sent` | List/search sent emails | Session | FR-27, FR-28, FR-32 |
| `POST /api/integrations/slack/connect` | Begin Slack OAuth flow | Session | FR-22 |
| `GET /api/integrations/slack/callback` | Slack OAuth callback | Session | FR-22 |
| `DELETE /api/integrations/slack` | Disconnect Slack | Session | FR-24 |
| `GET /admin/queues` | Bull Board mount point — live queue UI | Session (admin) | FR-26 |

### 10.2 `POST /api/emails/schedule`

```json
// Request
{
  "senderId": "uuid",
  "subject": "string",
  "body": "string (HTML)",
  "recipients": ["a@example.com", "b@example.com"],
  "recipientListUploadId": "uuid | null",
  "startTime": "2026-09-10T10:00:00Z",
  "delayBetweenSendsMs": 3000,
  "hourlyLimit": 50,
  "attachments": [{ "filename": "brochure.pdf", "storageUrl": "https://..." }]
}

// Response — 202 Accepted
{
  "batchId": "uuid",
  "requestedCount": 214,
  "invalidCount": 3,
  "invalidSamples": ["not-an-email"]
}
```

`recipients` and `recipientListUploadId` are mutually exclusive — direct chip-entry or an uploaded CSV/text list, never both. `invalidCount`/`invalidSamples` is the "parsed-count feedback" FR-30 asks for, surfaced in the same round-trip so Compose can show it the moment scheduling completes.

### 10.3 `GET /api/emails/scheduled` and `GET /api/emails/sent`

```
GET /api/emails/scheduled?q=&status=&from=&to=&page=1&pageSize=25
```

```json
{
  "items": [
    {
      "id": "uuid",
      "recipient": "john@example.com",
      "subject": "Meeting follow-up",
      "status": "scheduled",
      "scheduledAt": "2026-09-10T09:15:12Z",
      "sentAt": null
    }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 12
}
```

Same shape for `/sent`, with `status` constrained to `sent | failed` and `sentAt` populated.

### 10.4 `GET /api/me`

```json
{ "id": "uuid", "name": "Oliver Brown", "email": "oliver.brown@domain.io", "avatarUrl": "https://..." }
```

### 10.5 Slack Integration Endpoints

Standard OAuth v2 redirect-and-callback pair, detailed in §12.2; `DELETE` clears the `slack_integrations` row for the tenant (FR-24's "not connected" state).

---

## 11. Frontend Architecture

The seven provided screenshots are the authoritative visual and behavioral reference for this phase (Appendix A, Q1). This section maps each one to a route and component set.

### 11.1 Routes

| Route | Screenshot(s) | Purpose |
|---|---|---|
| `/login` | 1 | Google OAuth entry point |
| `/` (tab state: `scheduled` \| `sent`) | 2, 3 | Dashboard shell — list view for whichever tab is active |
| `/emails/[id]` | 4 | Read-only detail view for a single email |
| `/compose` | 5, 6, 7 | New batch composition |

### 11.2 Screen-by-Screen Notes

| Screenshot | What it shows | Build notes |
|---|---|---|
| 1 — Login | "Login with Google" (primary), a divider, then email/password fields, then a solid "Login" button | Only the Google button is wired to a real handler (FR-1). The email/password fields render for visual parity but are `disabled` with no submit handler — no FR requires password auth. |
| 2 — Homepage / Scheduled | Sidebar with wordmark, user card, Compose CTA, `Scheduled` (active) and `Sent` nav items with counts. Main pane: search bar with filter/refresh icons, a list of rows (recipient, amber time pill, bold subject + preview, star toggle) | Nav counts are live aggregates (`COUNT(*) WHERE status='scheduled'` / `sent`), refetched whenever a job transitions so the badge never drifts from the list beneath it. |
| 3 — Sent | Same list layout, `Sent` tab active, pill reads "Sent" instead of a timestamp | FR-32 also requires a `failed` status here — the pill component needs a third visual state for it (§11.4). |
| 4 — Email detail | Back nav; star/archive/delete actions; sender avatar/name/email/date; formatted body with a callout block; two attachment cards | Build the *layout*, not the sample copy — the detail view renders our scheduled/sent emails, sender = the workspace user, recipient = the batch contact. Shares its body-renderer and attachment-card component with Compose. |
| 5 — Compose, default state | Header: back nav, title, paperclip/clock icons, solid "Send" button. Fields: `From` (sender dropdown), `To`, `Subject`, delay + hourly-limit numeric inputs, a rich-text body with formatting toolbar. The clock icon opens a "Send Later" popover: date/time picker + four quick presets + Cancel/Done | The two numeric pacing fields are treated as seconds and mapped to `delayBetweenSendsMs = value * 1000` client-side before hitting the §10.2 contract. |
| 6 — Compose, Send Later + attachment | Paperclip/clock icons show active (green) state; primary CTA swaps from solid "Send" to outlined "Send Later"; a new "Upload List" action appears beside `To`; an attached image renders as a thumbnail | The Send/Send Later CTA swap is state-driven off whether `sendLaterTime` is set, not two separate buttons. |
| 7 — Compose, bulk recipients | `To` holds removable chips plus a `+4` overflow chip (7 recipients from an uploaded list) | This is the CSV/list-upload result: parsing happens on `Upload List`, chips render per parsed address, and FR-30's parsed-count feedback surfaces as a small inline confirmation (e.g. "7 added, 0 skipped"). |

### 11.3 Component Tree

```text
AppShell
├── Sidebar
│   ├── Logo
│   ├── UserMenu            (avatar, name, email, dropdown -> Logout)
│   ├── ComposeButton       -> routes to /compose
│   └── NavList
│       ├── NavItem (Scheduled, count)
│       └── NavItem (Sent, count)
├── TopBar                  (SearchInput, FilterButton, RefreshButton)
├── EmailList                (used by / for both tabs)
│   └── EmailListRow x N    (recipient, StatusPill, subject + preview, StarToggle)
├── EmailDetail               (/emails/[id])
│   ├── DetailHeader          (back, star, archive, delete)
│   ├── SenderMeta            (avatar, name, email, date)
│   ├── BodyRenderer
│   └── AttachmentCard x N
└── ComposeForm               (/compose)
    ├── FromSelect
    ├── ToField                (ChipInput + UploadListAction)
    ├── SubjectInput
    ├── PacingInputs           (DelayInput, HourlyLimitInput)
    ├── RichTextEditor + Toolbar
    ├── AttachmentTray
    ├── SendLaterPopover        (DateTimePicker, PresetList, Cancel/Done)
    └── PrimaryCTA              (label: "Send" | "Send Later")
```

Every leaf here is its own typed component, props typed against the API contracts in §10 — satisfying FR-33's componentization/DRY/type requirement directly.

### 11.4 Data Fetching, Loading, Empty, and Error States

- List views (`EmailList`) fetch through the Query Module (§9.3) with `useSWR`/React Query keyed on `[tab, searchTerm, filters, page]`; a new row appears in Scheduled optimistically the moment `POST /api/emails/schedule` returns its `202` (using `requestedCount`), then reconciles against the real rows once async expansion finishes and the list re-fetches.
- **Loading** — skeleton rows matching the real row's shape (avatar-less placeholder, two shimmer bars), never a bare spinner, so the list doesn't visually jump when data arrives.
- **Empty** — Scheduled: "Nothing scheduled yet," with the Compose CTA restated inline; Sent: "Nothing sent yet." Both required explicitly by FR-31/FR-32.
- **Error** — a retry-affordant inline banner in the list pane, not a full-page failure — consistent with §9.3's principle that a backend hiccup should degrade, not break, the dashboard.
- **StatusPill** — three visual states: `scheduled` (amber, clock icon), `sent` (neutral/gray), and `failed` (red/error-toned — required by FR-32, not in the provided mocks, but a natural third state consistent with the amber/gray pair's saturation logic).

---

## 12. Third-Party Integrations

### 12.1 Google OAuth

Satisfies FR-1, FR-2, FR-3. Standard OAuth 2.0 authorization-code flow via `passport-google-oauth20` (or equivalent):

1. `GET /api/auth/google` redirects to Google's consent screen.
2. `GET /api/auth/google/callback` exchanges the code for a profile, upserts the `users` row (creating a `tenants` row on first login — §6.3), and issues a signed, `httpOnly`, `secure` session cookie.
3. The dashboard header reads `GET /api/me` to render name, email, and avatar.
4. `GET /api/auth/logout` clears the session and returns the user to `/login`.

No mocked auth path exists anywhere in the system — this is the only functional login mechanism (§11.2, Screenshot 1).

### 12.2 Slack Integration

Satisfies FR-22 through FR-25.

```mermaid
sequenceDiagram
    participant Admin as Workspace Admin
    participant FE as Dashboard
    participant INTEG as Integrations Module
    participant Slack as Slack OAuth / API
    participant DB as Postgres
    participant SW as Send Worker

    Admin->>FE: Click "Connect Slack"
    FE->>INTEG: POST /api/integrations/slack/connect
    INTEG->>Slack: Redirect to OAuth v2 authorize URL
    Slack-->>Admin: Consent screen
    Admin->>Slack: Approve (chat:write / webhook scope only)
    Slack->>INTEG: GET /api/integrations/slack/callback?code=...
    INTEG->>Slack: Exchange code for token / webhook URL
    INTEG->>DB: Upsert slack_integrations row for tenant

    Note over SW,DB: Later — a rate-limit breach occurs (§8.4, §8.7)
    SW->>DB: Read slack_integrations for tenant, at call time
    alt row exists
        SW->>Slack: chat.postMessage / webhook call
        Slack-->>SW: 200 OK, or a failure that is logged and swallowed
    else no row
        SW->>SW: Return immediately — no error, no log noise
    end
```

1. **Connect** — "Connect Slack" hits `POST /api/integrations/slack/connect`, which redirects into Slack's real OAuth v2 authorize URL, scoped no more broadly than the notification mechanism requires (`chat:write` or an incoming webhook).
2. **Callback** — `GET /api/integrations/slack/callback` exchanges the code for a token/webhook URL and upserts the `slack_integrations` row for the current tenant.
3. **Notify** — inside the Send Worker's rate-limit-breach branch, a thin `notifySlack(tenantId, message)` helper reads the tenant's token **at call time**, not at process-start — this is what makes FR-25 true (connecting Slack mid-session works immediately, no redeploy). If no row exists, it returns immediately with no error or log noise (FR-24). The actual API call is wrapped in try/catch; a failure (revoked token, Slack downtime) is logged at `warn` and swallowed, never thrown into the send path.
4. **Disconnect** — `DELETE /api/integrations/slack` deletes the row; the very next breach check finds nothing and behaves exactly like "never connected."

---

## 13. Security Architecture

- **Secrets at rest** — `senders.smtp_pass_encrypted` and `slack_integrations.access_token_encrypted` are application-level AES-GCM encrypted columns (key from a KMS or environment secret, never the DB itself); nothing SMTP- or Slack-credential-shaped ever reaches the Next.js client bundle.
- **Sessions** — a server-side session (signed, `httpOnly`, `secure`, `sameSite=lax` cookie) is issued after the Google OAuth callback; no token handling happens in client JS.
- **Tenant isolation** — every query in the Query, Schedule, and Integrations modules derives `tenantId` from the authenticated session server-side. It is never accepted as a client-supplied parameter — which is what makes the dual rate limiter in §8.4 trustworthy: a client can't claim a different tenant to dodge its cap.
- **Input validation** — every mutating endpoint is validated with Zod before touching the DB (FR-5); malformed or duplicate recipient addresses are deduplicated and reported back rather than silently dropped or silently accepted.
- **API-level throttling** — a lightweight per-IP/per-session rate limit on the API itself (e.g. `express-rate-limit`) guards against abuse of the schedule endpoint, distinct from and layered on top of the product's own per-sender/per-tenant email rate limiting.

---

## 14. Observability and Monitoring

Every job-lifecycle transition emits one structured (JSON) log line:

```json
{ "jobId": "...", "batchId": "...", "tenantId": "...", "senderId": "...", "fromStatus": "processing", "toStatus": "sent", "attempt": 1, "latencyMs": 842, "timestamp": "2026-09-10T09:15:12Z" }
```

This is the concrete shape behind the system's observability requirement, and it's what lets each success metric actually be measured:

| Success metric (§18) | How it's measured from this design |
|---|---|
| Scheduled sends executed within ±30s of intended window | Compare `scheduled_at` to the transition log's timestamp for `→ processing` |
| Duplicate sends after crash/restart = 0 | Nightly check: `email_jobs` grouped by `(batch_id, recipient)` having `status='sent'` count > 1 — should always return zero rows, given §6.2's unique index |
| Jobs lost after crash/restart = 0 | Compare pre-restart `scheduled` count to post-reconciliation `scheduled + processing + sent + failed` count — should be equal |
| Rate-limit correctness under concurrent workers | Count log lines where `toStatus=sent` in a given hour window, grouped by sender/tenant — should never exceed the configured cap, by construction of §8.4's atomic script |
| Dashboard p95 < 300ms | Standard API latency histograms on the Query Module's endpoints |

Bull Board (`/admin/queues`, FR-26) remains the primary **live** operational view — the structured logs are for after-the-fact analysis and alerting, not a replacement for it.

---

## 15. Deployment Architecture

Three deployable units, each independently scalable — matching the explicit non-goal of multi-region/geo-distributed workers this phase (§2.3).

```mermaid
flowchart TB
    Users(["Dashboard users"]) --> LB["Load Balancer"]

    subgraph APITier["API Tier — stateless, horizontally scaled"]
        API1["API instance 1"]
        API2["API instance 2"]
        APIn["API instance N"]
    end

    subgraph WorkerTier["Worker Tier — scale by instance count, not concurrency"]
        W1["Worker instance 1<br/>WORKER_CONCURRENCY"]
        W2["Worker instance 2<br/>WORKER_CONCURRENCY"]
        Wn["Worker instance N<br/>+ Reindex repeatable job"]
    end

    subgraph DataTier["Data Tier — single instance this phase"]
        PG[("Postgres<br/>standard backup/snapshot")]
        RD[("Redis<br/>AOF persistence enabled")]
        ESI[("Elasticsearch<br/>standard backup/snapshot")]
    end

    LB --> API1
    LB --> API2
    LB --> APIn
    API1 --> DataTier
    API2 --> DataTier
    APIn --> DataTier
    RD -.->|"delayed jobs become due"| WorkerTier
    WorkerTier --> DataTier
```

- **API** — stateless, horizontally scalable behind a load balancer.
- **Worker** — concurrency controlled entirely by `WORKER_CONCURRENCY` per instance (FR-16); scale by running more instances, not by raising one instance's concurrency indefinitely.
- **Reindex Worker's repeatable job** — lives inside the same worker process rather than as a fourth deployable unit.

Postgres, Redis, and Elasticsearch are each a single instance for this phase. Redis needs AOF persistence enabled at the infrastructure level (§7); Postgres and Elasticsearch need their standard backup/snapshot story, which this phase doesn't otherwise change.

`infra/docker-compose.yml` (§5) wires all five services — API, worker, web, Postgres, Redis, Elasticsearch — as the expected local-dev setup, so a developer can kill and restart the worker container mid-batch and watch reconciliation do its job: the best local proof of FR-10.

---

## 16. Testing Strategy

| Layer | What to test | How |
|---|---|---|
| Dual rate limiter | No breach under concurrency | Spin up N fake workers hammering the same sender+tenant pair in parallel past the cap; assert the sent count never exceeds either configured limit |
| Reconciliation | Restart-safety | Integration test: schedule a batch, `kill -9` the worker mid-send, restart, assert every job eventually reaches `sent` exactly once |
| Retry/backoff | Timing ladder is correct | Mock SMTP to fail transiently N times, assert retry timestamps land on the 30s/60s/120s (± jitter) ladder from §8.5 |
| Idempotency | Re-running is a no-op | POST the same schedule payload twice (simulating a retried client call); re-run the reconciler twice in a row; assert no duplicate `email_jobs` rows either time |
| Elasticsearch fallback | Dashboard survives ES being down | Point the Query Module at an unreachable ES host; assert `/api/emails/scheduled` still returns correct data from the Postgres fallback |
| Frontend | Loading/empty/error states render correctly for both tabs | Component tests against each `EmailList` state from §11.4, independent of a live backend |

---

## 17. Environment Variables Reference

Every limit in this design is environment-driven (FR-16, FR-18, FR-19) — nothing below is a hardcoded constant in application code.

| Variable | Purpose | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgres://...` |
| `REDIS_URL` | Redis connection string | `redis://...` |
| `ELASTICSEARCH_URL` | Elasticsearch endpoint | `http://...:9200` |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency (FR-16) | `10` |
| `MIN_DELAY_BETWEEN_SENDS_MS` | Default floor for delay-between-sends if a batch doesn't override it (FR-18) | `2000` |
| `MAX_EMAILS_PER_HOUR` | Tenant-wide hourly cap default (FR-19) | `500` |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Per-sender hourly cap default (FR-19) | `100` |
| `RETRY_MAX_ATTEMPTS` | Total attempts before `failed` (§8.5) | `4` |
| `RETRY_BASE_DELAYS_MS` | Backoff ladder (§8.5) | `30000,60000,120000` |
| `RETRY_JITTER_PCT` | Jitter as a fraction of base delay | `0.2` |
| `RECONCILE_LEASE_TIMEOUT_MS` | How long a `processing` lease is honored before reclaim (§8.6) | `300000` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth app config | — |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_REDIRECT_URI` | Slack OAuth app config | — |
| `SESSION_SECRET` | Session cookie signing key | — |
| `ATTACHMENT_STORAGE_BUCKET` | Object storage bucket for `batch_attachments` | — |

`.env.example` (repository root) mirrors this table directly:

```bash
# --- Data stores ---
DATABASE_URL=postgres://user:password@localhost:5432/reachinbox
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200

# --- Worker tuning (FR-16, FR-18, FR-19) ---
WORKER_CONCURRENCY=10
MIN_DELAY_BETWEEN_SENDS_MS=2000
MAX_EMAILS_PER_HOUR=500
MAX_EMAILS_PER_HOUR_PER_SENDER=100

# --- Retry / backoff (§8.5) ---
RETRY_MAX_ATTEMPTS=4
RETRY_BASE_DELAYS_MS=30000,60000,120000
RETRY_JITTER_PCT=0.2

# --- Reconciliation (§8.6) ---
RECONCILE_LEASE_TIMEOUT_MS=300000

# --- Google OAuth ---
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/google/callback

# --- Slack OAuth ---
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=http://localhost:3001/api/integrations/slack/callback

# --- Session & storage ---
SESSION_SECRET=
ATTACHMENT_STORAGE_BUCKET=
```

---

## 18. Non-Functional Requirements and Success Metrics

### 18.1 Non-Functional Requirements

| NFR | Statement |
|---|---|
| **Reliability** | No data loss and no duplicate execution across crashes/restarts. This is the single most important property of the system. |
| **Scalability** | Correct behavior under multiple concurrent workers and, eventually, multiple horizontally scaled instances. |
| **Security** | OAuth tokens and SMTP credentials stored server-side only, never in client bundles; secrets configured via environment, not source. |
| **Observability** | Structured logs for every job-lifecycle transition; the live dashboard as the primary operational view. |
| **Configurability** | Every limit (concurrency, delay, hourly cap) is environment-driven; nothing hardcoded. |
| **Maintainability** | Clear separation between the API layer, scheduling layer, and sending layer, so any one can be swapped later (Ethereal → SES, for instance) without touching the others. |

### 18.2 Success Metrics

| Metric | Target |
|---|---|
| Scheduled sends executed within their intended window | ≥ 99% within ±30s (excluding intentional rate-limit deferral) |
| Duplicate sends after a crash/restart | 0 |
| Jobs lost after a crash/restart | 0 |
| Time for scheduled work to resume automatically after restart | < 30s, zero manual intervention |
| Slack notification latency after a rate-limit breach | < 10s |
| Rate-limit correctness under concurrent workers | 0 breaches of the configured hourly cap |
| Dashboard list/search response time (Scheduled/Sent views) | p95 < 300ms |

### 18.3 Key Edge Cases

| Scenario | Required behavior |
|---|---|
| 1,000+ emails scheduled for the same moment | API returns immediately; jobs are created asynchronously and paced by the configured delay + hourly cap — never a synchronous blocking insert loop |
| Redis loses data (crash without persistence) | Boot-time reconciliation against the DB re-enqueues missing jobs; already-sent jobs are never touched |
| Worker crashes mid-send | Status flips to `sent` only after SMTP confirms; on redelivery, the worker checks DB status first so an already-sent job is never sent again |
| Two workers hit the hourly cap boundary simultaneously | Counter increment/check is atomic (Lua script) — no race lets both through |
| Slack token revoked or invalid | Notification attempt fails silently (logged, not thrown); the worker keeps sending normally |
| CSV contains duplicate or malformed addresses | Deduplicated and validated before scheduling; skipped rows are reported back to the user |

---

## 19. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rate-limit race conditions across workers | Sender exceeds its configured hourly cap; reputation risk | Atomic Redis-backed counters (Lua script), never in-memory counts (§8.4) |
| Redis data loss | Scheduled jobs silently disappear | Redis AOF persistence **and** DB-based reconciliation on boot as a second line of defense (§7, §8.6) |
| Elasticsearch/DB drift | Search results go stale or disagree with the source of truth | Dual-write with retry on index failure; periodic reindex job (§9.2, §9.4) |
| Slack API downtime | Missed throttle alerts | Fire-and-forget notification off the hot path; failures never block the send pipeline (§12.2) |
| Worker crash between SMTP ack and DB commit | A narrow window where a genuine duplicate send is possible | Window minimized (the DB write is the very next statement after SMTP returns); accepted as a residual risk this phase, closable later with an idempotent-send provider (§8.6) |

---

## 20. Build Roadmap

| Phase | Focus |
|---|---|
| 1 | DB schema, schedule API, BullMQ worker, Ethereal sending, restart reconciliation |
| 2 | Concurrency controls, delay-between-sends, hourly rate limiting, Slack OAuth + notifications |
| 3 | Elasticsearch indexing/search, Bull Board dashboard |
| 4 | Google OAuth, dashboard shell, Compose/Scheduled/Sent views against the reference screenshots |
| 5 | Loading/empty/error-state polish, README, demo video |

Read against §5's repository layout: Phase 1 stands up `apps/api` + `apps/worker` + `packages/db-schema`; Phase 2 fills in `worker/src/rateLimiter` and `modules/integrations/slack`; Phase 3 adds `worker/src/queues/indexQueue.ts` and `worker/src/processors/reindexWorker.ts`; Phase 4 builds out `apps/web` end to end; Phase 5 is cross-cutting polish across all three apps.

---

## 21. Requirements Traceability Matrix

| PRD subsection | Design section(s) in this document |
|---|---|
| Authentication | §12.1, §13 |
| Email Scheduling API | §8.2, §10 |
| Scheduling Engine (BullMQ + Redis) | §7, §8.2 |
| Restart Persistence and Recovery | §8.3, §8.6 |
| Sending | §4, §8.5 |
| Concurrency | §8.4, §17 |
| Delay Between Sends | §6.2 (`batches.delay_between_sends_ms`), §11.2 |
| Hourly Rate Limiting | §8.4, §8.7 |
| Slack Notifications | §12.2 |
| Live Queue Dashboard | §3.1 (Bull Board), §14 |
| Search (Elasticsearch) | §9 |
| Frontend — Shell | §11.1, §11.3 |
| Frontend — Compose | §10.2 (`schedule` contract), §11.2 (Screens 5–7) |
| Frontend — Scheduled/Sent Views | §9.3, §11.4 |
| Frontend Code Quality | §11.3 |
| Non-Functional Requirements | §13 (Security), §14 (Observability), §15 (Deployment), §17 (Configurability) |
| Open Questions (Q1–Q4) | Appendix A |

---

## 22. Glossary

- **BullMQ delayed job** — a job added to a Redis-backed queue with a future execution time, processed by a worker once that time arrives.
- **Idempotency (here)** — re-running the same scheduling or delivery logic twice never results in two emails being sent for the same logical job.
- **Hour window** — a fixed one-hour bucket (e.g. keyed by `YYYY-MM-DDTHH`) used to reset rate-limit counters.
- **Reconciliation** — the boot-time process of comparing DB-recorded intent against actual Redis queue state and correcting any gap.
- **Lease** — a time-bounded claim (`locked_at` / `locked_by`) a worker holds on a job while `processing`; expired leases are reclaimed automatically rather than requiring manual intervention.
- **Dual rate limit** — the requirement that a send clear both its sender's and its tenant's hourly cap, checked and incremented atomically together.
- **Deferral** — rescheduling a job to the next hour window when a rate limit is hit, as distinct from failing it.

---

## 23. Appendix A — Resolved Open Questions

The PRD left four questions open. Each is answered below with its concrete design consequence.

| # | Question | Decision | Designed in |
|---|---|---|---|
| Q1 | No Figma link was attached to the originating brief — where should the design be sourced from? | The **seven provided screenshots** (login; homepage/Scheduled; Sent; email detail; Compose + Send Later; Compose + Upload List; Compose + recipient chips) are the authoritative visual and behavioral reference for this phase. | §11 |
| Q2 | Should the hourly rate limit be per-sender, per-tenant, or both? | **Both, simultaneously and atomically.** A send is allowed only if it's within cap for *both* its sender and its tenant in the current hour window; if either is exhausted, the job defers. | §8.4 |
| Q3 | Does Elasticsearch power Scheduled/Sent directly, or sit alongside the DB? | **Alongside.** Postgres stays the single source of truth for job existence and status. Elasticsearch is a dual-written search/index layer the Query Module reads from for speed, with a same-request fallback to Postgres if ES is unavailable. | §9 |
| Q4 | What retry count and backoff curve for transient SMTP failures? | **4 total attempts**, exponential backoff 30s → 60s → 120s between attempts, ± jitter, retries applying only to transient failures — permanent failures go straight to `failed`. | §8.5 |

### A.1 Additional Gaps Surfaced While Reconciling the PRD Against the Screenshots

None of these are contradictions between the PRD and the screenshots — a static requirements document wouldn't capture every UI state — so each is treated as in-scope and flagged for a quick product confirmation rather than silently picking a side.

| Gap | Screenshots show | PRD says | Resolution |
|---|---|---|---|
| Attachments | A paperclip action in Compose; rendered image-attachment cards in Compose and in the email detail view | Compose lists subject, body, recipients, start time, delay, hourly limit — no mention of attachments | Treated as in-scope. Data model, API contract, and Compose component all include attachment support (§6, §10, §11). |
| Login form | A full email/password form beneath "Login with Google" | Google OAuth only, "no mocked auth" — no password-auth requirement anywhere | Google OAuth is the only *functional* path; the email/password fields render for visual fidelity but are disabled (§11.2). |
| Email detail view | A full read view (back nav; star/archive/delete; sender meta; formatted body; attachment cards) reachable from a list row | List columns only, not a detail view | Included as a route (§11.1). The layout is taken as spec; the sample copy is not — the detail view renders real scheduled/sent emails. |

---

*This document is the unified technical reference for the ReachInbox "Full-stack Email Job Scheduler," derived from PRD v1.0 and Technical Design Document v1.0 (both dated September 9, 2026). Section numbers in this document are independent of both source documents' own numbering; use the Requirements Traceability Matrix (§21) and Appendix A when cross-referencing.*
