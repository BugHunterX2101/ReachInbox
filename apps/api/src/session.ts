import type { RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";
import { getConfig } from "@reachinbox/config";

const PgStore = connectPgSimple(session);

export function createSessionMiddleware(pool: Pool): RequestHandler {
  const cfg = getConfig();
  return session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    name: "reachinbox.sid",
    secret: cfg.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: "lax",
      maxAge: 7 * 24 * 3600 * 1000, // 7 days
    },
  });
}
