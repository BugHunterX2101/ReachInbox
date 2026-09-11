/**
 * Render deployment orchestrator — idempotent + resumable.
 *
 * Usage:
 *   DEPLOY_FROM_ENV=1 RENDER_API_KEY=rnd_xxx node scripts/render-deploy.mjs stores    # ensure KV (+optional PG), wait ready
 *   DEPLOY_FROM_ENV=1 RENDER_API_KEY=rnd_xxx node scripts/render-deploy.mjs services  # ensure both services (Neon DATABASE_URL from .env), wait live
 *   RENDER_API_KEY=rnd_xxx node scripts/render-deploy.mjs verify    # hit /api/health, print OAuth URIs
 *   RENDER_API_KEY=rnd_xxx node scripts/render-deploy.mjs status    # one-line state of all resources
 *
 * Every phase discovers existing resources by name first, so re-running is safe.
 */
const API = "https://api.render.com/v1";
const KEY = process.env.RENDER_API_KEY;
if (!KEY) throw new Error("RENDER_API_KEY is required");

const OWNER = "tea-d2l0nsjipnbc73fnaegg"; // careerconnect team (from /owners)
const REPO = "https://github.com/BugHunterX2101/ReachInbox";
const REGION = "oregon";

// Names are the idempotency keys — phases match resources by these.
const PG_NAME = "reachinbox-db";
const KV_NAME = "reachinbox-kv";
const API_NAME = "reachinbox-api";
const WEB_NAME = "reachinbox-web";

// Ephemeral state (resource IDs, generated secrets) lives in .render-state.json
// which is gitignored — this script itself stays secret-free and committable.
import fs from "node:fs";
const STATE_FILE = ".render-state.json";
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(patch) {
  const state = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 300);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAll(path, key) {
  const page = await api("GET", path);
  const itemKey = key === "services" ? "service" : key;
  return (Array.isArray(page) ? page : page[key] ?? []).map((x) => x[itemKey] ?? x);
}

async function findByName(path, key, name) {
  const items = await listAll(path, key);
  return items.find((i) => i?.name === name) ?? null;
}

async function waitFor(desc, id, statusPath, ready, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await api("GET", statusPath);
    if (ready(r)) return r;
    console.log(`  … waiting for ${desc} (${Math.round((Date.now() - start) / 1000)}s)`);
    await sleep(10000);
  }
  throw new Error(`timeout waiting for ${desc}`);
}

// ---------- phase: stores ----------
async function ensureStores() {
  let pg = await findByName("/postgres?limit=100", "postgres", PG_NAME);
  if (!pg) {
    console.log("creating Postgres (free)…");
    const created = await api("POST", "/postgres", {
      name: PG_NAME,
      ownerId: OWNER,
      plan: "free",
      version: "16",
      region: REGION,
      databaseName: "reachinbox",
      databaseUser: "reachinbox",
    });
    pg = created;
  } else {
    console.log("Postgres exists:", pg.id);
  }
  console.log("waiting for Postgres to be available…");
  await waitFor("postgres", pg.id, `/postgres/${pg.id}`, (r) => r.status === "available", 15 * 60_000);

  let kv = await findByName("/redis?limit=100", "redis", KV_NAME);
  if (!kv) {
    console.log("creating Key Value (free)…");
    kv = await api("POST", "/redis", {
      name: KV_NAME,
      ownerId: OWNER,
      plan: "free",
      region: REGION,
      maxmemoryPolicy: "noeviction",
    });
  } else {
    console.log("Key Value exists:", kv.id);
  }
  console.log("waiting for Key Value to be available…");
  await waitFor("keyvalue", kv.id, `/redis/${kv.id}`, (r) => r.status === "available", 15 * 60_000);

  const state = loadState();
  state.pgId = pg.id;
  state.kvId = kv.id;
  saveState(state);
  console.log("stores ready:", state.pgId, state.kvId);
}

