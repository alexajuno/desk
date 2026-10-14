// Linear-style menus, row actions, inline edits, delete with undo, and a full-screen diagram viewer.
// Shortcuts: S status, P priority, C create, J/K or arrows to move, Enter to open, right-click for a
// row's actions, Ctrl+Delete to delete and Ctrl+Z to undo it, / search, G then B backlog, ? help, Esc to close
// (on an issue, Esc goes back). G then I and ? are from Linear's guide
// (linear.app/enablement/guide/navigating-linear); S, P and C follow Linear, and the S menu's
// shape (filter on top, numbered rows, a tick on the current one) was copied from linear.app.
// Delete, its undo toast and Ctrl+Z follow linear.app/docs/delete-archive-issues.
//
// Every handler is delegated to the document, so a soft refresh can swap the page's content
// without rebinding anything.

const DESK = JSON.parse(document.getElementById("desk-data").textContent);
const ICONS = document.getElementById("icons").content;
const icon = (field, value) => ICONS.querySelector(`[data-k="${field}-${value}"]`)?.innerHTML ?? "";
const nameOf = (field, value) => (field === "priority" ? DESK.prio_names : DESK.state_names)[value];
const $ = (selector) => document.querySelector(selector);
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const typing = (el) => el?.closest?.("input, textarea, select, [contenteditable]");
const post = (url, fields = {}) => fetch(url, { method: "POST", body: new URLSearchParams(fields) });
const reason = async (res) => { try { return (await res.json()).detail; } catch { return `Failed (${res.status})`; } };
const page = () => $(".issue")?.dataset; // the issue this page shows, on an issue page
// Vietnamese titles match without their marks: "viec" finds "việc".
const fold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").toLowerCase();

