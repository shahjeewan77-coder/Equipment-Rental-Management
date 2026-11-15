(() => {
  // Faithful paste emulation.
  //
  // A synthetic ClipboardEvent does NOT perform the browser's native insertion,
  // so dispatching one and reading the value tests only the handler's decision.
  // The real sequence is: fire paste -> if the page did NOT preventDefault, the
  // browser inserts the text at the caret (which fires an input event).
  // This harness does exactly that, so the final field state is what a user sees.
  const inputs = [...document.querySelectorAll("input")].filter((e) => e.offsetParent);
  const nameEl = inputs.find((e) => /paste name and number/i.test(e.placeholder));
  const phoneEl = inputs[inputs.indexOf(nameEl) + 1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const write = (el, v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const snap = () => ({ name: nameEl.value, phone: phoneEl.value });

  // Queue the paste into the next macrotask so the harness's own reads happen
  // AFTER React has flushed the state the handler produced.
  window.__pasteQueue = window.__pasteQueue || [];
  window.__pasteResults = window.__pasteResults || {};

  window.__doPaste = (key, text) => {
    write(nameEl, "");
    write(phoneEl, "");
    setTimeout(() => {
      const dt = new DataTransfer();
      dt.setData("text", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      nameEl.focus();
      nameEl.dispatchEvent(ev);
      const prevented = ev.defaultPrevented;
      if (!prevented) write(nameEl, text); // browser inserts when not prevented
      setTimeout(() => {
        window.__pasteResults[key] = { prevented, ...snap() };
      }, 60);
    }, 60);
    return "queued";
  };

  return "harness_ready";
})()
