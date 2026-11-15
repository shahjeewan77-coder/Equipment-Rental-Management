#!/bin/bash
# Build the v26 download package.
#
# Stages a clean copy so no exclude glob can be defeated by a nested path, and
# zips from a PARENT directory with the app folder name so the archive has one
# top-level `equipment-rental-app/` entry. Zipping `.` from inside the app puts
# files at the archive root instead, which unpacks messily and makes path
# assertions misleading.
#
# Excluded: dependencies, build output, git, secrets, screenshots and logs.
# An earlier package shipped stale debug scripts inside every zip, so the
# exclusions are asserted rather than assumed.
set -uo pipefail

SRC=/workspace/app
OUT=/workspace/documents/equipment-rental-package_v26
ZIP="$OUT/equipment-rental-app.zip"
TOP=equipment-rental-app

rm -rf "$OUT" /tmp/pkgstage
mkdir -p "$OUT" "/tmp/pkgstage/$TOP"

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

echo "--- must NOT be present ---"
for bad in 'node_modules/' '^.*/\.env$' '/\.git/' 'dist/public' 'shots'; do
  n=$(unzip -l "$ZIP" | awk 'NF>=4{print $4}' | grep -cE "$bad" || true)
  printf "  %-20s %s\n" "$bad" "$n"
done

echo "--- must be present ---"
for good in package.json drizzle/schema.ts shared/contact-split.ts \
            client/src/lib/destination-label.ts client/src/pages/Tracking.tsx \
            server/db.ts scripts/check-journal.mjs scripts/replay-migrations.mjs \
            scripts/build-server.mjs drizzle/migrations/meta/_journal.json; do
  if unzip -l "$ZIP" | awk 'NF>=4{print $4}' | grep -qx "$TOP/$good"; then
    echo "  OK       $good"
  else
    echo "  MISSING  $good"
  fi
done

echo "--- scripts/ contents in package ---"
unzip -l "$ZIP" | awk 'NF>=4{print $4}' | grep "^$TOP/scripts/" | sed 's|^|  |'

echo "--- migrations + journal ---"
echo "  sql:     $(unzip -l "$ZIP" | awk 'NF>=4{print $4}' | grep -cE "^$TOP/drizzle/migrations/[0-9].*\.sql$")"
echo "  journal: $(unzip -p "$ZIP" "$TOP/drizzle/migrations/meta/_journal.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).entries.length))')"

echo "--- size ---"
ls -la "$ZIP"
unzip -l "$ZIP" | tail -1
