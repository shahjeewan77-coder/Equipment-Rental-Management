#!/bin/bash
B=agent-browser

$B open http://localhost:3000/login >/dev/null 2>&1
sleep 3
$B find label "Email" fill "owner@sharma.com" >/dev/null 2>&1
$B find label "Password" fill "Rent@2026New" >/dev/null 2>&1
$B find role button click --name "Log in" >/dev/null 2>&1
sleep 5
$B open http://localhost:3000/orders/new >/dev/null 2>&1
sleep 4

echo "-- customer block --"
$B eval "document.body.innerText.slice(0,400)" 2>&1 | tail -1

echo "-- type a name that matches no customer --"
$B find placeholder "Search customers by name or phone" fill "Zoomba Traders" >/dev/null 2>&1
sleep 1
$B eval "document.body.innerText.slice(0,600)" 2>&1 | tail -1
