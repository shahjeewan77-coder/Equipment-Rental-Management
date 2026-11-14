(() => {
  const inputs = [...document.querySelectorAll("input")].filter((el) => el.offsetParent);
  const nameEl = inputs.find((el) => /paste name and number/i.test(el.placeholder));
  const phoneEl = inputs[1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const set = (el, v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(nameEl, "");
  set(phoneEl, "");

  const out = {};

  // Does a synthetic ClipboardEvent carry clipboardData through to the handler?
  out.synthetic_dt = "trying";
  const dt = new DataTransfer();
  dt.setData("text", "Ram Bahadur 9818755517");
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  out.ev_has_dt = !!ev.clipboardData;
  out.ev_dt_text = ev.clipboardData ? ev.clipboardData.getData("text") : null;
  nameEl.focus();
  nameEl.dispatchEvent(ev);
  out.after_synthetic_paste = { name: nameEl.value, phone: phoneEl.value };

  // Does focusout reach React's onBlur?
  set(nameEl, "Ram Bahadur 9818755517");
  out.before_blur = { name: nameEl.value, phone: phoneEl.value };
  nameEl.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
  out.after_focusout = { name: nameEl.value, phone: phoneEl.value };

  // Try blur() which fires a real focusout when the element is focused
  nameEl.focus();
  document.body.focus?.();
  out.activeAfterBodyFocus = document.activeElement ? document.activeElement.tagName : null;
  nameEl.blur();
  out.after_native_blur = { name: nameEl.value, phone: phoneEl.value };

  // Is the handler even wired? Count React props on the node.
  const key = Object.keys(nameEl).find((k) => k.startsWith("__reactProps"));
  out.react_props_key = key || null;
  out.has_onPaste = key ? !!nameEl[key].onPaste : null;
  out.has_onBlur = key ? !!nameEl[key].onBlur : null;

  return JSON.stringify(out);
})()
