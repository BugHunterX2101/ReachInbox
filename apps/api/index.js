// Vercel serverless entry for the Express API.
// Sessions are stored server-side in Postgres (connect-pg-simple), so the
// function instance stays stateless and safe to scale horizontally.
import { createApp } from "./dist/app.js";
import { runBootReconciler } from "./dist/reconciler/bootReconciler.js";

const { app } = createApp();

// One reconcile pass per cold start: re-enqueues scheduled rows missing from
// Redis and reclaims stale processing leases (FR-9/10/11). Guarded by a Redis
// mutex inside runReconciler, so concurrent cold starts cannot double-run.
try {
  await runBootReconciler();
} catch (err) {
  console.error("[vercel] boot reconciler failed (maintenance will catch up):", err);
}

export default app;
