(() => {
  const out = [];
  document.querySelectorAll("input, textarea").forEach((el, i) => {
    out.push({
      i,
      placeholder: el.placeholder || "",
      value: el.value,
      type: el.type,
      visible: !!el.offsetParent,
    });
  });
  return JSON.stringify({
    bodyHead: document.body.innerText.slice(0, 120),
    inputs: out.filter((o) => o.visible),
    buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 25),
  });
})()
