#!/bin/sh
# Render free instances don't run preDeployCommand, so the (idempotent) schema
# migration and seed run at boot instead — milliseconds against a warm DB.
set -e
if [ -f packages/db-schema/dist/scripts/migrate.js ]; then
  node packages/db-schema/dist/scripts/migrate.js
  node packages/db-schema/dist/scripts/seed.js
  node packages/db-schema/dist/scripts/seedEthereal.js \
    || echo "[boot] WARN: ethereal seed skipped (non-fatal — existing senders still serve)"
fi
