/**
 * ONE owner of OAuth redirect-URI policy (apps/api level — shared by the
 * Google and Slack features, which only add their fixed callback paths).
 *
 * Two consumers, one policy:
 *   1. Per request: the exact redirect_uri to send to the provider — an
 *      explicitly configured env URI always wins; otherwise derive from the
 *      origin the user's browser actually sees (proxy-aware via
 *      X-Forwarded-Host/Proto — the Next.js dashboard proxy forwards them, so
 *      login works identically via the dashboard or the API directly).
 *   2. Diagnostics: the URI set that must be registered in the provider's
 *      console (Google Cloud Console / Slack app settings). Derived from the
 *      SAME inputs so it can never drift from what the flow actually sends —
 *      this is the fix for the localhost-only list that caused the deployed
 *      `Error 400: redirect_uri_mismatch`.
 *
 * Pure functions + one thin Express adapter; no provider-specific knowledge.
 */
import type { Request } from "express";
import { getConfig } from "@reachinbox/config";

/** The origin the user's browser actually sees (proxy-aware). */
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

/** Callback URI this request would use for `callbackPath`: env override wins, else browsing origin. */
export function redirectUriFor(req: Request, callbackPath: string, configuredUri: string): string {
  return configuredUri || `${browserOrigin(req)}${callbackPath}`;
}

/**
 * Exact URIs that must be registered in the provider console for
 * `callbackPath`, derived from the same inputs the per-request policy uses:
 *   - RENDER_EXTERNAL_URL: the direct-API callback (Render injects it);
 *   - WEB_URL: the dashboard-proxy callback (the normal user path);
 *   - the two local development origins.
 * When an explicit env URI is configured, registration needs exactly that one.
 */
export function expectedUrisFor(callbackPath: string, configuredUri: string): string[] {
  if (configuredUri) return [configuredUri];
  const cfg = getConfig();
  const uris = new Set<string>();
  if (/^https?:\/\//.test(cfg.RENDER_EXTERNAL_URL)) {
    uris.add(`${cfg.RENDER_EXTERNAL_URL}${callbackPath}`);
  }
  if (/^https?:\/\//.test(cfg.WEB_URL)) {
    uris.add(`${cfg.WEB_URL}${callbackPath}`);
  }
  uris.add(`http://localhost:3000${callbackPath}`);
  uris.add(`http://localhost:3001${callbackPath}`);
  return [...uris];
}
