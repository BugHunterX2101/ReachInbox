import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Load the nearest .env walking up from cwd (pnpm runs scripts with the
 * package dir as cwd; the repo root .env lives several levels up).
 * In containers there is no .env file — env vars arrive via env_file and the
 * final default loadEnv() is a harmless no-op.
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      loadEnv({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnv();
}
