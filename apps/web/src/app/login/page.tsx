"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google sign-in was cancelled. Please try again and approve the consent screen.",
  state_mismatch:
    "Your session expired during sign-in. Click “Login with Google” again to restart it.",
  missing_code: "Google did not return an authorization code. Please retry the sign-in.",
  nonce_mismatch: "Sign-in could not be verified (nonce mismatch). Please retry.",
  token_exchange_failed:
    "Google rejected the sign-in exchange. If this says redirect_uri_mismatch, add this exact callback URL in Google Cloud Console → Credentials → Authorized redirect URIs (check /api/health → googleRedirectUris).",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const [checking, setChecking] = useState(true);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [redirectUris, setRedirectUris] = useState<string[] | null>(null);
  const searchParams = useSearchParams();
  const authError = searchParams.get("authError");
  const authErrorDetail = searchParams.get("authErrorDetail");

  useEffect(() => {
    // Already signed in? Go straight to the dashboard.
    api
      .me()
      .then(() => {
        window.location.href = "/";
      })
      .catch(() => {
        setChecking(false);
        // If Google OAuth isn't configured the login button can't work —
        // surface that honestly instead of a dead button, and show the exact
        // redirect URIs that must be registered when the flow was rejected.
        fetch("/api/health")
          .then((r) => r.json())
          .then((h) => {
            setAuthConfigured(h.googleConfigured !== false);
            setRedirectUris(h.googleRedirectUris ?? null);
          })
          .catch(() => setAuthConfigured(true));
      });
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 via-white to-gray-100 px-4">
      <div className="w-full max-w-md">
        {authError && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            <p className="font-medium">Sign-in problem</p>
            <p className="mt-1">{AUTH_ERROR_MESSAGES[authError] ?? `Google returned: ${authError}`}</p>
            {authErrorDetail && <p className="mt-1 text-xs text-amber-700 break-words">{authErrorDetail}</p>}
            {authError === "token_exchange_failed" && redirectUris && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {redirectUris.map((u) => (
                  <li key={u} className="break-all">{u}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-brand-500 text-white font-bold text-xl mb-3">
            R
          </div>
          <h1 className="text-2xl font-bold tracking-tight">ReachInbox</h1>
          <p className="text-sm text-gray-500 mt-1">Email Job Scheduler &amp; Dashboard</p>
        </div>

        <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-8">
          <a
            href={authConfigured ? "/api/auth/google" : "#"}
            aria-disabled={!authConfigured}
            onClick={(e) => {
              if (!authConfigured) e.preventDefault();
            }}
            className={`flex items-center justify-center gap-3 w-full rounded-xl px-4 py-3 font-medium transition
              ${
                authConfigured
                  ? "bg-brand-600 text-white hover:bg-brand-700 shadow-sm"
                  : "bg-gray-200 text-gray-500 cursor-not-allowed"
              }`}
          >
            <GoogleIcon />
            Login with Google
          </a>
          {!authConfigured && (
            <p className="text-xs text-amber-600 mt-3 text-center">
              Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
              in the API&apos;s environment.
            </p>
          )}

          <div className="flex items-center gap-3 my-6">
            <div className="h-px bg-gray-200 flex-1" />
            <span className="text-xs text-gray-400 uppercase tracking-wide">or</span>
            <div className="h-px bg-gray-200 flex-1" />
          </div>

          {/* Visual parity with screenshot 1; password auth is out of scope (FR-1, no mocked auth). */}
          <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                disabled
                placeholder="you@company.com"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-400 cursor-not-allowed"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                disabled
                placeholder="••••••••"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-400 cursor-not-allowed"
              />
            </div>
            <button
              type="submit"
              disabled
              className="w-full rounded-xl bg-brand-600/50 text-white/70 font-medium px-4 py-3 cursor-not-allowed"
            >
              Login
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          {checking ? "Checking session…" : "Authentication is handled via Google OAuth 2.0"}
        </p>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#fff"
        d="M24 9.5c3.54 0 6.7 1.22 9.19 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#fff"
        opacity=".8"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#fff"
        opacity=".6"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#fff"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
