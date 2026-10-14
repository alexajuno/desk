// The search page: results redraw as you type, best match first, with the first one focused.
// In the box, the arrows move and Enter opens; Esc leaves the box, and then J/K and the rest of
// desk.js's row keys work as on the backlog. The rows and their focus are desk.js's.

const box = document.getElementById("search-q");
const results = document.getElementById("results");
let asked = 0;

async function search(keep) {
  const q = box.value.trim(), mine = ++asked;
  const html = await (await fetch(`/search/rows?q=${encodeURIComponent(q)}`)).text();
  if (mine !== asked) return;
  results.innerHTML = html;
  focusRow((keep && results.querySelector(`.item[data-slug="${keep}"]`)) || results.querySelector(".item"));
}

box.addEventListener("input", () => {
  const q = box.value.trim();
  history.replaceState(null, "", q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  search();
});

box.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { moveFocus(e.key === "ArrowDown" ? 1 : -1); e.preventDefault(); }
  else if (e.key === "Enter") { if (focused) location.href = focused.getAttribute("href"); e.preventDefault(); }
  else if (e.key === "Escape") { box.blur(); }
});

results.addEventListener("mousemove", (e) => {
  const row = e.target.closest(".item");
  if (row && row !== focused) focusRow(row);
});

// base.html calls this instead of reloading the page when an issue changes, so typing goes on.
window.onIssuesChanged = () => search(focused?.dataset.slug);

box.focus();
box.setSelectionRange(box.value.length, box.value.length);
focusRow(results.querySelector(".item"));
