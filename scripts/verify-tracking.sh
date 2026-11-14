#!/bin/bash
# Tracking page: compare rendered labels against the DB-derived expectation.
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/tracking >/dev/null 2>&1
sleep 5

echo "=== is anything rendered? length ==="
$B eval "document.body.innerText.trim().length" 2>&1 | tail -1

echo "=== body text after nav (look for labels) ==="
$B eval "(()=>{const t=document.body.innerText;const m=t.match(/(Delivering to|Delivered to)[^\n]{0,60}/g)||[];return JSON.stringify({labels:m, hasDelivering:/Delivering to/.test(t), hasDelivered:/Delivered to/.test(t), len:t.length})})()" 2>&1 | tail -1

echo "=== map markers / driver rows ==="
$B eval "(()=>{const t=document.body.innerText;return JSON.stringify({tail:t.slice(-700)})})()" 2>&1 | tail -1
