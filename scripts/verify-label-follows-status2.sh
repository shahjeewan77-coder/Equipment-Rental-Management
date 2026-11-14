#!/bin/bash
# Proves the tracking label is derived from ORDER STATUS, not ping age.
# Flips one Kabiraj order on_rent -> on_transit, reads the map, then ALWAYS
# reverts (no `set -e`: an early exit would leave the data modified).
B=agent-browser
ORDER=$(cat /tmp/kab_order.txt)

flip() {
  node -e '
  const {Pool}=require("pg");const fs=require("fs");
  const env=Object.fromEntries(fs.readFileSync("/workspace/app/.env","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^[\x27\x22]|[\x27\x22]$/g,"")]}));
  (async()=>{const p=new Pool({connectionString:env.DATABASE_URL});
  await p.query("UPDATE orders SET status=$2 WHERE id=$1",[process.argv[1],process.argv[2]]);
  const r=await p.query("SELECT status FROM orders WHERE id=$1",[process.argv[1]]);
  console.log("status now:",r.rows[0].status);await p.end();})();' "$ORDER" "$1"
}

read_kabiraj() {
  $B open http://localhost:3000/login >/dev/null 2>&1; sleep 3
  $B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
  $B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
  $B find role button click --name "Log in" >/dev/null 2>&1; sleep 5
  $B open http://localhost:3000/dashboard >/dev/null 2>&1; sleep 3
  $B eval "$(cat scripts/track-stub.js)" >/dev/null 2>&1; sleep 7
  $B eval "(()=>{const b=[...document.querySelectorAll('button[title]')].find(x=>x.title==='Kabiraj');if(!b)return 'no-marker';b.click();return 'clicked'})()" >/dev/null 2>&1; sleep 2
  $B eval "(()=>{const t=document.body.innerText;return JSON.stringify((t.match(/(Delivering to|Delivered to)[^\n]{0,40}/g)||[]))})()" 2>&1 | tail -1
}

echo "=== baseline (on_rent) ==="
read_kabiraj

echo "=== flip to on_transit ==="
flip on_transit

echo "=== label while on_transit ==="
read_kabiraj

echo "=== revert to on_rent ==="
flip on_rent

echo "=== label after revert ==="
read_kabiraj
