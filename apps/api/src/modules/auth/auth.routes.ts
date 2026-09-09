import { Router, type Request, type Response, type NextFunction } from "express";
import { getConfig } from "@reachinbox/config";
import { ApiError } from "../../middleware/errorHandler.js";
import { requireAuth, type AuthedRequest } from "../../middleware/requireAuth.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleRedirectUri,
  isGoogleConfigured,
  newNonce,
  newOauthState,
  newPkce,
} from "./googleOauth.js";
import { upsertUserFromGoogle } from "./auth.service.js";

export const authRouter: Router = Router();

interface OauthSession {
  userId?: string;
  oauthState?: string;
  oauthNonce?: string;
  oauthVerifier?: string;
  oauthRedirectUri?: string;
}

/** Human-readable reasons surfaced on the login screen via ?authError=… */
function authErrorRedirect(res: Response, code: string, detail?: string): void {
  const cfg = getConfig();
  const url = new URL(`${cfg.WEB_URL}/login`);
  url.searchParams.set("authError", code);
  if (detail) url.searchParams.set("authErrorDetail", detail.slice(0, 200));
  res.redirect(url.toString());
}

// GET /api/auth/google — begin the OAuth flow (FR-1)
authRouter.get("/google", (req: Request, res: Response) => {
  if (!isGoogleConfigured()) {
    res.status(503).json({
      error: {
        code: "INTERNAL_ERROR",
        message:
          "Google OAuth is not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI",
      },
    });
    return;
  }
  // Bind everything the callback must re-validate to the server-side session:
  // CSRF state, OIDC nonce, PKCE verifier, and the exact redirect_uri used.
  const redirectUri = googleRedirectUri(req);
  const state = newOauthState();
  const nonce = newNonce();
  const pkce = newPkce();
  (req.session as OauthSession).oauthState = state;
  (req.session as OauthSession).oauthNonce = nonce;
  (req.session as OauthSession).oauthVerifier = pkce.codeVerifier;
  (req.session as OauthSession).oauthRedirectUri = redirectUri;
  req.session.save(() => {
    res.redirect(
      buildGoogleAuthUrl({
        state,
        redirectUri,
        nonce,
        codeChallenge: pkce.codeChallenge,
      }),
    );
  });
});

// GET /api/auth/google/callback — exchange code, upsert user, issue session (FR-1, FR-2)
authRouter.get("/google/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = req.session as OauthSession;

    // Google redirects here with ?error=… when the user denies consent or the
    // request is rejected — never treat that as a 500; send the user back to
    // the login screen with a readable banner.
    const googleError = req.query["error"] as string | undefined;
    if (googleError) {
      const desc = req.query["error_description"] as string | undefined;
      authErrorRedirect(res, googleError, desc);
      return;
    }

    const state = req.query["state"] as string | undefined;
    const expected = session.oauthState;
    if (!state || !expected || state !== expected) {
      authErrorRedirect(res, "state_mismatch", "Restart the login flow — the session may have expired.");
      return;
    }
    session.oauthState = undefined;

    const code = req.query["code"] as string | undefined;
    if (!code) {
      authErrorRedirect(res, "missing_code");
      return;
    }

    const redirectUri = session.oauthRedirectUri ?? googleRedirectUri(req);
    const verifier = session.oauthVerifier ?? "";
    const nonce = session.oauthNonce;
    session.oauthVerifier = undefined;
    session.oauthNonce = undefined;
    session.oauthRedirectUri = undefined;

    const profile = await exchangeGoogleCode(code, redirectUri, verifier);
    // OIDC replay guard: the nonce we sent must come back inside the id_token.
    if (nonce && profile.nonce && profile.nonce !== nonce) {
      authErrorRedirect(res, "nonce_mismatch");
      return;
    }
    const user = await upsertUserFromGoogle(profile);
    session.userId = user.id;
    req.session.save(() => {
      res.redirect(`${getConfig().WEB_URL}/`);
    });
  } catch (err) {
    // Token exchange failures (redirect_uri_mismatch, expired code, PKCE
    // mismatch) surface as a readable login banner instead of a dead 400 page.
    const message = (err as Error).message ?? "";
    if (/Google token exchange failed|redirect_uri_mismatch|invalid_grant/i.test(message)) {
      authErrorRedirect(res, "token_exchange_failed", message);
      return;
    }
    next(err);
  }
});

// GET /api/auth/logout — end session (FR-3)
authRouter.get("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie("reachinbox.sid");
    res.redirect(`${getConfig().WEB_URL}/login`);
  });
});

// GET /api/auth/me — current user for the header (FR-2)
authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  res.json({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
});
