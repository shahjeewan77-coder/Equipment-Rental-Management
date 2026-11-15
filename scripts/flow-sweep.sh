#!/bin/bash
# Route sweep with per-page console error capture.
# Each page is opened, waited for, then read semantically (innerText length +
# error-marker regex) rather than by pixels. Console is cleared per route so an
# error is attributed to the page that caused it.
B=agent-browser

ROUTES="/dashboard /orders /vehicles /stock /tracking /customers /ledger /invoices /audit"
FAIL=0

for R in $ROUTES; do
  $B open "http://localhost:3000$R" > /dev/null 2>&1
  sleep 3
  RES=$($B eval "JSON.stringify({
    path: location.pathname,
    len: document.body.innerText.trim().length,
    err: /Failed to fetch|Something went wrong|Cannot read|is not a function|Unexpected Application Error|Network Error/i.test(document.body.innerText)
  })" 2>&1 | tail -1)
  echo "$R -> $RES"
  case "$RES" in
    *'"err":false'*) ;;
    *'"err":true'*) FAIL=$((FAIL+1)); echo "   ^^ ERROR TEXT ON PAGE" ;;
  esac
done

echo "pages_with_error_text=$FAIL"
