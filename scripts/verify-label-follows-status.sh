#!/bin/bash
# Proves the label is derived from ORDER STATUS, not from ping age.
# Flips one Kabiraj order on_rent -> on_transit, reads the map, flips it back.
# Reversible and verified restored at the end.
set -e
B=agent-browser

node - <<'JS'
import("pg").then(async ({ Pool }) => {
  const fs = await import("fs");
  const env = Object.fromEntries(fs.readFileSync("/workspace/app/.env","utf8").split("\n")
    .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,"")]}));
  const p = new Pool({connectionString: env.DATABASE_URL});
  const r = await p.query(`SELECT o.id,o.status FROM orders o JOIN drivers d ON d.id=COALESCE(o.transited_by_driver_id,o.driver_id)
    WHERE d.name='Kabiraj' AND o.status='on_rent' ORDER BY o.created_at DESC LIMIT 1`);
  fs.writeFileSync("/tmp/kab_order.txt", r.rows[0].id);
  await p.query(`UPDATE orders SET status='on_transit' WHERE id=$1`, [r.rows[0].id]);
  console.log("flipped to on_transit:", r.rows[0].id, "(was on_rent)");
  await p.end();
});
JS

echo "-- read label after flip --"
$B open http://localhost:3000/login >/dev/null 2>&1; sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1; sleep 5
$B open http://localhost:3000/dashboard >/dev/null 2>&1; sleep 3
$B eval "$(cat scripts/track-stub.js)" >/dev/null 2>&1; sleep 7
$B eval "(()=>{const b=[...document.querySelectorAll('button[title]')].find(x=>x.title==='Kabiraj');b.click();return 'clicked'})()" >/dev/null 2>&1; sleep 2
$B eval "(()=>{const t=document.body.innerText;return JSON.stringify({labels:(t.match(/(Delivering to|Delivered to)[^\n]{0,40}/g)||[])})})()" 2>&1 | tail -1

echo "-- revert --"
node - <<'JS'
import("pg").then(async ({ Pool }) => {
  const fs = await import("fs");
  const id = fs.readFileSync("/tmp/kab_order.txt","utf8").trim();
  const env = Object.fromEntries(fs.readFileSync("/workspace/app/.env","utf8").split("\n")
    .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
    .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,"")]}));
  const p = new Pool({connectionString: env.DATABASE_URL});
  await p.query(`UPDATE orders SET status='on_rent' WHERE id=$1`, [id]);
  const c = await p.query(`SELECT status FROM orders WHERE id=$1`, [id]);
  console.log("restored:", id, "->", c.rows[0].status);
  await p.end();
});
JS
