#!/bin/bash
# Full console sweep across all routes. No set -e.
B=agent-browser
cd /workspace/app || exit 1

LOGIN='fetch("/trpc/auth.login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({json:{email:"owner@sharma.com",password:"Rent@2026New"}})}).then(r=>r.json()).then(()=>"ok")'

$B open "http://localhost:3000/login" >/dev/null 2>&1
sleep 2
$B eval "$LOGIN" >/dev/null 2>&1
sleep 1

for p in /dashboard /orders /vehicles /stock /customers /ledger /invoices /rentals /audit /users /tracking; do
  $B open "http://localhost:3000$p" >/dev/null 2>&1
  sleep 3
  N=$($B console 2>&1 | grep -iE "\berror\b|uncaught|severe" | grep -viE "React DevTools|Download the React|vite|HMR|source map" | wc -l)
  echo "$p  console_errors=$N"
done

echo "===== RAW CONSOLE (last page) ====="
$B console 2>&1 | grep -iE "\berror\b|uncaught" | grep -viE "React DevTools|Download the React" | head -10
echo "CONSOLE_SWEEP_DONE"
