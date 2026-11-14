#!/bin/bash
# Click each driver marker and read its popup text, so every label is observed
# on screen rather than inferred from the database.
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/dashboard >/dev/null 2>&1
sleep 3
$B eval "$(cat scripts/track-stub.js)" >/dev/null 2>&1
sleep 7

# Capture the page text with NO popup open, so the delta from opening one is the popup.
BASE=$($B eval "document.body.innerText.length" 2>&1 | tail -1)

for NAME in "Bikash" "Bikash 38471" "Kabiraj" "Ram Bahadur"; do
  $B eval "(()=>{const b=[...document.querySelectorAll('button[title]')].find(x=>x.title==='$NAME');if(!b)return 'no-marker';b.click();return 'clicked'})()" 2>&1 | tail -1 > /tmp/click.txt
  sleep 2
  RES=$($B eval "(()=>{const t=document.body.innerText;const m=t.match(/(Delivering to|Delivered to)[^\n]{0,45}/g)||[];return JSON.stringify({labels:m})})()" 2>&1 | tail -1)
  echo "$NAME -> $(cat /tmp/click.txt) $RES"
done

echo "=== drivers table labels on the same page ==="
$B eval "(()=>{const t=document.body.innerText;return JSON.stringify({all:(t.match(/(Delivering to|Delivered to)[^\n]{0,45}/g)||[])})})()" 2>&1 | tail -1