// ---------- phase: services ----------
// Secrets come from the environment (never hardcoded — this file is committed).
// Convenience: DEPLOY_FROM_ENV=1 pulls Google creds + session secret from the
// local .env (local dev and deployed share the same Google OAuth client).
if (process.env.DEPLOY_FROM_ENV === "1") {
  const readEnv = (k) => {
    const m = fs.readFileSync(".env", "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
    return m?.[1]?.trim();
  };
  process.env.DEPLOY_GOOGLE_CLIENT_ID ??= readEnv("GOOGLE_CLIENT_ID");
  process.env.DEPLOY_GOOGLE_CLIENT_SECRET ??= readEnv("GOOGLE_CLIENT_SECRET");
  process.env.DEPLOY_SESSION_SECRET ??= readEnv("SESSION_SECRET");
  process.env.DEPLOY_ENCRYPTION_KEY ??= readEnv("ENCRYPTION_KEY");
  process.env.DEPLOY_SLACK_CLIENT_ID ??= readEnv("SLACK_CLIENT_ID");
  process.env.DEPLOY_SLACK_CLIENT_SECRET ??= readEnv("SLACK_CLIENT_SECRET");
  process.env.DEPLOY_DATABASE_URL ??= readEnv("DATABASE_URL");
}
const ENCRYPTION_KEY = process.env.DEPLOY_ENCRYPTION_KEY;
const GOOGLE_CLIENT_ID = process.env.DEPLOY_GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.DEPLOY_GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.DEPLOY_SESSION_SECRET;
const SLACK_CLIENT_ID = process.env.DEPLOY_SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.DEPLOY_SLACK_CLIENT_SECRET;

const API_SERVICE_ENV = [
  { key: "NODE_VERSION", value: "22" }, // pnpm 11 requires node:sqlite (Node ≥22.13)
  { key: "WORKER_INPROCESS", value: "true" },
  { key: "COOKIE_SECURE", value: "true" },
  { key: "ATTACHMENT_DATA_DIR", value: "/tmp/attachments" },
  { key: "ELASTICSEARCH_URL", value: "disabled" }, // PG fallback mode (§7.3)
  { key: "ENCRYPTION_KEY", value: ENCRYPTION_KEY },
  { key: "GOOGLE_CLIENT_ID", value: GOOGLE_CLIENT_ID },
  { key: "GOOGLE_CLIENT_SECRET", value: GOOGLE_CLIENT_SECRET },
  { key: "SLACK_CLIENT_ID", value: SLACK_CLIENT_ID },
  { key: "SLACK_CLIENT_SECRET", value: SLACK_CLIENT_SECRET },
];

function webServiceEnv(apiUrl, webUrl) {
  return [
    { key: "NODE_VERSION", value: "22" },
    { key: "API_INTERNAL_URL", value: apiUrl },
    { key: "NEXT_PUBLIC_API_URL", value: apiUrl },
    { key: "WEB_URL", value: webUrl },
  ];
}

function apiServiceBody(envVars) {
  return {
    type: "web_service",
    name: API_NAME,
    ownerId: OWNER,
    repo: REPO,
    branch: "main",
    autoDeploy: "yes",
    rootDir: "",
    serviceDetails: {
      runtime: "node",
      plan: "free",
      region: REGION,
      envSpecificDetails: {
        buildCommand: "npx --yes pnpm@11.10.0 install --frozen-lockfile && npx --yes pnpm@11.10.0 --filter=!@reachinbox/web build",
        startCommand: "sh infra/render/boot-setup.sh && node apps/api/dist/server.js",
      },
      preDeployCommand: "sh infra/render/predeploy.sh",
      healthCheckPath: "/api/health",
    },
    envVars,
  };
}

function webServiceBody(envVars) {
  return {
    type: "web_service",
    name: WEB_NAME,
    ownerId: OWNER,
    repo: REPO,
    branch: "main",
    autoDeploy: "yes",
    rootDir: "",
    serviceDetails: {
      runtime: "node",
      plan: "free",
      region: REGION,
      envSpecificDetails: {
        buildCommand:
          "npx --yes pnpm@11.10.0 install --frozen-lockfile && npx --yes pnpm@11.10.0 --filter @reachinbox/shared-types build && npx --yes pnpm@11.10.0 --filter @reachinbox/web build",
        startCommand: "pnpm --filter @reachinbox/web start",
      },
      healthCheckPath: "/",
    },
    envVars,
  };
}

async function ensureServices() {
  if (!ENCRYPTION_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
    throw new Error("set DEPLOY_ENCRYPTION_KEY, DEPLOY_GOOGLE_CLIENT_ID, DEPLOY_GOOGLE_CLIENT_SECRET, DEPLOY_SESSION_SECRET (or DEPLOY_FROM_ENV=1 with a local .env)");
  }
  const state = loadState();
  // Postgres is external Neon (render.yaml policy): DEPLOY_DATABASE_URL wins;
  // fall back to a Render-managed PG only when one was provisioned by `stores`.
  let databaseUrl = process.env.DEPLOY_DATABASE_URL;
  if (!databaseUrl) {
    if (!state.pgId) throw new Error("set DEPLOY_DATABASE_URL (Neon) or run the `stores` phase");
    const pgConn = await api("GET", `/postgres/${state.pgId}/connection-info`);
    databaseUrl = pgConn.internalConnectionString;
  }
  const kvConn = await api("GET", `/redis/${state.kvId}/connection-info`);
  const redisUrl = kvConn.internalConnectionString;
  console.log("got store connection strings");

  const services = await listAll("/services?limit=100", "services");
  const existing = new Map(services.map((s) => [s.name, s]));

  // Service URLs follow the pattern https://<name>.onrender.com — confirm after create.
  const apiUrlGuess = `https://${API_NAME}.onrender.com`;
  const webUrlGuess = `https://${WEB_NAME}.onrender.com`;

  const apiEnv = [
    ...API_SERVICE_ENV,
    { key: "DATABASE_URL", value: databaseUrl },
    { key: "REDIS_URL", value: redisUrl },
    { key: "SESSION_SECRET", value: SESSION_SECRET },
    { key: "WEB_URL", value: webUrlGuess },
  ];

  if (!existing.has(API_NAME)) {
    console.log("creating API service…");
    const created = await api("POST", "/services", apiServiceBody(apiEnv));
    existing.set(API_NAME, created.service ?? created);
    console.log("API service created:", (created.service ?? created).id);
  } else {
    console.log("API service exists:", existing.get(API_NAME).id);
  }

  if (!existing.has(WEB_NAME)) {
    console.log("creating web service…");
    const created = await api("POST", "/services", webServiceBody(webServiceEnv(apiUrlGuess, webUrlGuess)));
    existing.set(WEB_NAME, created.service ?? created);
    console.log("web service created:", (created.service ?? created).id);
  } else {
    console.log("web service exists:", existing.get(WEB_NAME).id);
  }

  const apiId = existing.get(API_NAME).id;
  const webId = existing.get(WEB_NAME).id;
  // Real URLs carry suffix slugs — read them back instead of guessing.
  const apiSvc = await api("GET", `/services/${apiId}`);
  const webSvc = await api("GET", `/services/${webId}`);
  const apiUrl = apiSvc.serviceDetails?.url;
  const webUrl = webSvc.serviceDetails?.url;
  saveState({ apiId, webId, apiUrl, webUrl });
  console.log(`services registered — api=${apiUrl} web=${webUrl}`);
  console.log("NOTE: env vars with the guessed URLs need the `env` phase to correct them");
}

// ---------- phase: env (correct cross-service URLs after real slugs are known) ----------
async function fixEnv() {
  const state = loadState();
  if (!state.apiId || !state.webId || !state.apiUrl || !state.webUrl) throw new Error("run `services` first");

  let databaseUrl = process.env.DEPLOY_DATABASE_URL;
  if (!databaseUrl) {
    if (!state.pgId) throw new Error("set DEPLOY_DATABASE_URL (Neon) or run the `stores` phase");
    const pgConn = await api("GET", `/postgres/${state.pgId}/connection-info`);
    databaseUrl = pgConn.internalConnectionString;
  }
  const kvConn = await api("GET", `/redis/${state.kvId}/connection-info`);

  const apiEnv = [
    ...API_SERVICE_ENV,
    { key: "DATABASE_URL", value: databaseUrl },
    { key: "REDIS_URL", value: kvConn.internalConnectionString },
    { key: "SESSION_SECRET", value: SESSION_SECRET },
    { key: "WEB_URL", value: state.webUrl },
  ];
  await api("PUT", `/services/${state.apiId}/env-vars`, apiEnv);
  console.log("API env vars set (WEB_URL →", state.webUrl + ")");

  await api("PUT", `/services/${state.webId}/env-vars`, webServiceEnv(state.apiUrl, state.webUrl));
  console.log("web env vars set (API_INTERNAL_URL →", state.apiUrl + ")");

  // Env changes don't auto-deploy — trigger a fresh deploy on each service.
  for (const [id, label] of [[state.apiId, "api"], [state.webId, "web"]]) {
    const d = await api("POST", `/services/${id}/deploys`, {});
    const dep = d.deploy ?? d;
    console.log(`triggered ${label} deploy:`, dep.id);
  }
}

// ---------- phase: verify ----------
async function verify() {
  const state = loadState();
  if (!state.apiId) throw new Error("run `services` first");
  const apiSvc = await api("GET", `/services/${state.apiId}`);
  const webSvc = await api("GET", `/services/${state.webId}`);
  console.log("API:", apiSvc.serviceDetails?.url ?? state.apiUrl, "status:", apiSvc.status ?? apiSvc.suspended);
  console.log("WEB:", webSvc.serviceDetails?.url ?? state.webUrl, "status:", webSvc.status ?? webSvc.suspended);

  const url = apiSvc.serviceDetails?.url ?? state.apiUrl;
  console.log("hitting /api/health …");
  const res = await fetch(`${url}/api/health`, { redirect: "manual" });
  const body = await res.json().catch(() => null);
  console.log("health:", res.status, JSON.stringify(body));
  if (body?.googleRedirectUris) {
    console.log("\nRegister these in Google Cloud Console → Authorized redirect URIs:");
    for (const u of body.googleRedirectUris) console.log("  " + u);
  }
}

const phase = process.argv[2];
if (phase === "stores") await ensureStores();
else if (phase === "services") await ensureServices();
else if (phase === "env") await fixEnv();
else if (phase === "verify") await verify();
else if (phase === "status") {
  const s = loadState();
  console.log(JSON.stringify(s, null, 2));
} else {
  console.log("phases: stores | services | env | verify | status");
}
