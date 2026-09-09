#!/bin/sh
# Render preDeployCommand — runs before every deploy.
# Every step is idempotent: CREATE IF NOT EXISTS schema, upsert seed rows.
set -e

echo "[predeploy] applying database schema…"
node packages/db-schema/dist/scripts/migrate.js

echo "[predeploy] seeding default tenant + senders…"
node packages/db-schema/dist/scripts/seed.js

# Real Ethereal SMTP accounts (provisions via api.nodemailer.com on first run,
# cached in .ethereal-accounts.json which is NOT committed). Best-effort: a
# network blip here must not fail the deploy — sending falls back to whatever
# senders already exist.
echo "[predeploy] ensuring Ethereal senders…"
node packages/db-schema/dist/scripts/seedEthereal.js || echo "[predeploy] WARN: ethereal seed skipped (non-fatal)"

node packages/db-schema/dist/scripts/verifySenders.js || echo "[predeploy] WARN: sender verification skipped (non-fatal)"

echo "[predeploy] done."
