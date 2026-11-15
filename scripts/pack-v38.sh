#!/bin/bash
# Build the v38 download package (SMS Pasal env config + exact provider-error surfacing).
#
# Zips from a PARENT directory with the app folder name, so the archive has one
# top-level `equipment-rental-app/` entry. Zipping `.` from inside the app puts
# files at the archive root instead, which makes every path check below
# meaningless ("package.json" appears as "./package.json") and unpacks messily.
#
# Excluded: dependencies, build output, git, secrets, and my verification
# scripts. The exclusions are asserted rather than assumed.
#
# NOTE on the checks: `unzip -l "$ZIP" | grep -q ...` is NOT used. Under
# `set -o pipefail`, grep -q exits at the first match, unzip takes SIGPIPE, and
# the pipeline reports failure even though the match SUCCEEDED — which made
# every present file look missing. `grep -c` reads the whole stream instead.
set -uo pipefail

SRC=/workspace/app
OUT=/workspace/documents/equipment-rental-package_v38
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

LIST=$(unzip -l "$ZIP")
count() { printf '%s\n' "$LIST" | grep -cE "$1" || true; }

echo "--- must NOT be present ---"
for bad in 'node_modules/' '/\.env$' '/\.git/' 'dist/public' 'scripts/flow-' 'scripts/verify-' 'scripts/probe-' 'shots' 'twilio'; do
  printf "  %-22s %s\n" "$bad" "$(count "$bad")"
done

echo "--- must be present ---"
for good in "$TOP/package.json" "$TOP/drizzle/schema.ts" \
            "$TOP/.env.example" \
            "$TOP/server/services/sms-pasal.ts" "$TOP/server/services/sms-pasal.test.ts" \
            "$TOP/server/services/order-sms.ts" "$TOP/server/services/bulk-sms.ts" \
            "$TOP/shared/sms.ts" \
            "$TOP/client/src/pages/SmsSettings.tsx" \
            "$TOP/client/src/components/SendMessageSection.tsx" \
            "$TOP/server/db.ts" "$TOP/server/routers.ts" \
            "$TOP/drizzle/migrations/meta/_journal.json"; do
  if [ "$(count "$good")" -gt 0 ]; then echo "  OK       $good"; else echo "  MISSING  $good"; fi
done

echo "--- .env.example must document the SMS Pasal vars ---"
if [ "$(unzip -p "$ZIP" "$TOP/.env.example" | grep -c 'SMS_PASAL_API_KEY')" -gt 0 ]; then
  echo "  OK  documented"
else
  echo "  MISSING"
fi

echo "--- twilio-sms.ts must be GONE ---"
if [ "$(count 'twilio-sms')" -gt 0 ]; then echo "  STILL PRESENT (bad)"; else echo "  OK  absent"; fi

echo "--- message_settings migration must be present ---"
if [ "$(count '0016_.*\.sql$')" -gt 0 ]; then echo "  OK  0016 present"; else echo "  MISSING 0016"; fi

echo "--- migration count in package ---"
count "$TOP/drizzle/migrations/[0-9].*\.sql$"

echo "--- size ---"
ls -la "$ZIP"
printf '%s\n' "$LIST" | tail -1