const svg = (path) => `<svg class="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const GLYPH = {
  parent: svg('<path d="M4.5 2.5v6a2 2 0 0 0 2 2h6M10 8l2.5 2.5L10 13"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  link: svg('<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5"/>'),
  id: svg('<path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  none: svg('<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>'),
  folder: svg('<path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z"/>'),
};
const TICK = '<svg class="tick" viewBox="0 0 14 14" width="14" height="14"><path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// --- keys through an input method ----------------------------------------------------------------
// With an input method (fcitx5 on Wayland, typing Vietnamese) a key pressed in a text box can arrive
// as "Process" or "Unidentified", or not at all; e.code still names the physical key.
const BY_CODE = { Escape: "Escape", Enter: "Enter", NumpadEnter: "Enter", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
                  Backspace: "Backspace", Tab: "Tab" };

function keyOf(e) {
  if (e.key !== "Process" && e.key !== "Unidentified") return e.key;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  return BY_CODE[e.code] ?? (digit ? digit[1] : e.key);
}

// --- one menu for every menu ---------------------------------------------------------------------
// openMenu({ anchor | x, y, filter, placeholder, kbd, items, empty, onEnter, onTab, className })
// items(query) returns, or resolves to, rows of { label, icon, hint, num, key, current, more, group, run }.
// filter "keys": typing filters, but nothing editable takes focus, so no input method stands between
//   the keys and the menu (the S that opened it gets through for the same reason);
// filter "input": a real text box, for titles and paths typed in any language;
// no filter: a list of actions, picked by arrows, Enter, or a row's own key.
// Keys are read on the window in the capture phase, before any other handler, and Escape's keyup
// closes the menu too, in case its keydown never arrived.
let menu = null, justClosed = null;

function closeMenu() {
  if (!menu) return;
  removeEventListener("keydown", menu.onKey, true);
  removeEventListener("keyup", menu.onKey, true);
  menu.el.remove();
  menu = null;
}

function openMenu(o) {
  closeMenu();
  const el = document.createElement("div");
  el.className = `menu ${o.className ?? ""}`;
  el.tabIndex = -1;
  const filter = o.filter === "input" ? `<input class="menu-filter" type="text" placeholder="${esc(o.placeholder)}" autocomplete="off">`
    : o.filter === "keys" ? `<div class="menu-filter" data-placeholder="${esc(o.placeholder)}"></div>` : "";
  el.innerHTML = (filter ? `<div class="menu-head">${filter}${o.kbd ? `<kbd>${o.kbd}</kbd>` : ""}</div>` : "") + "<ul></ul>";
  document.body.append(el);
  const input = el.querySelector(".menu-filter"), list = el.querySelector("ul");
  let query = "", shown = [], at = 0, asked = 0, composing = false, escDown = false;

  function place() {
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = o.x, y = o.y;
    if (o.anchor) {
      const box = o.anchor.getBoundingClientRect();
      x = box.left; y = box.bottom + 4;
      if (y + h > innerHeight - 8) y = Math.max(8, box.top - 4 - h);
    } else if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - 8 - h);
    el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    el.style.top = `${y}px`;
  }

  function draw() {
    let group;
    list.innerHTML = shown.length ? shown.map((item, i) => {
      const line = i && item.group !== group ? '<li class="divider" role="separator"></li>' : "";
      group = item.group;
      return `${line}<li class="${i === at ? "on" : ""}${item.current ? " current" : ""}" data-i="${i}">${item.icon ?? ""}` +
        `<span class="name">${esc(item.label)}</span>${item.current ? TICK : ""}` +
        `${item.hint !== undefined ? `<span class="shortcut">${esc(item.hint)}</span>` : ""}${item.more ? CHEVRON : ""}</li>`;
    }).join("") : `<li class="empty">${esc(o.empty ?? "No match")}</li>`;
    place();
  }

  function light(i) {
    if (!shown.length) return;
    at = Math.max(0, Math.min(shown.length - 1, i));
    list.querySelector("li.on")?.classList.remove("on");
    const li = list.querySelector(`li[data-i="${at}"]`);
    li?.classList.add("on");
    li?.scrollIntoView({ block: "nearest" });
  }

  async function load(first) {
    const mine = ++asked;
    const items = await o.items(query);
    if (mine !== asked || menu?.el !== el) return;
    shown = items;
    at = first ? Math.max(0, items.findIndex((item) => item.current)) : 0;
    draw();
  }

  function setQuery(text) {
    query = text;
    if (o.filter === "input") input.value = text;
    else if (input) input.textContent = text;
    load(false);
  }

  function pick(i) {
    const item = shown[i];
    if (!item?.run) return;
    closeMenu();
    item.run();
  }

  function onKey(e) {
    const k = keyOf(e);
    if (e.type === "keyup") {
      if (k === "Escape") {
        if (!escDown) closeMenu();
        escDown = false;
        e.stopImmediatePropagation();
      }
      return;
    }
    if (k === "Escape") escDown = true;
    if (o.filter === "input" && (e.isComposing || composing)) return; // the input method owns this key
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    let i, handled = true;
    if (k === "Escape") closeMenu();
    else if (k === "ArrowDown" || (e.ctrlKey && k === "n")) light(at + 1);
    else if (k === "ArrowUp" || (e.ctrlKey && k === "p")) light(at - 1);
    else if (k === "Enter") {
      if (shown[at]) pick(at);
      else if (o.onEnter) { const typed = query; closeMenu(); o.onEnter(typed); }
    }
    else if (k === "Tab") o.onTab?.(shown[at], setQuery);
    else if (o.filter !== "input" && plain && /^\d$/.test(k) && !query && (i = shown.findIndex((item) => item.num === +k)) >= 0) pick(i);
    else if (!o.filter && plain && (i = shown.findIndex((item) => item.key === k.toLowerCase())) >= 0) pick(i);
    else if (o.filter === "keys" && k === "Backspace") setQuery(query.slice(0, -1));
    else if (o.filter === "keys" && plain && k.length === 1) setQuery(query + k);
    else handled = false;
    if (handled) e.preventDefault();
    // In a text box the other keys type; elsewhere, no shortcut acts under an open menu.
    if (handled || o.filter !== "input") e.stopImmediatePropagation();
  }

  menu = { el, anchor: o.anchor, onKey };
  addEventListener("keydown", onKey, true);
  addEventListener("keyup", onKey, true);
  list.addEventListener("mousemove", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li && +li.dataset.i !== at) light(+li.dataset.i);
  });
  list.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keeps focus in the filter
    const li = e.target.closest("li[data-i]");
    if (li && e.button === 0) pick(+li.dataset.i);
  });
  if (o.filter === "input") {
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    input.addEventListener("input", () => { query = input.value; load(false); });
    input.focus();
  } else {
    if (typing(document.activeElement)) document.activeElement.blur();
    el.focus({ preventScroll: true });
  }
  place();
  load(true);
}

// A mousedown outside closes the menu; the click that follows on the same button must not reopen it.
document.addEventListener("mousedown", (e) => {
  justClosed = menu && !menu.el.contains(e.target) ? menu.anchor : null;
  if (menu && !menu.el.contains(e.target)) closeMenu();
}, true);

// --- the menus -----------------------------------------------------------------------------------
// Linear numbers priority 0 for none, then 1 urgent to 4 low; statuses count from 1.
function fieldMenu(slug, field, current, where) {
  const values = field === "priority" ? ["none", "urgent", "high", "medium", "low"] : DESK.states;
  const num = (v) => values.indexOf(v) + (field === "priority" ? 0 : 1);
  openMenu({
    ...where, filter: "keys", kbd: field === "state" ? "S" : "P",
    placeholder: `Change ${field === "state" ? "status" : "priority"}…`,
    items: (q) => values.filter((v) => nameOf(field, v).toLowerCase().includes(q.toLowerCase())).map((v) => ({
      icon: icon(field, v), label: nameOf(field, v), hint: num(v), num: num(v), current: v === current,
      run: () => { if (v !== current) setField(slug, field, v); },
    })),
  });
}

// The actions on one issue: a row's right-click menu, and the issue page's "…" button.
function actionsMenu(issue, where) {
  openMenu({
    ...where, className: "actions",
    items: () => [
      { group: 0, icon: icon("state", issue.state), label: "Status", hint: "S", key: "s", more: true,
        run: () => fieldMenu(issue.slug, "state", issue.state, where) },
      { group: 0, icon: icon("priority", issue.priority), label: "Priority", hint: "P", key: "p", more: true,
        run: () => fieldMenu(issue.slug, "priority", issue.priority, where) },
      { group: 0, icon: GLYPH.parent, label: "Set parent…", more: true, run: () => parentMenu(issue, where) },
      { group: 0, icon: GLYPH.plus, label: "Add sub-issue", run: () => addSubIssue(issue.slug, where) },
      { group: 1, icon: GLYPH.link, label: "Copy link", run: () => copy(`${location.origin}/issue/${issue.slug}`, "Link copied") },
      { group: 1, icon: GLYPH.id, label: "Copy ID", run: () => copy(issue.slug, "ID copied") },
      { group: 2, icon: GLYPH.trash, label: "Delete", hint: "Ctrl ⌫", run: () => remove(issue.slug) },
    ],
  });
}

// Open issues to move under, from the server, which leaves out the issue and its own sub-issues.
function parentMenu(issue, where) {
  const choices = fetch(`/api/issues?exclude=${encodeURIComponent(issue.slug)}`).then((res) => res.json());
  const move = (to) => () => { if (to !== (issue.parent || "")) setField(issue.slug, "parent", to); };
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Set parent…", empty: "No open issue matches",
    items: async (q) => {
      const phrase = fold(q).trim(), words = phrase.split(/\s+/).filter(Boolean);
      const text = (item) => fold(item.slug ? `${item.label} ${item.slug}` : item.label);
      const none = { icon: GLYPH.none, label: "No parent", current: !issue.parent, run: move("") };
      const all = [none, ...(await choices).map((i) => ({ icon: icon("state", i.state), label: i.title, slug: i.slug,
        current: i.slug === issue.parent, run: move(i.slug) }))];
      // Every word must match; the whole phrase matching puts an issue first.
      return all.filter((item) => words.every((w) => text(item).includes(w)))
        .sort((a, b) => !text(a).includes(phrase) - !text(b).includes(phrase));
    },
  });
}

// On the issue's own page the sub-issue box is right there; elsewhere a small box asks for the title.
function addSubIssue(slug, where) {
  if (page()?.slug === slug) {
    const box = $(".issue .create input[name=title]");
    box.scrollIntoView({ block: "center", behavior: "instant" });
    box.focus();
    return;
  }
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "New sub-issue title…", empty: "Type its title, then Enter",
    items: (q) => (q.trim() ? [{ icon: GLYPH.plus, label: `Create “${q.trim()}”`, run: () => create(slug, q.trim()) }] : []),
  });
}

function folderMenu(button) {
  const slug = button.dataset.slug, current = button.dataset.value;
  const set = (folder) => post(`/issue/${slug}/folder`, { folder }).then(() => refresh());
  openMenu({
    anchor: button, filter: "input", className: "folders", placeholder: "Search repos, or type ~/path…", empty: "No folder matches",
    items: async (q) => (await (await fetch(`/api/folders?q=${encodeURIComponent(q)}`)).json())
      .map((path) => ({ icon: GLYPH.folder, label: path, current: path === current, run: () => set(path) })),
    onTab: (item, setQuery) => { if (item) setQuery(`${item.label}/`); },
    onEnter: (typed) => { if (typed.trim()) set(typed.trim()); },
  });
}

// --- changes: shown at once, then saved, then the page refreshes softly -----------------------------
function paint(slug, field, value) {
  document.querySelectorAll(`[data-slug="${CSS.escape(slug)}"]`).forEach((el) => { if (field in el.dataset) el.dataset[field] = value; });
  document.querySelectorAll(`.icon[data-field="${field}"], .field-label[data-field="${field}"]`).forEach((el) => {
    if (el.closest("[data-slug]")?.dataset.slug !== slug) return;
    if (el.matches(".icon")) el.innerHTML = icon(field, value);
    else el.textContent = nameOf(field, value);
  });
}

async function setField(slug, field, value) {
  if (field === "state" || field === "priority") paint(slug, field, value);
  const res = await post(`/issue/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
  await refresh();
}

