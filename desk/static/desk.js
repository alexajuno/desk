// Linear-style menus, keyboard shortcuts and a full-screen diagram viewer.
// Shortcuts: S status, P priority, C create, J/K or arrows to move, Enter to open,
// G then B backlog, ? help, Esc to close. G then I and ? are from Linear's guide
// (linear.app/enablement/guide/navigating-linear); S, P and C follow Linear, and the S menu's
// shape (filter on top, numbered rows, a tick on the current one) was copied from linear.app.

const DESK = JSON.parse(document.getElementById("desk-data").textContent);
const ICONS = document.getElementById("icons").content;
const icon = (field, value) => ICONS.querySelector(`[data-k="${field}-${value}"]`)?.innerHTML ?? "";
const nameOf = (field, value) => (field === "priority" ? DESK.prio_names : DESK.state_names)[value];
const scroller = () => document.querySelector(".scroll");

// --- menu -------------------------------------------------------------------------------
let menu = null;

function closeMenu() {
  if (menu) { menu.remove(); menu = null; }
}

function openMenu(anchor, field, current, onPick) {
  closeMenu();
  // Linear numbers priority 0 for none, then 1 urgent to 4 low; statuses count from 1.
  const values = field === "priority" ? ["none", "urgent", "high", "medium", "low"] : DESK.states;
  const number = (v) => (field === "priority" ? values.indexOf(v) : values.indexOf(v) + 1);
  menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = `<div class="menu-head"><input class="menu-filter" type="text" placeholder="Change ${field === "state" ? "status" : field}…" autocomplete="off">` +
    `<kbd>${field === "state" ? "S" : "P"}</kbd></div><ul></ul>`;
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(box.left, innerWidth - 280)}px`;
  menu.style.top = `${Math.min(box.bottom + 4, innerHeight - 320)}px`;
  menu.style.position = "fixed";
  const input = menu.querySelector("input"), list = menu.querySelector("ul");
  let shown = values, at = Math.max(0, values.indexOf(current));

  const tick = '<svg class="tick" viewBox="0 0 14 14" width="14" height="14"><path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function draw() {
    list.innerHTML = shown.map((v, i) =>
      `<li class="${i === at ? "on" : ""} ${v === current ? "current" : ""}" data-v="${v}">${icon(field, v)}` +
      `<span class="name">${nameOf(field, v)}</span>${tick}<span class="num">${number(v)}</span></li>`).join("");
  }
  draw();
  input.focus();
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    shown = values.filter((v) => nameOf(field, v).toLowerCase().includes(q));
    at = 0; draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { at = Math.min(at + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { at = Math.max(at - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[at]) { pick(shown[at]); }
    else if (e.key === "Escape") { closeMenu(); }
    else if (/^[0-9]$/.test(e.key) && !input.value) {
      const v = field === "priority" ? values[+e.key] : values[+e.key - 1];
      if (v) { pick(v); e.preventDefault(); }
    }
  });
  list.addEventListener("mousemove", (e) => {
    const li = e.target.closest("li");
    if (li) { const i = shown.indexOf(li.dataset.v); if (i !== at) { at = i; draw(); } }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { pick(li.dataset.v); e.preventDefault(); }
  });
  function pick(v) { closeMenu(); if (v !== current) onPick(v); }
}

document.addEventListener("mousedown", (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });

async function setField(slug, field, value) {
  await fetch(`/issue/${slug}/set`, { method: "POST", body: new URLSearchParams({ field, value }) });
  sessionStorage.y = scroller().scrollTop;
  location.reload();
}

document.querySelectorAll(".pick").forEach((button) => {
  button.addEventListener("click", () =>
    openMenu(button, button.dataset.field, button.dataset.value, (v) => setField(button.dataset.slug, button.dataset.field, v)));
});

// --- Works in: a folder picker with your repos and path completion ---------------------------
function openFolderPicker(anchor, slug, current) {
  closeMenu();
  menu = document.createElement("div");
  menu.className = "menu folders";
  menu.innerHTML = '<div class="menu-head"><input class="menu-filter" type="text" placeholder="Search repos, or type ~/path…" autocomplete="off"></div><ul></ul>';
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  Object.assign(menu.style, { position: "fixed", left: `${Math.min(box.left, innerWidth - 380)}px`, top: `${Math.min(box.bottom + 4, innerHeight - 360)}px` });
  const input = menu.querySelector("input"), list = menu.querySelector("ul");
  const folderIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" stroke="currentColor" stroke-width="1.2"/></svg>';
  let shown = [], at = 0, ask = 0;
  const draw = () => {
    list.innerHTML = shown.length ? shown.map((p, i) => `<li class="${i === at ? "on" : ""} ${p === current ? "current" : ""}" data-v="${p}">${folderIcon}<span class="name">${p}</span></li>`).join("")
      : '<li class="empty">No folder matches</li>';
  };
  async function load() {
    const mine = ++ask;
    const paths = await (await fetch(`/api/folders?q=${encodeURIComponent(input.value)}`)).json();
    if (mine !== ask) return;
    shown = paths; at = 0; draw();
  }
  input.value = current && current.startsWith("~") ? "" : "";
  load();
  input.focus();
  input.addEventListener("input", load);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { at = Math.min(at + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { at = Math.max(at - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Tab" && shown[at]) { input.value = shown[at] + "/"; load(); e.preventDefault(); }
    else if (e.key === "Enter") { const v = shown[at] || input.value.trim(); if (v) pick(v); e.preventDefault(); }
    else if (e.key === "Escape") { closeMenu(); }
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("li[data-v]"); if (li) { pick(li.dataset.v); e.preventDefault(); } });
  async function pick(folder) {
    closeMenu();
    await fetch(`/issue/${slug}/folder`, { method: "POST", body: new URLSearchParams({ folder }) });
    location.reload();
  }
}

document.querySelectorAll(".folder-pick").forEach((button) =>
  button.addEventListener("click", () => openFolderPicker(button, button.dataset.slug, button.dataset.value)));

// --- rows: hover or J/K focuses one, as in Linear ------------------------------------------
const rows = () => [...document.querySelectorAll(".item")];
let focused = null;

function focusRow(row) {
  if (focused) focused.classList.remove("focus");
  focused = row;
  if (row) { row.classList.add("focus"); row.scrollIntoView({ block: "nearest" }); }
}

rows().forEach((row) => row.addEventListener("mousemove", () => { if (focused !== row) focusRow(row); }));

function moveFocus(step) {
  const all = rows();
  if (!all.length) return;
  const i = focused ? all.indexOf(focused) : -1;
  focusRow(all[Math.max(0, Math.min(all.length - 1, i + step))]);
}

// --- diagram viewer: click to open full screen, wheel to zoom, drag to move -------------------
let viewer = null;

function openViewer(svg) {
  viewer = document.createElement("div");
  viewer.className = "viewer";
  viewer.innerHTML = '<div class="viewer-stage"></div><div class="viewer-help">Wheel to zoom · drag to move · double-click to fit · Esc to close</div>';
  const stage = viewer.querySelector(".viewer-stage");
  const copy = svg.cloneNode(true);
  copy.removeAttribute("style");
  stage.append(copy);
  document.body.append(viewer);
  let scale = 1, x = 0, y = 0, drag = null;
  const apply = () => { stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const fit = () => {
    const w = copy.viewBox.baseVal?.width || copy.getBoundingClientRect().width;
    const h = copy.viewBox.baseVal?.height || copy.getBoundingClientRect().height;
    copy.setAttribute("width", w); copy.setAttribute("height", h);
    scale = Math.min((innerWidth - 80) / w, (innerHeight - 80) / h);
    x = (innerWidth - w * scale) / 2; y = (innerHeight - h * scale) / 2; apply();
  };
  fit();
  viewer.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    x = e.clientX - (e.clientX - x) * k; y = e.clientY - (e.clientY - y) * k; scale *= k; apply();
  }, { passive: false });
  viewer.addEventListener("mousedown", (e) => { drag = { sx: e.clientX - x, sy: e.clientY - y }; viewer.classList.add("dragging"); });
  viewer.addEventListener("mousemove", (e) => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
  viewer.addEventListener("mouseup", () => { drag = null; viewer.classList.remove("dragging"); });
  viewer.addEventListener("dblclick", fit);
}

function closeViewer() {
  if (viewer) { viewer.remove(); viewer = null; }
}

document.querySelectorAll(".d2").forEach((d) => d.addEventListener("click", () => openViewer(d.querySelector("svg"))));

// --- keys ------------------------------------------------------------------------------------
let gPressed = 0;
const typing = (t) => t.closest("input, textarea, select, [contenteditable]");

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && viewer) { closeViewer(); return; }
  if (menu || viewer || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();

  if (gPressed && Date.now() - gPressed < 1500) {
    gPressed = 0;
    if (key === "b") location.href = "/backlog";
    if (key === "i") location.href = "/inbox";
    return;
  }
  if (key === "g") { gPressed = Date.now(); return; }

  if (key === "j" || e.key === "ArrowDown") { moveFocus(1); e.preventDefault(); }
  else if (key === "k" || e.key === "ArrowUp") { moveFocus(-1); e.preventDefault(); }
  else if (e.key === "Enter" && focused) { location.href = focused.getAttribute("href"); }
  else if (key === "c") { const add = document.querySelector(".create input[name=title]"); if (add) { add.focus(); e.preventDefault(); } }
  else if (key === "s" || key === "p") {
    const field = key === "s" ? "state" : "priority";
    if (focused) {
      const row = focused;
      openMenu(row, field, row.dataset[field], (v) => setField(row.dataset.slug, field, v));
    } else {
      document.querySelector(`.pick[data-field=${field}]`)?.click();
    }
    e.preventDefault();
  }
  else if (e.key === "?") { document.getElementById("keys").classList.toggle("open"); }
  else if (e.key === "Escape") { document.getElementById("keys").classList.remove("open"); focusRow(null); }
});
