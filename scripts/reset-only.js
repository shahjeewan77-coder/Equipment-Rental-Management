(() => {
  const i = [...document.querySelectorAll("input")].filter((e) => e.offsetParent);
  const n = i.find((e) => /paste name and number/i.test(e.placeholder));
  const p = i[i.indexOf(n) + 1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const set = (el, v) => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(n, "");
  set(p, "");
  return "reset-only";
})()
