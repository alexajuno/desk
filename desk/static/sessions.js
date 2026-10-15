// The Sessions page (sessions.html), with the keys of Linear's search page as measured on linear.app on 15 Oct:
// typing in the top bar filters the rows at once; ↓ goes into the list, where ↑ ↓ and J K move (desk.js's rows),
// and ↑ on the first row comes back to the box; Enter opens the session in its kitty window over desk; Esc clears
// the box, and on an empty box goes back to the page you came from. Ctrl F and / put the cursor back in the box.
// The pills pick how the sessions started, and the next rows load as the list's end scrolls into view.

const box = document.getElementById("search-q");
const list = document.getElementById("session-rows");
const clear = document.querySelector(".search-clear");
let kind = new URLSearchParams(location.search).get("kind") ?? "", asked = 0, watcher = null;

const query = () => new URLSearchParams({ ...(box.value.trim() && { q: box.value.trim() }), ...(kind && { kind }) });
const open = (row) => row && openWindow(`/sessions/${row.dataset.session}/open`);

async function search() {
  const mine = ++asked, q = query();
  history.replaceState(null, "", q.size ? `/sessions?${q}` : "/sessions");
  clear.hidden = !box.value;
  const html = await (await fetch(`/sessions/rows?${q}`)).text();
  if (mine !== asked) return;
  list.innerHTML = html;
  focusRow(null);
  watchEnd();
}

// The next rows, once the list's end comes near; a time group that goes on joins the one drawn above it.
function watchEnd() {
  watcher?.disconnect();
  const end = list.querySelector(".session-more");
  if (!end) return;
  watcher = new IntersectionObserver(async ([seen]) => {
    if (!seen.isIntersecting) return;
    watcher.disconnect();
    const mine = asked, q = query();
    q.set("offset", end.dataset.next);
    const html = await (await fetch(`/sessions/rows?${q}`)).text();
    if (mine !== asked) return;
    const more = document.createElement("div");
    more.innerHTML = html;
    end.remove();
    const first = more.querySelector(".group"), last = [...list.querySelectorAll(".group")].pop();
    if (first && last?.dataset.group === first.dataset.group) {
      last.nextElementSibling.append(...first.nextElementSibling.children);
      first.nextElementSibling.remove();
      first.remove();
    }
    list.append(...more.childNodes);
    watchEnd();
  }, { root: document.querySelector(".scroll"), rootMargin: "400px" });
  watcher.observe(end);
}

box.addEventListener("input", search);

box.addEventListener("keydown", (e) => {
  const key = keyOf(e);
  if (key === "ArrowDown") { e.preventDefault(); box.blur(); focusRow(rows()[0]); }
  else if (key === "Enter") { e.preventDefault(); open(focused ?? rows()[0]); }
  else if (key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // desk.js would only leave the box
    if (box.value) { box.value = ""; search(); }
    else if (document.referrer.startsWith(location.origin)) history.back();
    else box.blur();
  }
});

// Before desk.js's keys: ↑ on the first row goes back to the box, and Ctrl F finds in the list, not the page.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyF") { e.preventDefault(); box.focus(); box.select(); return; }
  if (typing(e.target) || menu || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "ArrowUp" || e.key.toLowerCase() === "k") && focused && focused === rows()[0]) {
    e.preventDefault();
    e.stopImmediatePropagation();
    focusRow(null);
    box.focus();
  }
}, true);

list.addEventListener("click", (e) => {
  if (e.target.closest("a, .group")) return; // the issue's link opens the issue; a group's header folds it
  open(e.target.closest(".session-row"));
});

document.querySelector(".session-bar").addEventListener("click", (e) => {
  const pill = e.target.closest(".pill-tab");
  if (!pill) return;
  kind = pill.dataset.kind;
  for (const other of document.querySelectorAll(".pill-tab")) other.classList.toggle("on", other === pill);
  search();
  box.focus();
});

clear.addEventListener("click", () => { box.value = ""; search(); box.focus(); });

// A change to the issues redraws only the sidebar here (desk.js's soft refresh), so the rows loaded and what is
// typed stay; a state circle is as fresh as the page or the last search.
window.onIssuesChanged = () => {};

box.focus();
box.setSelectionRange(box.value.length, box.value.length);
watchEnd();
