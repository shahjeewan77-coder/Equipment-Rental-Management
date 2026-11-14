#!/bin/bash
# Owner login + full route sweep with console error capture.
# Chained in ONE command so the session (and cookie) survives: a flow split
# across calls loses login state when the browser session resets.
B=agent-browser

$B open http://localhost:3000/login > /dev/null 2>&1
sleep 3

# Log in through the real form fields.
$B find label "Email" fill "owner@sharma.com" > /dev/null 2>&1
$B find label "Password" fill "Rent@2026New" > /dev/null 2>&1
$B find role button click --name "Log in" > /dev/null 2>&1
sleep 5

echo "=== after login ==="
$B eval "JSON.stringify({url:location.pathname, hasOwnerNav:/Audit Trail/.test(document.body.innerText)})" 2>&1 | tail -3
