import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { getConfig } from "@reachinbox/config";
import { redirectUriFor, expectedUrisFor } from "../../oauthRedirect.js";

export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

/** Exact redirect_uri for this request — policy lives in apps/api/src/oauthRedirect.ts. */
export function googleRedirectUri(req: Parameters<typeof redirectUriFor>[0]): string {
  return redirectUriFor(req, GOOGLE_CALLBACK_PATH, getConfig().GOOGLE_REDIRECT_URI);
}

/** URIs that must be registered as Authorized redirect URIs in Google Cloud Console. */
export function expectedRedirectUris(): string[] {
  return expectedUrisFor(GOOGLE_CALLBACK_PATH, getConfig().GOOGLE_REDIRECT_URI);
}

export function isGoogleConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET);
}

// ---- PKCE (RFC 7636) — proof key for code exchange, S256 ----
export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
}
export function newPkce(): Pkce {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function newOauthState(): string {
  return randomBytes(16).toString("hex");
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Build Google's authorization URL (FR-1) with CSRF state, OIDC nonce, and
 * PKCE S256. The nonce/verifier/redirectUri live in the server-side session
 * and are re-checked at callback, so they cannot be tampered with client-side.
 */
export function buildGoogleAuthUrl(params: {
  state: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const cfg = getConfig();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  nonce: string | null;
}

interface TokenErrorResponse {
  error?: string;
  error_description?: string;
}

/**
 * Exchange the authorization code for tokens and extract the verified ID-token
 * profile. Uses the exact redirect_uri from the session and the PKCE verifier,
 * then verifies the id_token's signature (Google JWKS) and audience.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<GoogleProfile> {
  const cfg = getConfig();
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.GOOGLE_CLIENT_ID,
      client_secret: cfg.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await resp.json()) as { id_token?: string } & TokenErrorResponse;
  if (!resp.ok || !tokens.id_token) {
    throw new Error(
      `Google token exchange failed: ${tokens.error ?? resp.status}${
        tokens.error_description ? ` — ${tokens.error_description}` : ""
      }`,
    );
  }

  const client = new OAuth2Client(cfg.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: cfg.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google profile is missing required claims");
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email,
    avatarUrl: payload.picture ?? null,
    nonce: payload.nonce ?? null,
  };
}
