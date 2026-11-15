#!/bin/bash
# Tracking page with geolocation granted, so the GPS guard passes and the map
# (and its destination labels) render. `set geo` gives Chrome a real fix and
# auto-grants the permission, which a JS stub cannot do reliably.
B=agent-browser

$B set geo 27.7172 85.3240 >/dev/null 2>&1

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/tracking >/dev/null 2>&1
sleep 6

echo "=== GPS overlay still up? ==="
$B eval "JSON.stringify({blocked:/Location services .GPS. are turned off/i.test(document.body.innerText)})" 2>&1 | tail -1

echo "=== labels found on page ==="
$B eval "(()=>{const t=document.body.innerText;const m=t.match(/(Delivering to|Delivered to)[^\n]{0,50}/g)||[];return JSON.stringify({labels:m})})()" 2>&1 | tail -1

echo "=== map markers ==="
$B eval "(()=>{const m=[...document.querySelectorAll('button.absolute, .leaflet-marker-icon, [data-marker]')];return JSON.stringify({count:m.length,titles:m.map(x=>x.getAttribute('title')||x.textContent.trim().slice(0,40)).slice(0,12)})})()" 2>&1 | tail -1

echo "=== page tail ==="
$B eval "document.body.innerText.slice(-500)" 2>&1 | tail -1
