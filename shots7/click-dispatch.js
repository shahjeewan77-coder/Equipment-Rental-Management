(() => {
  var btn = Array.from(document.querySelectorAll('button')).find(function (b) {
    return b.textContent.trim() === 'Dispatched';
  });
  if (!btn) return 'NO DISPATCH BUTTON | hadLock=' + /Lock for dispatch/.test(document.body.innerText);
  btn.click();
  return 'clicked-dispatched';
})()
