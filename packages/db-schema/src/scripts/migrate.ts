import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "../index.js";
import { loadRootEnv } from "../loadRootEnv.js";

loadRootEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, "../../schema.sql"), "utf8");
  const pool = getPool();
  await pool.query(sql);
  console.log("[migrate] schema applied");
  await closePool();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
