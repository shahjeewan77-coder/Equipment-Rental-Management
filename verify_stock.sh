#!/bin/bash
# Verify Stock report 'Log check' column + console errors. No set -e.
B=agent-browser
cd /workspace/app || exit 1

LOGIN='fetch("/trpc/auth.login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({json:{email:"owner@sharma.com",password:"Rent@2026New"}})}).then(r=>r.json()).then(()=>"ok")'

$B open "http://localhost:3000/login" >/dev/null 2>&1
sleep 2
$B eval "$LOGIN" >/dev/null 2>&1
sleep 1

echo "===== STOCK REPORT: Log check column ====="
$B open "http://localhost:3000/stock" >/dev/null 2>&1
sleep 5
$B eval "(()=>{const t=document.body.innerText;return JSON.stringify({hasLogCheck:/Log check/i.test(t),logCheckCount:(t.match(/Log check/gi)||[]).length,hasClosing:/Closing/i.test(t),checkMarks:(t.match(/\u2713/g)||[]).length,snippetText:t.replace(/\s+/g,' ').slice(0,600)})})()" 2>&1 | tail -3

echo "===== STOCK HEADERS + ROW VALUES ====="
$B eval "(()=>{const ths=[...document.querySelectorAll('th')].map(h=>h.textContent.trim()).filter(Boolean);const rows=[...document.querySelectorAll('tbody tr')].slice(0,10).map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent.trim()));return JSON.stringify({headers:ths,rowCount:rows.length,rows:rows})})()" 2>&1 | tail -3

echo "===== CONSOLE ERRORS (stock) ====="
$B console 2>&1 | grep -iE "error|severe" | grep -viE "React DevTools|Download the React" | head -15
echo "CONSOLE_STOCK_DONE"
