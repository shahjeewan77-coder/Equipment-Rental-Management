#!/bin/bash
# Edit-dialog contact split: type a number into the Name field, blur, read back.
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/customers >/dev/null 2>&1
sleep 4

echo "-- open Edit for first row --"
$B eval "[...document.querySelectorAll('button')].find(b=>/^Edit /.test(b.getAttribute('aria-label')||'')).click(), 'opened'" 2>&1 | tail -1
sleep 2

echo "-- dialog fields before --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);return JSON.stringify(i.map(e=>({ph:e.placeholder,val:e.value})))})()" 2>&1 | tail -1

echo "-- clear name, type name+number --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i[0];const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(n,'');n.dispatchEvent(new Event('input',{bubbles:true}));n.focus();return 'cleared'})()" 2>&1 | tail -1
sleep 1
$B keyboard type "Annapurna Infra 9833333333" 2>&1 | tail -1
sleep 1
echo "-- before blur --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);return JSON.stringify({name:i[0].value,phone:i[1].value})})()" 2>&1 | tail -1
echo "-- Tab to blur --"
$B press Tab 2>&1 | tail -1
sleep 1
echo "-- after blur --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);return JSON.stringify({name:i[0].value,phone:i[1].value})})()" 2>&1 | tail -1
