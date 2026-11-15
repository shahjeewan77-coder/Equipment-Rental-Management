#!/bin/bash
# Edit-dialog split verification. Login happens in the same chain: the browser
# session is dropped between separate execute_command calls, so a script that
# assumes an existing login silently tests the login page instead.
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5

$B open http://localhost:3000/customers >/dev/null 2>&1
sleep 4

echo "=== rows on customers page ==="
$B eval "$(cat scripts/probe-rows.js)" 2>&1 | tail -1
