#!/bin/bash
# Build the v36 download package (SMS Pasal message-sending options).
#
# Zips from a PARENT directory with the app folder name, so the archive has one
# top-level `equipment-rental-app/` entry. Zipping `.` from inside the app puts
# files at the archive root instead, which makes every path check below
# meaningless ("package.json" appears as "./package.json") and unpacks messily.
#
# Excluded: dependencies, build output, git, secrets, and my verification
# scripts. The exclusions are asserted rather than assumed.
set -uo pipefail

SRC=/workspace/app
OUT=/workspace/documents/equipment-rental-package_v36
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
for bad in 'node_modules/' '/\.env$' '/\.git/' 'dist/public' 'scripts/flow-' 'scripts/verify-' 'scripts/probe-' 'shots' 'twilio'; do
  n=$(unzip -l "$ZIP" | grep -cE "$bad" || true)
  printf "  %-22s %s\n" "$bad" "$n"
done

echo "--- must be present ---"
for good in "$TOP/package.json" "$TOP/drizzle/schema.ts" \
            "$TOP/server/services/sms-pasal.ts" "$TOP/server/services/sms-pasal.test.ts" \
            "$TOP/server/services/order-sms.ts" "$TOP/server/services/bulk-sms.ts" \
            "$TOP/shared/sms.ts" \
            "$TOP/client/src/pages/SmsSettings.tsx" \
            "$TOP/client/src/components/SendMessageSection.tsx" \
            "$TOP/server/db.ts" "$TOP/server/routers.ts" \
            "$TOP/drizzle/migrations/meta/_journal.json"; do
  if unzip -l "$ZIP" | grep -qE "$good"; then echo "  OK       $good"; else echo "  MISSING  $good"; fi
done

echo "--- twilio-sms.ts must be GONE ---"
if unzip -l "$ZIP" | grep -qE "twilio-sms"; then echo "  STILL PRESENT (bad)"; else echo "  OK  absent"; fi

echo "--- message_settings migration must be present ---"
if unzip -l "$ZIP" | grep -qE "0016_.*\.sql$"; then echo "  OK  0016 present"; else echo "  MISSING 0016"; fi

echo "--- migration count in package ---"
unzip -l "$ZIP" | grep -cE "$TOP/drizzle/migrations/[0-9].*\.sql$"

echo "--- size ---"
ls -la "$ZIP"
unzip -l "$ZIP" | tail -1
