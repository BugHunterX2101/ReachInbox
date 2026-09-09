/**
 * Boot reconciler (FR-9, FR-10, FR-11) — thin re-export of the shared
 * implementation in @reachinbox/queues, which the worker also runs on boot.
 */
export { runReconciler as runBootReconciler, type ReconcileResult } from "@reachinbox/queues";
