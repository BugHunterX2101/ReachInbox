import { startWorkers, type RunningWorkers } from "./workers.js";

/**
 * Standalone worker process (the classic deployment: API and workers scale
 * independently). All logic lives in workers.ts — this file is just the
 * process wrapper with signal handling.
 */
let running: RunningWorkers | null = null;

async function main(): Promise<void> {
  running = await startWorkers();
  const shutdown = async () => {
    console.log("[worker] shutting down…");
    await running?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
