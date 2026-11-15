#!/bin/bash
# Self-sufficient: login then sweep. No set -e so cleanup always runs.
B=agent-browser
cd /workspace/app || exit 1

$B open "http://localhost:3000/login" >/dev/null 2>&1
sleep 4

echo "=== LOGIN PAGE ==="
$B eval "JSON.stringify({title:document.title, hasEmail:/Email|identifier/i.test(document.body.innerText), text:document.body.innerText.replace(/\s+/g,' ').slice(0,180)})" 2>&1 | tail -3

echo "=== PERFORM LOGIN VIA API ==="
$B eval "fetch('/trpc/auth.login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({json:{email:'owner@sharma.com',password:'Rent@2026New'}})}).then(r=>r.text()).then(t=>'login:'+t.slice(0,160))" 2>&1 | tail -3
sleep 2

$B eval "fetch('/trpc/auth.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D').then(r=>r.json()).then(j=>'me:'+JSON.stringify(j).slice(0,300))" 2>&1 | tail -3
echo "SWEEP_LOGIN_DONE"