async function create(parent, title) {
  const res = await post("/issues", { title, parent, priority: "none" });
  toast(res.ok ? "Sub-issue created" : await reason(res));
  await refresh();
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  toast(done);
}

// --- delete and undo -----------------------------------------------------------------------------
// Deleted issues wait in desk's trash; the undo list lives in sessionStorage, so Ctrl+Z still works
// after you move to another page.
const undoList = () => JSON.parse(sessionStorage.undo ?? "[]");

async function remove(slug) {
  const res = await post(`/issue/${slug}/delete`);
  if (!res.ok) return toast(await reason(res));
  const { deleted, parent } = await res.json();
  const here = page()?.slug, left = here && deleted.includes(here);
  const to = left ? (parent && !deleted.includes(parent) ? `/issue/${parent}` : "/backlog") : null;
  sessionStorage.undo = JSON.stringify([...undoList(), { slug, back: left ? location.pathname : null, to }].slice(-20));
  if (focused && deleted.includes(focused.dataset.slug)) focusRow(null);
  const kids = deleted.length - 1;
  toast(kids ? `Issue and ${kids} sub-issue${kids > 1 ? "s" : ""} deleted` : "Issue deleted", { label: "Undo", kbd: "Ctrl Z", run: undo });
  if (to) await go(to);
  else await refresh();
}

