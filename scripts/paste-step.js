(() => {
  const inputs = [...document.querySelectorAll("input")].filter((el) => el.offsetParent);
  const nameEl = inputs.find((el) => /paste name and number/i.test(el.placeholder));
  const phoneEl = inputs[1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const set = (el, v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // Reset to a known state, then paste. Nothing is read here — React flushes
  // state asynchronously, so reading in this same tick returns the stale value.
  set(nameEl, "");
  set(phoneEl, "");
  const dt = new DataTransfer();
  dt.setData("text", "Ram Bahadur 9818755517");
  nameEl.focus();
  nameEl.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  return "pasted";
})()
