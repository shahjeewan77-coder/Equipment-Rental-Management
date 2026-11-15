#!/bin/bash
# New Order -> "New customer" inline form: paste and type split.
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/orders/new >/dev/null 2>&1
sleep 4

echo "-- click New customer --"
$B eval "[...document.querySelectorAll('button')].find(b=>/New customer/i.test(b.textContent)).click(), 'opened'" 2>&1 | tail -1
sleep 2

echo "-- inline fields present --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);return JSON.stringify(i.map(e=>e.placeholder))})()" 2>&1 | tail -1

echo "-- paste name+number into inline Name --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i.find(e=>/Customer name, or paste/i.test(e.placeholder));const dt=new DataTransfer();dt.setData('text','Bishnu Thapa 9841234567');n.focus();n.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 'pasted'})()" 2>&1 | tail -1
sleep 2
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i.find(e=>/Customer name, or paste/i.test(e.placeholder));const p=i[i.indexOf(n)+1];return JSON.stringify({name:n.value,phone:p.value})})()" 2>&1 | tail -1

echo "-- type a different one --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i.find(e=>/Customer name, or paste/i.test(e.placeholder));const p=i[i.indexOf(n)+1];const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(n,'');n.dispatchEvent(new Event('input',{bubbles:true}));s.call(p,'');p.dispatchEvent(new Event('input',{bubbles:true}));n.focus();return 'cleared'})()" 2>&1 | tail -1
sleep 1
$B keyboard type "Sita Rai 9807654321" 2>&1 | tail -1
sleep 1
echo "-- before blur --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i.find(e=>/Customer name, or paste/i.test(e.placeholder));const p=i[i.indexOf(n)+1];return JSON.stringify({name:n.value,phone:p.value})})()" 2>&1 | tail -1
$B press Tab >/dev/null 2>&1
sleep 1
echo "-- after blur --"
$B eval "(()=>{const i=[...document.querySelectorAll('input')].filter(e=>e.offsetParent);const n=i.find(e=>/Customer name, or paste/i.test(e.placeholder));const p=i[i.indexOf(n)+1];return JSON.stringify({name:n.value,phone:p.value})})()" 2>&1 | tail -1
