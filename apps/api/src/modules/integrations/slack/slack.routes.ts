import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { requireAuth, type AuthedRequest } from "../../../middleware/requireAuth.js";
import { getConfig } from "@reachinbox/config";
import { redirectUriFor } from "../../../oauthRedirect.js";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackCode,
  storeSlackIntegration,
  getSlackStatus,
  disconnectSlack,
  isSlackConfigured,
} from "./slack.service.js";

export const slackRouter: Router = Router();

const SLACK_CALLBACK_PATH = "/api/integrations/slack/callback";

interface OauthSession {
  userId?: string;
  slackState?: string;
  slackRedirectUri?: string;
}

/** Explicit SLACK_REDIRECT_URI wins; otherwise derive from the browsing origin — shared policy. */
function slackRedirectUri(req: Parameters<typeof redirectUriFor>[0]): string {
  return redirectUriFor(req, SLACK_CALLBACK_PATH, getConfig().SLACK_REDIRECT_URI);
}

// GET /api/integrations/slack/connect → 302 into Slack's OAuth consent (FR-22).
// GET (not POST) so the dashboard can navigate the whole browser to it —
// the state cookie set here must survive the round-trip through Slack.
slackRouter.get("/connect", (req: Request, res: Response) => {
  if (!isSlackConfigured()) {
    res.status(503).json({
      error: {
        code: "INTERNAL_ERROR",
        message:
          "Slack OAuth is not configured — set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_REDIRECT_URI",
      },
    });
    return;
  }
  const redirectUri = slackRedirectUri(req);
  const state = randomBytes(16).toString("hex");
  (req.session as OauthSession).slackState = state;
  (req.session as OauthSession).slackRedirectUri = redirectUri;
  req.session.save(() => {
    res.redirect(302, buildSlackAuthorizeUrl(state, redirectUri));
  });
});

// GET /api/integrations/slack/callback — exchange + store (FR-22)
slackRouter.get("/callback", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = req.query["state"] as string | undefined;
    const expected = (req.session as OauthSession).slackState;
    if (!state || !expected || state !== expected) {
      res.redirect(`${getConfig().WEB_URL}/settings?slack=state_mismatch`);
      return;
    }
    (req.session as OauthSession).slackState = undefined;
    const code = req.query["code"] as string | undefined;
    if (!code) {
      res.redirect(`${getConfig().WEB_URL}/settings?slack=missing_code`);
      return;
    }
    // Slack rejects the exchange unless this matches the authorize-time URI exactly.
    const redirectUri = (req.session as OauthSession).slackRedirectUri ?? slackRedirectUri(req);
    (req.session as OauthSession).slackRedirectUri = undefined;
    const user = (req as AuthedRequest).user!;
    const token = await exchangeSlackCode(code, redirectUri);
    await storeSlackIntegration(user.tenantId, user.id, token);
    res.redirect(`${getConfig().WEB_URL}/settings?slack=connected`);
  } catch (err) {
    next(err);
  }
});

// GET /api/integrations/slack — status for the settings card
slackRouter.get("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthedRequest).user!;
    res.json(await getSlackStatus(user.tenantId));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/integrations/slack — disconnect (FR-24)
slackRouter.delete("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthedRequest).user!;
    await disconnectSlack(user.tenantId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
