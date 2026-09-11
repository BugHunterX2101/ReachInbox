import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { Request } from "express";
import { getConfig } from "@reachinbox/config";

export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

/**
 * The browser-facing origin (proxy-aware): the origin the user's browser
 * actually sees. The dashboard browses at :3000 and the Next.js rewrite proxy
 * forwards X-Forwarded-Host/X-Forwarded-Proto, so the OAuth redirect_uri must
 * be derived from THAT origin — a hardcoded :3001 URI is exactly what caused
 * Google's `Error 400: redirect_uri_mismatch` when the app is used via :3000.
 */
export function browserOrigin(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    (req.secure ? "https" : "http");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ??
    req.headers.host ??
    "localhost:3001";
  return `${proto}://${host}`;
}

/**
 * Exact redirect_uri for this request. An explicitly configured
 * GOOGLE_REDIRECT_URI always wins (fixed public deployments); otherwise it is
 * derived from the browsing origin so local use works identically via the
 * :3000 dashboard proxy and the :3001 API directly.
 */
export function googleRedirectUri(req: Request): string {
  const cfg = getConfig();
  return cfg.GOOGLE_REDIRECT_URI || `${browserOrigin(req)}${GOOGLE_CALLBACK_PATH}`;
}

/** URIs that must be registered as Authorized redirect URIs in Google Cloud Console. */
export function expectedRedirectUris(): string[] {
  const cfg = getConfig();
  if (cfg.GOOGLE_REDIRECT_URI) return [cfg.GOOGLE_REDIRECT_URI];

  // The deployed flow derives redirect_uri per request from the browsing
  // origin, so the URIs that MUST be registered are the real ones this
  // deployment can actually send — not just localhost:
  //   - RENDER_EXTERNAL_URL: Render injects it into every web service; the
  //     callback when the API is browsed directly.
  //   - WEB_URL: the dashboard origin; the callback when login starts through
  //     the dashboard's /api proxy (the normal user path).
  // Plus the two local development origins.
  const uris = new Set<string>();
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) uris.add(`${externalUrl}${GOOGLE_CALLBACK_PATH}`);
  if (/^https?:\/\//.test(cfg.WEB_URL)) uris.add(`${cfg.WEB_URL}${GOOGLE_CALLBACK_PATH}`);
  uris.add(`http://localhost:3000${GOOGLE_CALLBACK_PATH}`);
  uris.add(`http://localhost:3001${GOOGLE_CALLBACK_PATH}`);
  return [...uris];
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
