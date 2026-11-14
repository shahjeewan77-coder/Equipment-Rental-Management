#!/bin/bash
# Sweep every owner route, capturing text and console errors. No set -e.
B=agent-browser
cd /workspace/app || exit 1

LOGIN='fetch("/trpc/auth.login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({json:{email:"owner@sharma.com",password:"Rent@2026New"}})}).then(r=>r.json()).then(()=>"ok")'

for p in /dashboard /orders /vehicles /stock /tracking /customers /ledger /invoices /rentals /audit /users; do
  $B open "http://localhost:3000/login" >/dev/null 2>&1
  sleep 2
  $B eval "$LOGIN" >/dev/null 2>&1
  sleep 1
  $B open "http://localhost:3000$p" >/dev/null 2>&1
  sleep 4
  echo "----- $p"
  $B eval "(()=>{const t=document.body.innerText.replace(/\s+/g,' ');return JSON.stringify({url:location.pathname,len:t.length,err:/something went wrong|cannot read|undefined is not|is not a function/i.test(t),head:t.slice(0,110)})})()" 2>&1 | tail -2
done
echo "SWEEP_DONE"