async function undo() {
  const list = undoList(), last = list.pop();
  if (!last) return;
  sessionStorage.undo = JSON.stringify(list);
  const res = await post(`/trash/${last.slug}/restore`);
  if (!res.ok) return toast(await reason(res));
  toast("Issue restored");
  if (last.back && location.pathname === last.to) await go(last.back);
  else await refresh();
}

let toastTimer = 0;

function toast(text, action) {
  $(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(text)}</span>` +
    (action ? `<span class="dot">·</span><button class="undo">${esc(action.label)}</button><kbd>${action.kbd}</kbd>` : "");
  el.querySelector("button")?.addEventListener("click", () => { el.remove(); action.run(); });
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), action ? 8000 : 3000);
}

// --- soft refresh --------------------------------------------------------------------------------
// Fetches the page and swaps its sidebar, top bar and content, keeping the scroll position: no reload.
// A page that redraws itself (search, whose box sits in the top bar) sets window.onIssuesChanged;
// there only the sidebar is swapped, and the page does the rest.
let seen = DESK.version, refreshes = 0; // the version of the issues this page was made from

async function refresh(url = location.pathname + location.search) {
  const mine = ++refreshes;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return false;
    const fresh = new DOMParser().parseFromString(await res.text(), "text/html");
    if (mine !== refreshes) return false;
    seen = JSON.parse(fresh.getElementById("desk-data").textContent).version;
    const same = url === location.pathname + location.search, y = $(".scroll").scrollTop;
    const redraws = same && window.onIssuesChanged;
    for (const part of redraws ? [".side"] : [".side", ".bar", ".scroll"]) {
      const from = fresh.querySelector(part);
      if (from) $(part).innerHTML = from.innerHTML;
    }
    if (redraws) { onIssuesChanged(); return true; }
    document.title = fresh.title;
    $(".scroll").scrollTop = same ? y : 0;
    if (focused) focusRow(document.querySelector(`.item[data-slug="${CSS.escape(focused.dataset.slug)}"]`), false);
    return true;
  } catch {
    return false;
  }
}

// Moves to another page the same way; the page left behind, a deleted issue, leaves the history.
async function go(url) {
  if (await refresh(url)) history.replaceState(null, "", url);
  else location.href = url;
}

// Agents and the user's editor change issues too: poll /version and refresh, unless a menu, an
// editor or a text box is in use; the refresh then waits for the next tick after it.
const busy = () => menu || viewer || editing || typing(document.activeElement);

setInterval(async () => {
  try {
    const v = await (await fetch("/version", { cache: "no-store" })).text();
    if (v !== seen && !busy()) await refresh();
  } catch {}
}, 1500);

// --- the issue page: click the title or the description to edit it -------------------------------
let editing = null;
const raw = () => JSON.parse($("#issue-raw").textContent);

// Enter during composition belongs to the input method, not to the editor.
function openEditor(box, shown, isSave, save) {
  let composing = false, escDown = false, done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    editing = null;
    const value = box.value;
    box.replaceWith(shown);
    if (keep) save(value);
  };
  box.addEventListener("compositionstart", () => { composing = true; });
  box.addEventListener("compositionend", () => { composing = false; });
  box.addEventListener("keydown", (e) => {
    const k = keyOf(e);
    if (k === "Escape") escDown = true;
    if (e.isComposing || composing) return;
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    else if (isSave(e, k)) { e.preventDefault(); finish(true); }
  });
  box.addEventListener("keyup", (e) => {
    if (keyOf(e) === "Escape" && !escDown) finish(false);
    escDown = false;
  });
  box.addEventListener("blur", () => finish(true));
  shown.replaceWith(box);
  editing = box;
  box.focus({ preventScroll: true });
}

function editTitle(h1) {
  const slug = page().slug, before = raw().title;
  const box = Object.assign(document.createElement("input"), { type: "text", className: "title-edit", value: before });
  openEditor(box, h1, (e, k) => k === "Enter", (value) => {
    const title = value.trim().replace(/\s+/g, " ");
    if (!title || title === before) return;
    h1.textContent = title;
    setField(slug, "title", title);
  });
  box.setSelectionRange(before.length, before.length);
}

// The caret goes where you clicked, found by the text around that spot in the Markdown.
function caretAt(e, markdown) {
  const spot = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!spot || spot.startContainer.nodeType !== Node.TEXT_NODE) return markdown.length;
  const text = spot.startContainer.textContent, i = spot.startOffset;
  const before = text.slice(Math.max(0, i - 16), i), after = text.slice(i, i + 16);
  for (const [probe, shift] of [[before + after, before.length], [after, 0], [before, before.length]]) {
    const found = probe.trim() ? markdown.indexOf(probe) : -1;
    if (found >= 0) return found + shift;
  }
  return markdown.length;
}

function editBody(div, click) {
  const slug = page().slug, before = raw().body;
  const box = Object.assign(document.createElement("textarea"), { className: "body-edit", value: before, placeholder: "Add description…" });
  const fit = () => { box.style.height = "auto"; box.style.height = `${box.scrollHeight + 2}px`; };
  const caret = div.classList.contains("empty") ? 0 : caretAt(click, before);
  box.addEventListener("input", fit);
  openEditor(box, div, (e, k) => k === "Enter" && (e.ctrlKey || e.metaKey), (value) => {
    if (value.trim() !== before.trim()) setField(slug, "body", value);
  });
  fit();
  box.setSelectionRange(caret, caret);
}

// Esc on an issue goes back to where you came from, or up to its parent or the backlog.
function goBack() {
  const from = document.referrer;
  if (from.startsWith(location.origin) && new URL(from).pathname !== location.pathname && history.length > 1) history.back();
  else location.href = page().parent ? `/issue/${page().parent}` : "/backlog";
}

// --- rows: hover or J/K focuses one, as in Linear ------------------------------------------------
const rows = () => [...document.querySelectorAll(".item")];
let focused = null, byMouse = false;

function focusRow(row, scroll = true) {
  if (focused) focused.classList.remove("focus");
  focused = row;
  byMouse = false;
  if (row) {
    row.classList.add("focus");
    if (scroll) row.scrollIntoView({ block: "nearest" });
  }
}

function moveFocus(step) {
  const all = rows();
  if (!all.length) return;
  const i = focused ? all.indexOf(focused) : -1;
  focusRow(all[Math.max(0, Math.min(all.length - 1, i + step))]);
}

// On an issue page a sub-issue keeps the focus only while the mouse is on it, so S and P off the
// list act on the issue itself.
document.addEventListener("mousemove", (e) => {
  if (menu) return;
  const row = e.target.closest?.(".item");
  if (row && row !== focused) { focusRow(row, false); byMouse = true; }
  else if (!row && byMouse && page()) focusRow(null);
});

document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".item");
  if (!row) return;
  e.preventDefault();
  focusRow(row, false);
  actionsMenu({ ...row.dataset }, { x: e.clientX, y: e.clientY });
});

document.addEventListener("click", (e) => {
  const t = e.target, closed = justClosed;
  const toggled = (anchor) => anchor === closed;
  justClosed = null;
  if (t.closest(".menu")) return;
  const rowIcon = t.closest(".item .icon");
  if (rowIcon) {
    e.preventDefault(); // the row is a link
    const row = rowIcon.closest(".item"), field = rowIcon.dataset.field;
    if (!toggled(rowIcon)) fieldMenu(row.dataset.slug, field, row.dataset[field], { anchor: rowIcon });
    return;
  }
  const pick = t.closest(".pick");
  if (pick) {
    if (!toggled(pick)) fieldMenu(pick.dataset.slug, pick.dataset.field, pick.dataset[pick.dataset.field], { anchor: pick });
    return;
  }
  const folder = t.closest(".folder-pick");
  if (folder) { if (!toggled(folder)) folderMenu(folder); return; }
  const more = t.closest(".bar .more");
  if (more && page()) { if (!toggled(more)) actionsMenu({ ...page() }, { anchor: more }); return; }
  const d2 = t.closest(".d2");
  if (d2) { openViewer(d2.querySelector("svg")); return; }
  const title = t.closest(".issue h1.title");
  if (title) { editTitle(title); return; }
  const text = t.closest(".issue .description");
  if (text && !t.closest("a, button, input, textarea") && !getSelection().toString()) editBody(text, e);
});

// The create box adds the issue without a reload, and stays ready for the next one.
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form.create");
  if (!form) return;
  e.preventDefault();
  const fields = new URLSearchParams(new FormData(form)), parent = fields.get("parent") ?? "";
  if (!fields.get("title").trim()) return;
  const res = await fetch(form.action, { method: "POST", body: fields });
  if (!res.ok) toast(await reason(res));
  await refresh();
  [...document.querySelectorAll("form.create")].find((f) => (f.elements.parent?.value ?? "") === parent)?.elements.title.focus();
});

// --- diagram viewer: click to open full screen, wheel to zoom, drag to move ----------------------
let viewer = null;

function openViewer(svgEl) {
  viewer = document.createElement("div");
  viewer.className = "viewer";
  viewer.innerHTML = '<div class="viewer-stage"></div><div class="viewer-help">Wheel to zoom · drag to move · double-click to fit · Esc to close</div>';
  const stage = viewer.querySelector(".viewer-stage");
  const copyOf = svgEl.cloneNode(true);
  copyOf.removeAttribute("style");
  stage.append(copyOf);
  document.body.append(viewer);
  let scale = 1, x = 0, y = 0, drag = null;
  const apply = () => { stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const fit = () => {
    const w = copyOf.viewBox.baseVal?.width || copyOf.getBoundingClientRect().width;
    const h = copyOf.viewBox.baseVal?.height || copyOf.getBoundingClientRect().height;
    copyOf.setAttribute("width", w); copyOf.setAttribute("height", h);
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

// --- keys ----------------------------------------------------------------------------------------
let gPressed = 0;
const target = () => focused?.dataset.slug ?? page()?.slug; // what S, P and Ctrl+Delete act on

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && viewer) { closeViewer(); return; }
  if (menu || viewer || editing) return;
  if (typing(e.target)) { if (e.key === "Escape") e.target.blur(); return; }
  const key = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    if (key === "z" && undoList().length) { undo(); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && target()) { remove(target()); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

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
  else if (key === "c") { const add = $(".create input[name=title]"); if (add) { add.focus(); e.preventDefault(); } }
  else if (key === "s" || key === "p") {
    const field = key === "s" ? "state" : "priority";
    const row = focused, pick = $(`.pick[data-field=${field}]`);
    if (row) fieldMenu(row.dataset.slug, field, row.dataset[field], { anchor: row.querySelector(`.icon[data-field=${field}]`) });
    else if (pick) fieldMenu(pick.dataset.slug, field, pick.dataset[field], { anchor: pick });
    e.preventDefault();
  }
  else if (e.key === "/") { const box = document.getElementById("search-q"); if (box) box.focus(); else location.href = "/search"; e.preventDefault(); }
  else if (e.key === "?") { $("#keys").classList.toggle("open"); }
  else if (e.key === "Escape") {
    if ($("#keys.open")) $("#keys").classList.remove("open");
    else if (page()) goBack();
    else focusRow(null);
  }
});
