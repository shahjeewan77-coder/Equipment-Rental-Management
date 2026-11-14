#!/bin/bash
# FINAL verification: login + all routes + stock Log check + console. No set -e.
B=agent-browser
cd /workspace/app || exit 1
LOGIN='fetch("/trpc/auth.login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({json:{email:"owner@sharma.com",password:"Rent@2026New"}})}).then(r=>r.json()).then(()=>"ok")'

echo "===== LOGIN PAGE ====="
$B open "http://localhost:3000/login" >/dev/null 2>&1
sleep 4
$B eval "JSON.stringify({title:document.title,hasForm:/Email|Password/i.test(document.body.innerText)})" 2>&1 | tail -1

echo "===== OWNER LOGIN ====="
$B eval "$LOGIN" 2>&1 | tail -1
sleep 1
$B eval "fetch('/trpc/auth.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D').then(r=>r.json()).then(j=>JSON.stringify(j[0].result.data.json))" 2>&1 | tail -1

echo "===== ROUTE SWEEP ====="
for p in /dashboard /orders /vehicles /stock /tracking /customers /ledger /invoices /rentals /audit /users; do
  $B open "http://localhost:3000$p" >/dev/null 2>&1
  sleep 3
  N=$($B console 2>&1 | grep -iE "\berror\b|uncaught" | grep -viE "React DevTools|Download the React" | wc -l)
  $B eval "(()=>{const t=document.body.innerText.replace(/\s+/g,' ');return JSON.stringify({p:'$p',len:t.length,err:/something went wrong/i.test(t)})})()" 2>&1 | tail -1
  echo "   console_errors=$N"
done

echo "===== ANY CONSOLE ERRORS ====="
$B console 2>&1 | grep -iE "\berror\b|uncaught" | grep -viE "React DevTools|Download the React" | head -8
echo "FINAL_DONE"
