#!/bin/bash
# Re-verify after wiring the ErrorBoundary. No set -e.
B=agent-browser
cd /workspace/app || exit 1
LOGIN='fetch("/trpc/auth.login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({json:{email:"owner@sharma.com",password:"Rent@2026New"}})}).then(r=>r.json()).then(()=>"ok")'

$B open "http://localhost:3000/login" >/dev/null 2>&1
sleep 3
$B eval "$LOGIN" >/dev/null 2>&1
sleep 1

for p in /dashboard /stock /customers /tracking /ledger; do
  $B open "http://localhost:3000$p" >/dev/null 2>&1
  sleep 3
  $B eval "(()=>{const t=document.body.innerText.replace(/\s+/g,' ');return JSON.stringify({p:'$p',len:t.length,boundary:/Something went wrong/.test(t),logcheck:/Log check/i.test(t)})})()" 2>&1 | tail -1
done

echo "=== console errors ==="
$B console 2>&1 | grep -iE "\berror\b|uncaught" | grep -viE "React DevTools|Download the React" | head -8
echo "REVERIFY_DONE"
