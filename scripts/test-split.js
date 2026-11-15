(() => {
  const inputs = [...document.querySelectorAll("input")].filter((el) => el.offsetParent);
  const nameEl = inputs.find((el) => /paste name and number/i.test(el.placeholder));
  const phoneEl = inputs[1];

  // React controlled inputs: a plain el.value assignment does not reach state.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const set = (el, v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const read = () => ({ name: nameEl.value, phone: phoneEl.value });
  const reset = () => {
    set(nameEl, "");
    set(phoneEl, "");
  };
  const paste = (text) => {
    const dt = new DataTransfer();
    dt.setData("text", text);
    nameEl.focus();
    nameEl.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  // React attaches onBlur as focusout on the root, so a synthetic 'blur' hits nothing.
  const blur = () => nameEl.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

  const results = {};

  // ── PASTE cases ──────────────────────────────────────────────────────────
  reset();
  paste("Ram Bahadur 9818755517");
  results.paste_name_first = read();

  reset();
  paste("9818755517 Ram");
  results.paste_number_first = read();

  reset();
  paste("+977-981-875-5517");
  results.paste_formatted = read();

  reset();
  paste("Annapurna Infra");
  results.paste_name_only = read();

  reset();
  paste("Mobile 9818755517 Hari");
  results.paste_with_label = read();

  // ── TYPING case: replays the string one keystroke at a time ──────────────
  reset();
  const typed = "Ram Bahadur 9818755517";
  const livePhone = [];
  for (let i = 1; i <= typed.length; i++) {
    set(nameEl, typed.slice(0, i));
    if (typed.slice(0, i).endsWith("9818755517")) livePhone.push({ at: i, phone: phoneEl.value });
  }
  const midTyping = read();
  blur();
  const afterBlur = read();
  results.typing_name_first = { livePhone, midTyping, afterBlur };

  // ── Hand-typed contact must survive a name with no digits ────────────────
  reset();
  set(phoneEl, "9800000009");
  set(nameEl, "Norbu Sherpa");
  blur();
  results.manual_phone_preserved = read();

  // ── Digits-only paste leaves name empty ──────────────────────────────────
  reset();
  paste("9818755517");
  results.paste_digits_only = read();

  // ── A name with a small number keeps it ──────────────────────────────────
  reset();
  paste("Tower 5");
  results.paste_tower5 = read();

  return JSON.stringify(results);
})()
