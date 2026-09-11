import { createApp } from "./app.js";
import { runReconciler } from "@reachinbox/queues";
import { getConfig } from "@reachinbox/config";
import type { RunningWorkers } from "@reachinbox/worker/workers";

async function main(): Promise<void> {
  const cfg = getConfig();
  const { app } = createApp();

  // FR-9/FR-11: reconcile DB intent against Redis on every process start.
  // (Shared implementation with the worker — no API-side shim.)
  try {
    await runReconciler();
  } catch (err) {
    // Never block startup on reconciliation — the maintenance job will catch up.
    console.error("[server] boot reconciler failed (will retry via maintenance):", err);
  }

  // Single-service deployment: run the BullMQ workers inside the API process
  // (WORKER_INPROCESS=true, e.g. one always-on Render web service). Same
  // processors as the standalone worker — no duplicated logic.
  let workers: RunningWorkers | null = null;
  if (cfg.WORKER_INPROCESS) {
    const { startWorkers } = await import("@reachinbox/worker/workers");
    workers = await startWorkers();
    console.log("[server] workers running in-process (WORKER_INPROCESS=true)");
  }

  // Some CI/sandbox shells export PORT=0; never bind to an invalid port.
  const port = Number.isInteger(cfg.PORT) && cfg.PORT > 0 ? cfg.PORT : 3001;
  if (port !== cfg.PORT) {
    console.warn(`[server] PORT=${cfg.PORT} from environment is invalid — falling back to :${port}`);
  }
  app.listen(port, () => {
    console.log(`[server] API listening on :${port}`);
    console.log(`[server] Bull Board at ${cfg.WEB_URL.replace(/\/$/, "")}/admin/queues (via API :${port}/admin/queues)`);
  });

  const shutdown = async () => {
    console.log("[server] shutting down…");
    await workers?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
