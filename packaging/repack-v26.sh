#!/bin/bash
# Rebuild the v26 package WITHOUT destroying the README.
#
# The previous version did `rm -rf "$OUT"`, which deleted the README sitting
# next to the zip. Only the zip is removed now; the README is authored
# separately and must survive a repack.
set -uo pipefail

SRC=/workspace/app
OUT=/workspace/documents/equipment-rental-package_v26
ZIP="$OUT/equipment-rental-app.zip"
TOP=equipment-rental-app

mkdir -p "$OUT"
rm -f "$ZIP"
rm -rf /tmp/pkgstage
mkdir -p "/tmp/pkgstage/$TOP"

cd "$SRC"
tar -cf - \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./dist' \
  --exclude='./.env' \
  --exclude='./shots*' \
  --exclude='./*.log' \
  . | tar -xf - -C "/tmp/pkgstage/$TOP"

cd /tmp/pkgstage
zip -r -q "$ZIP" "$TOP"

Z="$ZIP"
echo "--- must NOT be present (expect 0) ---"
for bad in 'node_modules/' '\.env$' '/\.git/' 'dist/public' 'shots'; do
  echo "  $bad: $(unzip -l "$Z" | awk 'NF>=4{print $4}' | grep -cE "$bad")"
done

echo "--- must be present ---"
ok=0; bad=0
for f in package.json drizzle/schema.ts shared/contact-split.ts \
         client/src/lib/destination-label.ts client/src/pages/Tracking.tsx \
         server/db.ts scripts/check-journal.mjs scripts/replay-migrations.mjs \
         scripts/build-server.mjs drizzle/migrations/meta/_journal.json; do
  if unzip -l "$Z" "$TOP/$f" >/dev/null 2>&1; then ok=$((ok+1)); else bad=$((bad+1)); echo "  MISSING $f"; fi
done
echo "  present: $ok  missing: $bad"

echo "--- scripts/ in package ---"
unzip -l "$Z" | awk 'NF>=4{print $4}' | grep "^$TOP/scripts/" | sed 's|.*/scripts/|  |'

echo "--- migrations ---"
echo "  sql files: $(unzip -l "$Z" | awk 'NF>=4{print $4}' | grep -cE "^$TOP/drizzle/migrations/[0-9].*\.sql$")"

echo "--- package dir ---"
ls -la "$OUT"
