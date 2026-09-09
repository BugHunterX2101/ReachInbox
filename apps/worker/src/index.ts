import { Worker } from "bullmq";
import {
  getConfig,
  EMAIL_SEND_QUEUE,
  EMAIL_INDEX_QUEUE,
  REINDEX_QUEUE,
  getBlockingConnection,
  getQueueConnection,
  closeRedis,
  backoffStrategy,
  runReconciler,
} from "@reachinbox/queues";
import { ensureEmailJobsIndex } from "@reachinbox/search";
import { processSendJob } from "./processors/sendWorker.js";
import { processIndexJob } from "./processors/indexWorker.js";
import { processReindexJob } from "./processors/reindexWorker.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  console.log("[worker] starting", {
    concurrency: cfg.WORKER_CONCURRENCY,
    retryMaxAttempts: cfg.RETRY_MAX_ATTEMPTS,
    leaseTimeoutMs: cfg.RECONCILE_LEASE_TIMEOUT_MS,
  });

  await ensureEmailJobsIndex();

  // FR-9/FR-11: reconcile DB intent against Redis on every worker start.
  try {
    await runReconciler();
  } catch (err) {
    console.error("[worker] boot reconciler failed:", err);
  }

  // ---- Send worker (FR-12–FR-21) ----
  const sendWorker = new Worker(
    EMAIL_SEND_QUEUE,
    async (job, token) => processSendJob(job, token),
    {
      connection: getBlockingConnection(),
      prefix: cfg.QUEUE_PREFIX,
      concurrency: cfg.WORKER_CONCURRENCY, // FR-16 — env-driven
      settings: {
        // Custom backoff ladder (§6.4): 30s → 60s → 120s ± jitter.
        backoffStrategy: (attemptsMade: number) => backoffStrategy(attemptsMade),
      },
    }
  );

  // ---- Index worker (FR-27) ----
  const indexWorker = new Worker(
    EMAIL_INDEX_QUEUE,
    async (job) => processIndexJob((job.data as { emailJobId: string }).emailJobId),
    {
      connection: getBlockingConnection(),
      prefix: cfg.QUEUE_PREFIX,
      concurrency: 5,
      settings: {
        backoffStrategy: () => 2000, // fixed retry for ES blips (§7.2)
      },
    }
  );

  // ---- Reindex repeatable (FR-7 — never cron) ----
  const reindexWorker = new Worker(
    REINDEX_QUEUE,
    async () => {
      const r = await processReindexJob();
      console.log("[reindex] drift correction pass:", r);
      return r;
    },
    {
      connection: getBlockingConnection(),
      prefix: cfg.QUEUE_PREFIX,
      concurrency: 1,
    }
  );

  const reindexQueue = (await import("@reachinbox/queues")).getReindexQueue();
  const existing = await reindexQueue.getRepeatableJobs();
  for (const j of existing) {
    await reindexQueue.removeRepeatableByKey(j.key);
  }
  await reindexQueue.add(
    "drift-correction",
    { trigger: "repeatable" },
    {
      repeat: { every: Math.max(60, cfg.REINDEX_INTERVAL_SECONDS) * 1000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { count: 100 },
    }
  );
  console.log(`[worker] reindex repeatable scheduled every ${cfg.REINDEX_INTERVAL_SECONDS}s`);

  // ---- Structured lifecycle logs (Observability NFR) ----
  for (const [name, w] of [
    ["send", sendWorker],
    ["index", indexWorker],
    ["reindex", reindexWorker],
  ] as const) {
    w.on("completed", (job) => {
      console.log(JSON.stringify({ event: "worker_completed", worker: name, jobId: job.id, timestamp: new Date().toISOString() }));
    });
    w.on("failed", (job, err) => {
      console.log(
        JSON.stringify({
          event: "worker_failed",
          worker: name,
          jobId: job?.id ?? null,
          error: err.message,
          timestamp: new Date().toISOString(),
        })
      );
    });
    w.on("error", (err) => {
      console.error(`[worker:${name}] error:`, err.message);
    });
  }

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    await Promise.allSettled([sendWorker.close(), indexWorker.close(), reindexWorker.close(), closeRedis()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
