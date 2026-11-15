#!/bin/bash
# Tracking labels with geolocation stubbed, then the SPA remounted WITHOUT a
# reload (a reload wipes the stub). The page's own useGpsStatus/getCurrentPosition
# path runs unchanged — only the device answer differs, which is the one thing
# this sandbox cannot provide (Chrome here denies geolocation outright).
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5

$B open http://localhost:3000/dashboard >/dev/null 2>&1
sleep 3

echo "-- stub + remount onto /tracking (same eval, no reload) --"
$B eval "$(cat scripts/track-stub.js)" 2>&1 | tail -1
sleep 7

echo "=== overlay? ==="
$B eval "JSON.stringify({blocked:/Location services .GPS. are turned off/i.test(document.body.innerText)})" 2>&1 | tail -1
echo "=== labels ==="
$B eval "(()=>{const t=document.body.innerText;return JSON.stringify({labels:(t.match(/(Delivering to|Delivered to)[^\n]{0,50}/g)||[])})})()" 2>&1 | tail -1
echo "=== markers ==="
$B eval "(()=>{const m=[...document.querySelectorAll('button[title]')];return JSON.stringify({n:m.length,titles:m.map(x=>x.title).slice(0,10)})})()" 2>&1 | tail -1
