#!/bin/bash
# Build the v26 download package.
#
# Zips from a PARENT directory with the app folder name, so the archive has one
# top-level `equipment-rental-app/` entry. Zipping `.` from inside the app puts
# files at the archive root instead, which makes every path check below
# meaningless ("package.json" appears as "./package.json") and unpacks messily.
#
# Excluded: dependencies, build output, git, secrets, and my verification
# scripts. An earlier package was shipping stale debug scripts inside the zip,
# so the exclusions are asserted rather than assumed.
set -uo pipefail

SRC=/workspace/app
OUT=/workspace/documents/equipment-rental-package_v32
ZIP="$OUT/equipment-rental-app.zip"
TOP=equipment-rental-app

rm -rf "$OUT" /tmp/pkgstage
mkdir -p "$OUT" /tmp/pkgstage

# Stage a clean copy so no exclude glob can be defeated by a nested path.
mkdir -p "/tmp/pkgstage/$TOP"
cd "$SRC"
tar -cf - \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./dist' \
  --exclude='./.env' \
  --exclude='./shots*' \
  --exclude='./scripts/*.sh' \
  --exclude='./scripts/flow-*' \
  --exclude='./scripts/verify-*' \
  --exclude='./scripts/test-*' \
  --exclude='./scripts/probe-*' \
  --exclude='./scripts/diag-*' \
  --exclude='./scripts/pack-*' \
  --exclude='./scripts/track-*' \
  --exclude='./scripts/grant-*' \
  --exclude='./scripts/reset-*' \
  --exclude='./scripts/paste-*' \
  --exclude='./*.log' \
  . | tar -xf - -C "/tmp/pkgstage/$TOP"

cd /tmp/pkgstage
zip -r -q "$ZIP" "$TOP"

echo "--- must NOT be present ---"
for bad in 'node_modules/' '/\.env$' '/\.git/' 'dist/public' 'scripts/flow-' 'scripts/verify-' 'scripts/probe-' 'shots'; do
  n=$(unzip -l "$ZIP" | grep -cE "$bad" || true)
  printf "  %-22s %s\n" "$bad" "$n"
done

echo "--- must be present ---"
for good in "$TOP/package.json" "$TOP/drizzle/schema.ts" "$TOP/shared/contact-split.ts" \
            "$TOP/client/src/lib/destination-label.ts" "$TOP/client/src/pages/Tracking.tsx" \
            "$TOP/server/db.ts" "$TOP/scripts/check-journal.mjs" \
            "$TOP/scripts/replay-migrations.mjs" "$TOP/scripts/build-server.mjs" \
            "$TOP/drizzle/migrations/meta/_journal.json"; do
  if unzip -l "$ZIP" | grep -qE " $good$"; then echo "  OK       $good"; else echo "  MISSING  $good"; fi
done

echo "--- migration count in package ---"
unzip -l "$ZIP" | grep -cE "$TOP/drizzle/migrations/[0-9].*\.sql$"

echo "--- size ---"
ls -la "$ZIP"
unzip -l "$ZIP" | tail -1
