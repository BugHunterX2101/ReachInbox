import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// Load the nearest .env walking up from cwd (pnpm runs apps with their own
// package dir as cwd; the repo root .env lives several levels up).
(function loadNearestEnv(): void {
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
})();

const intSchema = (def?: number) =>
  def === undefined
    ? z.coerce.number().int()
    : z.coerce.number().int().default(def);

const envSchema = z.object({
  // --- Data stores ---
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ELASTICSEARCH_URL: z.string().default("http://localhost:9200"),

  // --- Worker tuning (FR-16, FR-18, FR-19) ---
  WORKER_CONCURRENCY: intSchema(10),
  MIN_DELAY_BETWEEN_SENDS_MS: intSchema(2000),
  MAX_EMAILS_PER_HOUR: intSchema(500),
  MAX_EMAILS_PER_HOUR_PER_SENDER: intSchema(100),
  QUEUE_PREFIX: z.string().default("reachinbox"),

  // --- Retry / backoff ---
  RETRY_MAX_ATTEMPTS: intSchema(4),
  RETRY_BASE_DELAYS_MS: z.string().default("30000,60000,120000"),
  RETRY_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.2),

  // --- Reconciliation ---
  RECONCILE_LEASE_TIMEOUT_MS: intSchema(300_000),

  // --- Periodic jobs (BullMQ repeatable — never cron) ---
  REINDEX_INTERVAL_SECONDS: intSchema(900),
  MAINTENANCE_INTERVAL_SECONDS: intSchema(300),

  // --- Services ---
  PORT: intSchema(3001),
  WEB_URL: z.string().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 chars"),
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY must be 64 hex chars"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- Google OAuth (login stays real-OAuth-only: FR-1. Routes 503 with a
  // clear message when unconfigured; the rest of the engine still boots.) ---
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  // Empty => derived from the browser-facing origin per request (works whether
  // the dashboard is browsed via :3000 proxy or the API's :3001 directly).
  // Set it explicitly ONLY when behind a fixed public domain.
  GOOGLE_REDIRECT_URI: z.string().default(""),

  // --- Slack OAuth (same auto-derive policy as Google) ---
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_REDIRECT_URI: z.string().default(""),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Backoff ladder in ms, e.g. [30000, 60000, 120000] (§6.4). */
export function retryLadderMs(cfg: Pick<AppConfig, "RETRY_BASE_DELAYS_MS">): number[] {
  return cfg.RETRY_BASE_DELAYS_MS.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}
