(() => {
  const rows = [...document.querySelectorAll("tbody tr")];
  const first = rows[0];
  const btns = first ? [...first.querySelectorAll("button")] : [];
  return JSON.stringify({
    rowCount: rows.length,
    firstRowText: first ? first.innerText.slice(0, 80) : null,
    btnLabels: btns.map((b) => b.getAttribute("aria-label") || b.title || b.textContent.trim()),
  });
})()
