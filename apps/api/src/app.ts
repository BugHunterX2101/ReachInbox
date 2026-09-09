import express, { type Express } from "express";
import cors from "cors";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getConfig } from "@reachinbox/config";
import { getEmailSendQueue, getEmailIndexQueue, getReindexQueue } from "@reachinbox/queues";
import { getPool } from "@reachinbox/db-schema";
import { createSessionMiddleware } from "./session.js";
import { createApiRateLimiter } from "./middleware/apiRateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { scheduleRouter } from "./modules/schedule/schedule.routes.js";
import { queryRouter } from "./modules/query/query.routes.js";
import { slackRouter } from "./modules/integrations/slack/slack.routes.js";
import { attachmentsRouter } from "./modules/schedule/attachments.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { isGoogleConfigured, expectedRedirectUris } from "./modules/auth/googleOauth.js";

export function createApp(): { app: Express; serverAdapter: ExpressAdapter } {
  const cfg = getConfig();
  const app = express();

  app.set("trust proxy", 1);
  app.use(
    cors({
      origin: cfg.WEB_URL,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(createSessionMiddleware(getPool()));
  app.use(createApiRateLimiter());

  // --- Bull Board: live queue dashboard (FR-26) ---
  const serverAdapter = new ExpressAdapter();
  createBullBoard({
    queues: [
      new BullMQAdapter(getEmailSendQueue()),
      new BullMQAdapter(getEmailIndexQueue()),
      new BullMQAdapter(getReindexQueue()),
    ],
    serverAdapter: serverAdapter,
  });
  app.use("/admin/queues", requireAuth, serverAdapter.getRouter());

  // --- Health ---
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      googleConfigured: isGoogleConfigured(),
      // Diagnostics for `Error 400: redirect_uri_mismatch`: these are EXACTLY
      // the URIs that must be registered in Google Cloud Console.
      googleRedirectUris: expectedRedirectUris(),
    });
  });

  // --- Modules ---
  app.use("/api/auth", authRouter);
  app.use("/api/emails", scheduleRouter);
  app.use("/api/emails", queryRouter);
  app.use("/api/integrations/slack", slackRouter);
  app.use("/api/attachments", attachmentsRouter);

  // PRD §10.4 names /api/me as the current-user endpoint — serve it as a
  // first-class alias of /api/auth/me so both contract paths work (FR-2).
  app.get("/api/me", requireAuth, (req, res) => {
    const user = (req as import("./middleware/requireAuth.js").AuthedRequest).user!;
    res.json({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
  });

  app.use(errorHandler);
  return { app, serverAdapter };
}
