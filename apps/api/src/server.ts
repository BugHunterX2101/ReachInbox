import { createApp } from "./app.js";
import { runBootReconciler } from "./reconciler/bootReconciler.js";
import { getConfig } from "@reachinbox/config";

async function main(): Promise<void> {
  const cfg = getConfig();
  const { app } = createApp();

  // FR-9/FR-11: reconcile DB intent against Redis on every process start.
  try {
    await runBootReconciler();
  } catch (err) {
    // Never block startup on reconciliation — the maintenance job will catch up.
    console.error("[server] boot reconciler failed (will retry via maintenance):", err);
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
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
