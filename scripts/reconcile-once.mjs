// Runs one reconciliation pass (FR-9/FR-10/FR-11) against the live stack.
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(
  pathToFileURL(path.resolve(process.cwd(), "packages/queues/dist/reconciler.js")).href
);
const result = await mod.runReconciler();
console.log(JSON.stringify(result));
process.exit(0);
