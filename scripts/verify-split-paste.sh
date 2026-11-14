#!/bin/bash
# Phone-split verification, one browser action per call with a read in a
# SEPARATE call afterwards. Reading in the same tick as the mutation returns
# React's stale value and reports a working handler as broken.
B=agent-browser
URL=http://localhost:3000/customers

RESET='(()=>{const i=[...document.querySelectorAll("input")].filter(e=>e.offsetParent);const n=i.find(e=>/paste name and number/i.test(e.placeholder));const p=i[i.indexOf(n)+1];const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(n,"");n.dispatchEvent(new Event("input",{bubbles:true}));s.call(p,"");p.dispatchEvent(new Event("input",{bubbles:true}));return "reset"})()'

READ='(()=>{const i=[...document.querySelectorAll("input")].filter(e=>e.offsetParent);const n=i.find(e=>/paste name and number/i.test(e.placeholder));const p=i[i.indexOf(n)+1];return JSON.stringify({name:n.value,phone:p.value})})()'

paste_it() {
  # $1 = text to paste
  $B eval "(()=>{const i=[...document.querySelectorAll(\"input\")].filter(e=>e.offsetParent);const n=i.find(e=>/paste name and number/i.test(e.placeholder));const dt=new DataTransfer();dt.setData(\"text\",\"$1\");n.focus();n.dispatchEvent(new ClipboardEvent(\"paste\",{clipboardData:dt,bubbles:true,cancelable:true}));return \"pasted\"})()" >/dev/null 2>&1
}

case_paste() {
  # $1 = label, $2 = text
  $B eval "$RESET" >/dev/null 2>&1
  sleep 1
  paste_it "$2"
  sleep 1
  local R
  R=$($B eval "$READ" 2>&1 | tail -1)
  echo "$1 -> $R"
}

$B open "$URL" >/dev/null 2>&1
sleep 3
$B eval "[...document.querySelectorAll('button')].find(b=>/Add customer/i.test(b.textContent)).click(), 'opened'" >/dev/null 2>&1
sleep 2

echo "===== PASTE CASES ====="
case_paste "paste_name_first  " "Ram Bahadur 9818755517"
case_paste "paste_number_first" "9818755517 Ram"
case_paste "paste_formatted   " "+977-981-875-5517"
case_paste "paste_name_only   " "Annapurna Infra"
case_paste "paste_with_label  " "Mobile 9818755517 Hari"
case_paste "paste_digits_only " "9818755517"
case_paste "paste_tower5      " "Tower 5"
