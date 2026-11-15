(() => {
  var btn = Array.from(document.querySelectorAll('button')).find(function (b) {
    return b.textContent.trim() === 'Dispatched';
  });
  var p = document.querySelector('[role=dialog]');
  if (!p) return 'NO POPOVER';
  var pr = p.getBoundingClientRect();
  var br = btn ? btn.getBoundingClientRect() : { bottom: -1 };
  var bs = Array.from(p.querySelectorAll('button'));
  var last = bs[bs.length - 1];
  var lr = last.getBoundingClientRect();
  return JSON.stringify({
    anchorBottom: Math.round(br.bottom),
    panelTop: Math.round(pr.top),
    panelBottom: Math.round(pr.bottom),
    gapPx: Math.round(pr.top - br.bottom),
    vh: innerHeight,
    scrollY: Math.round(scrollY),
    fullyVisible: pr.top >= 0 && pr.bottom <= innerHeight && pr.left >= 0 && pr.right <= innerWidth,
    needsScroll: pr.bottom > innerHeight || pr.top < 0,
    footerBtnVisible: lr.bottom <= innerHeight && lr.top >= 0,
    footerBtnText: last.textContent.trim().slice(0, 28),
    title: (p.querySelector('h2') || {}).textContent,
    body: p.innerText.replace(/\n+/g, ' | ').slice(0, 190)
  });
})()
