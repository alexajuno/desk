// Linear-style menus, row actions, inline edits, the new issue panel, delete with undo, and a full-screen
// diagram viewer. Shortcuts: S status, P priority, C a new issue, T collapse a group, J/K or arrows to move,
// Enter to open, right-click for a row's actions, Ctrl+Delete to delete and Ctrl+Z to undo it, / search,
// G then B backlog, G then S sessions, G then P projects, Ctrl+Shift+O a new session, [ the sidebar, Ctrl+/ the shortcuts, Esc to
// close (on an issue, Esc goes back). The list is keys.html. Ctrl+/ is Linear's, not ?, which would type
// itself into the panel's search box as it took the focus (15 Oct). G then I is
// from Linear's guide
// (linear.app/enablement/guide/navigating-linear); S, P and C follow Linear, and the S menu's
// shape (filter on top, numbered rows, a tick on the current one) was copied from linear.app.
// Delete, its undo toast and Ctrl+Z follow linear.app/docs/delete-archive-issues. T and the group
// triangle were copied from linear.app on 2026-10-15.
//
// Every handler is delegated to the document, so a soft refresh can swap the page's content
// without rebinding anything.

const DESK = JSON.parse(document.getElementById("desk-data").textContent);
const ICONS = document.getElementById("icons").content;
const icon = (field, value) => ICONS.querySelector(`[data-k="${field}-${value}"]`)?.innerHTML ?? "";
const nameOf = (field, value) => ({ priority: DESK.prio_names, protocol: DESK.proto_names }[field] ?? DESK.state_names)[value];
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
  project: svg('<path d="M8 2l5.5 3v6L8 14l-5.5-3V5z"/>'),
  parent: svg('<path d="M4.5 2.5v6a2 2 0 0 0 2 2h6M10 8l2.5 2.5L10 13"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  link: svg('<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.5.5M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5"/>'),
  chat: svg('<path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.6 0-1.1-.1-1.6-.2L3 13.5l.6-2.3C2.6 10.3 2 9 2 7.4 2 4.7 4.7 2.5 8 2.5z"/>'),
  terminal: svg('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>'),
  id: svg('<path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  none: svg('<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>'),
  folder: svg('<path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z"/>'),
  system: svg('<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11.5V14"/>'),
  light: svg('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>'),
  dark: svg('<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/>'),
  keys: svg('<rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5"/><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6"/>'),
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
// openMenu({ anchor | x, y, filter, placeholder, query, kbd, items, empty, onEnter, onTab, onClose, className })
// items(query) returns, or resolves to, rows of { label, icon, hint, num, key, current, more, group, heading, run };
//   a group's first row may carry a heading, drawn above the group in place of the divider, as Linear's Help menu
//   heads its "What's new".
// filter "keys": typing filters, but nothing editable takes focus, so no input method stands between
//   the keys and the menu (the S that opened it gets through for the same reason);
// filter "input": a real text box, for titles and paths typed in any language;
// no filter: a list of actions, picked by arrows, Enter, or a row's own key.
// Keys are read on the window in the capture phase, before any other handler, and Escape's keyup
// closes the menu too, in case its keydown never arrived.
let menu = null, justClosed = null;

function closeMenu() {
  if (!menu) return;
  const { onClose } = menu;
  removeEventListener("keydown", menu.onKey, true);
  removeEventListener("keyup", menu.onKey, true);
  menu.el.remove();
  menu = null;
  onClose?.();
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
  let query = o.query ?? "", shown = [], at = 0, asked = 0, composing = false, escDown = false;
  if (o.filter === "input") input.value = query;

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
      const opens = !i || item.group !== group;
      const line = opens && item.heading ? `<li class="heading" role="presentation">${esc(item.heading)}</li>`
        : opens && i ? '<li class="divider" role="separator"></li>' : "";
      group = item.group;
      return `${line}<li class="${i === at ? "on" : ""}${item.current ? " current" : ""}" data-i="${i}"${item.sub ? ' style="height:44px"' : ""}>${item.icon ?? ""}` +
        `<span class="name">${esc(item.label)}${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</span>${item.current ? TICK : ""}` +
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
    else if (o.onArrow && (k === "ArrowLeft" || k === "ArrowRight")) o.onArrow(k === "ArrowRight" ? 1 : -1);
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

  menu = { el, anchor: o.anchor, onKey, onClose: o.onClose };
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
function fieldMenu(slug, field, current, where) {
  valueMenu(field, current, where, async (v) => {
    if (v === current) return;
    // The refresh may swap the anchor out, so the next menu opens where it was.
    const box = where.anchor?.getBoundingClientRect(), at = box ? { x: box.left, y: box.bottom + 4 } : where;
    await setField(slug, field, v);
    if (field === "state" && v === "waiting") waitingMenu(slug, "", at); // a wait says on whom
  });
}

// Who or what a waiting issue waits on, typed in any language; Enter saves it, an empty one clears it.
function waitingMenu(slug, current, where) {
  openMenu({
    ...where, filter: "input", className: "folders", query: current, placeholder: "Waiting on whom, for what…",
    items: () => [], empty: "Enter saves it, such as QA on #570",
    onEnter: (typed) => setField(slug, "waiting_on", typed.trim()),
  });
}

// Linear numbers priority 0 for none, then 1 urgent to 4 low; statuses count from 1, and so do protocols, each with
// what it does under its name. Landing is not offered: only Approve sets it.
function valueMenu(field, current, where, choose) {
  const values = { priority: ["none", "urgent", "high", "medium", "low"], protocol: DESK.protocols }[field]
    ?? DESK.states.filter((s) => s !== "landing");
  const num = (v) => values.indexOf(v) + (field === "priority" ? 0 : 1);
  openMenu({
    ...where, filter: "keys", kbd: { state: "S", priority: "P" }[field], className: field === "protocol" ? "wide" : "",
    placeholder: `Change ${field === "state" ? "status" : field}…`,
    items: (q) => values.filter((v) => nameOf(field, v).toLowerCase().includes(q.toLowerCase())).map((v) => ({
      icon: icon(field, v), label: nameOf(field, v), sub: field === "protocol" ? DESK.proto_hints[v] : undefined,
      hint: num(v), num: num(v), current: v === current, run: () => choose(v),
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
      { group: 0, icon: GLYPH.plus, label: "Add sub-issue", run: () => openCreator({ parent: issue.slug, parentTitle: titleOf(issue.slug) }) },
      // An issue page's session: its chat in a window over desk (window.py), or in a kitty tab (agents.jump_back).
      ...(issue.session ? [
        { group: 1, icon: GLYPH.chat, label: "Open chat", hint: "O", key: "o", run: () => openWindow(`/issue/${issue.slug}/window`) },
        { group: 1, icon: GLYPH.terminal, label: "Open chat in kitty", run: () => {
          const form = Object.assign(document.createElement("form"), { method: "post", action: `/issue/${issue.slug}/jump` });
          document.body.append(form);
          form.submit();
        } },
      ] : []),
      { group: 1, icon: GLYPH.link, label: "Copy link", run: () => copy(`${location.origin}/issue/${issue.slug}`, "Link copied") },
      { group: 1, icon: GLYPH.id, label: "Copy ID", run: () => copy(issue.slug, "ID copied") },
      { group: 2, icon: GLYPH.trash, label: "Delete", hint: "Ctrl ⌫", run: () => remove(issue.slug) },
    ],
  });
}

function parentMenu(issue, where) {
  parentPicker(issue.parent, issue.slug, where, (to) => { if (to !== (issue.parent || "")) setField(issue.slug, "parent", to); });
}

// Open issues to sit under, from the server, which leaves out `exclude` and its own sub-issues.
// choose(slug, title) gets "" for No parent.
function parentPicker(current, exclude, where, choose) {
  const choices = fetch(`/api/parents?exclude=${encodeURIComponent(exclude)}`).then((res) => res.json());
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Set parent…", empty: "No open issue matches",
    items: async (q) => {
      const phrase = fold(q).trim(), words = phrase.split(/\s+/).filter(Boolean);
      const text = (item) => fold(item.slug ? `${item.label} ${item.slug}` : item.label);
      const none = { icon: GLYPH.none, label: "No parent", current: !current, run: () => choose("", "") };
      const all = [none, ...(await choices).map((i) => ({ icon: icon("state", i.state), label: i.title, slug: i.slug,
        current: i.slug === current, run: () => choose(i.slug, i.title) }))];
      // Every word must match; the whole phrase matching puts an issue first.
      return all.filter((item) => words.every((w) => text(item).includes(w)))
        .sort((a, b) => !text(a).includes(phrase) - !text(b).includes(phrase));
    },
  });
}

// Active projects to put an issue in; choose(slug, title) gets "" for No project.
function projectPicker(current, where, choose) {
  const choices = fetch("/api/projects").then((res) => res.json());
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Set project…", empty: "No project matches",
    items: async (q) => {
      const words = fold(q).trim().split(/\s+/).filter(Boolean);
      const none = { icon: GLYPH.none, label: "No project", current: !current, run: () => choose("", "") };
      const all = [none, ...(await choices).map((p) => ({ icon: GLYPH.project, label: p.title, current: p.slug === current,
        run: () => choose(p.slug, p.title) }))];
      return all.filter((item) => words.every((w) => fold(item.label).includes(w)));
    },
  });
}

// [ or the sidebar's toggle hides and shows it. A wide window collapses it, remembered in this browser
// (base.html sets the class before the page draws). At 900px and under it opens over the page as a
// drawer instead, until Esc, a click outside it or a link in it, and it starts each page closed.
const narrow = matchMedia("(max-width: 900px)");
const sideOpen = () => document.documentElement.classList.contains("side-open");
const closeSide = () => document.documentElement.classList.remove("side-open");
narrow.addEventListener("change", closeSide);

function toggleSide() {
  const root = document.documentElement;
  if (narrow.matches) root.classList.toggle("side-open");
  else if (root.classList.toggle("side-collapsed")) localStorage.sideCollapsed = "1";
  else delete localStorage.sideCollapsed;
}

// The Help menu, at the sidebar's foot: Linear's Help menu, cut to the keyboard shortcuts, plus the theme, which
// Linear keeps in Settings › Preferences and desk has no page for. The theme follows the system, as Linear's
// "System preference", or is pinned to one; base.html's applyTheme reads the choice from localStorage.
function helpMenu(button) {
  const pinned = ["light", "dark"].includes(localStorage.theme) ? localStorage.theme : "system";
  const pick = (theme) => () => {
    if (theme === "system") delete localStorage.theme; else localStorage.theme = theme;
    applyTheme();
  };
  openMenu({
    anchor: button, className: "actions help",
    items: () => [
      { group: 0, icon: GLYPH.keys, label: "Keyboard shortcuts", hint: "Ctrl /", run: toggleKeys },
      ...[["system", "System preference"], ["light", "Light"], ["dark", "Dark"]].map(([theme, label], i) =>
        ({ group: 1, heading: i ? undefined : "Theme", icon: GLYPH[theme], label, current: theme === pinned, run: pick(theme) })),
    ],
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
  if (["state", "priority", "protocol"].includes(field)) paint(slug, field, value);
  const res = await post(`/issue/${slug}/set`, { field, value });
  if (!res.ok) toast(await reason(res));
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

// A session's chat, in a floating kitty window over desk (window.py, chats.py): an issue's Open chat, and the Agent
// tab's chats. desk opens it, so the page stays as it is; a failure says why.
async function openWindow(url, body = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) toast(await reason(res));
  return res.ok ? res.json() : null;
}

document.addEventListener("click", (e) => {
  const button = e.target.closest(".open-chat[data-slug]");
  if (button) openWindow(`/issue/${button.dataset.slug}/window`);
});

// A new Claude Code session in a window over desk (sessions.py, new_session): Ctrl+Shift+O from any page, as AI web
// apps start a new chat ("the standard keyboard shortcut for new session in all AI web", the user, 15 Oct), and the
// New session buttons.
const newSession = () => openWindow("/sessions/new");
document.addEventListener("click", (e) => { if (e.target.closest(".new-session")) newSession(); });

// The corner's history button, as Linear's Chat history: the newest sessions, or those matching what is typed, each
// with its folder and age, faint (sessions.py, /sessions/recent).
function sessionsMenu(anchor) {
  openMenu({
    anchor, className: "sessions-menu", filter: "keys", placeholder: "Find a session…", empty: "No matching sessions",
    items: async (query) => (await (await fetch(`/sessions/recent?q=${encodeURIComponent(query)}`)).json())
      .map((s) => ({ label: s.title, hint: [s.folder, s.age].filter(Boolean).join(" · "), run: () => openWindow(`/sessions/${s.id}/open`) })),
  });
}

let toastTimer = 0;

function toast(text, action) {
  $(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(text)}</span>` +
    (action ? `<span class="dot">·</span><button class="undo">${esc(action.label)}</button>${action.kbd ? `<kbd>${action.kbd}</kbd>` : ""}` : "");
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
    // A pane that scrolls on its own keeps its place: the Inbox's list always, its open issue while it stays open.
    const kept = [...document.querySelectorAll("[data-keep-scroll]")].map((pane) => [pane.className, pane.dataset.keepScroll, pane.scrollTop]);
    for (const part of redraws ? [".side"] : [".side", ".bar", ".scroll"]) {
      const from = fresh.querySelector(part);
      if (from) $(part).innerHTML = from.innerHTML;
    }
    for (const [name, when, top] of kept) {
      const pane = document.querySelector(`[data-keep-scroll].${CSS.escape(name.split(" ")[0])}`);
      if (pane && (when === "always" || same)) pane.scrollTop = top;
    }
    showCollapsed(url);
    showFolded(url);
    showSeen();
    showNotifyAsk();
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

// A session that starts or stops working changes no file, so /version misses it, yet the issue's strip says it and
// desk moves the issue on it (app.inbox_items): an open issue with a session asks for its state, and refreshes when
// it changed. `claude agents` takes about 0.15s (15 Oct).
setInterval(async () => {
  const strip = $(".strip[data-live]");
  if (!strip || busy()) return;
  try {
    const now = await (await fetch(`/issue/${encodeURIComponent(strip.dataset.slug)}/live`, { cache: "no-store" })).text();
    if (now !== strip.dataset.live) await refresh();
  } catch {}
}, 3000);

// --- desktop notifications for the Inbox ----------------------------------------------------------
// Every tab asks for the Inbox's rows every 3s (/api/inbox, which sees a session go idle with its plan, as /version
// cannot) and refreshes when they changed, so the sidebar's count is current. A row no desk tab has seen becomes a
// desktop notification, unless a desk tab has the focus, where the count shows it. The tabs share what they have seen
// in localStorage.inboxNotified as "<slug>:<why>" keys, with the time of the last ask: one event notifies once, and a
// tab that finds no other asked lately (desk was closed) takes the rows it finds as seen. The timer ticks in a worker,
// since Chrome checks a page's own timers once a minute once it has been hidden for 5 minutes
// (developer.chrome.com/blog/timer-throttling-in-chrome-88), and desk waits in the background by design.
const INBOX_EVERY = 3000;
let inboxKeys = null, asking = false; // the rows this tab last showed

addEventListener("focus", () => { localStorage.deskFocus = Date.now(); });
addEventListener("blur", () => { localStorage.deskFocus = 0; });

async function checkInbox() {
  if (asking) return;
  asking = true;
  try {
    const rows = await (await fetch("/api/inbox", { cache: "no-store" })).json();
    const keys = rows.map((row) => `${row.slug}:${row.why}`);
    const shared = JSON.parse(localStorage.inboxNotified ?? "null");
    const known = new Set(shared && Date.now() - shared.at < 4 * INBOX_EVERY ? shared.keys : keys);
    localStorage.inboxNotified = JSON.stringify({ at: Date.now(), keys });
    if (document.hasFocus()) localStorage.deskFocus = Date.now();
    const watched = Date.now() - Number(localStorage.deskFocus ?? 0) < 2 * INBOX_EVERY;
    if (!watched && window.Notification?.permission === "granted")
      for (const row of rows) if (!known.has(`${row.slug}:${row.why}`)) notify(row);
    if (inboxKeys && String(keys) !== String(inboxKeys)) {
      if (busy()) return; // the refresh waits for the next tick, as /version's does
      await refresh();
    }
    inboxKeys = keys;
  } catch {
  } finally {
    asking = false;
  }
}

// The notification reads as the Inbox's row: the issue's title, then what its session did. A newer one for the same
// issue takes the older's place. A click opens it in the Inbox and asks desk to bring this window forward.
function notify(row) {
  const note = new Notification(row.title, { body: `Session ${row.says}`, tag: row.slug, renotify: true });
  note.onclick = async () => {
    note.close();
    window.focus();
    await go(row.url);
    post("/raise", { title: document.title });
  };
}

// The Inbox's line offering to turn them on (inbox.html), shown until Chrome has your answer.
function showNotifyAsk() {
  const ask = $(".notify-ask");
  if (ask) ask.hidden = window.Notification?.permission !== "default";
}

document.addEventListener("click", async (e) => {
  if (!e.target.closest(".notify-ask button")) return;
  await Notification.requestPermission();
  showNotifyAsk();
});

const ticker = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${INBOX_EVERY})`])));
ticker.onmessage = checkInbox;
checkInbox();
showNotifyAsk();

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
// J/K skip the rows of a collapsed group. In the Inbox they move through the notifications only, not the open
// issue's sub-issues.
const rows = () => [...($(".inbox-list") ?? document).querySelectorAll(".item")].filter((row) => row.checkVisibility());
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
  const row = e.target.closest(".item[data-slug]"); // an issue's row; a session's has no actions
  if (!row) return;
  e.preventDefault();
  focusRow(row, false);
  actionsMenu({ ...row.dataset }, { x: e.clientX, y: e.clientY });
});

// --- collapsed groups, as Linear's list collapses them (measured on linear.app on 2026-10-15) -------
// The triangle on a group header folds or unfolds the group, and Alt+click on it every group on the
// page. T does it to the group under the mouse: its header's, or the focused row's. A click elsewhere
// on the header does nothing, as in Linear. base.html's showCollapsed draws what is remembered.
const groups = () => [...document.querySelectorAll(".group[data-group]")];
const groupOf = (row) => groups().find((group) => group.nextElementSibling?.contains(row));

function toggleGroup(group, all = false) {
  const closing = !group.classList.contains("collapsed"), here = location.pathname + location.search;
  const remembered = JSON.parse(localStorage.collapsed ?? "{}"), shut = new Set(remembered[here]);
  for (const g of all ? groups() : [group]) closing ? shut.add(g.dataset.group) : shut.delete(g.dataset.group);
  if (shut.size) remembered[here] = [...shut]; else delete remembered[here];
  localStorage.collapsed = JSON.stringify(remembered);
  showCollapsed();
  if (focused && !focused.checkVisibility()) focusRow(null);
  if (tipFor?.matches(".group-toggle:hover")) showTip(tipFor); // the key or click hid it: show the new verb
}

// --- folded sections: a click on a section's heading or its triangle folds or unfolds it, and Alt+click every
// section with the same kind of heading on the page. base.html's showFolded draws what is remembered.
function toggleSection(sec, all = false) {
  const closing = !sec.classList.contains("folded"), here = location.pathname;
  const kind = (s) => s.querySelector(":scope > .sec-head").tagName;
  const remembered = JSON.parse(localStorage.folded ?? "{}"), shut = new Set(remembered[here]);
  for (const [s, key] of sectionKeys()) if (s === sec || (all && kind(s) === kind(sec))) closing ? shut.add(key) : shut.delete(key);
  if (shut.size) remembered[here] = [...shut]; else delete remembered[here];
  localStorage.folded = JSON.stringify(remembered);
  showFolded();
}

// A link to a heading, from On this page or the address, unfolds the sections it sits in.
function unfoldTo(target) {
  for (let sec = target?.closest(".sec"); sec; sec = sec.parentElement.closest(".sec"))
    if (sec.classList.contains("folded")) toggleSection(sec);
}
if (location.hash) unfoldTo(document.getElementById(decodeURIComponent(location.hash.slice(1))));

// --- Linear's tooltip, in place of the browser's, for every element with a title (measured on linear.app,
// 2026-10-15). A title reads "Label  Keys": two spaces, then the keys, each drawn as a cap. The title moves into
// data-tip on the first hover, so the browser never shows its own; an icon-only button keeps the label as its name.
// It shows after 450 ms, centred 8px under the element (12px under the list's triangle), or above when the window
// has no room below, and keeps 8px inside the window. From one tooltip to the next it shows at once, as Linear's
// does; desk lets that last 300 ms after one hides. A click, a key or a scroll hides it.
const tip = Object.assign(document.createElement("div"), { className: "tip", role: "tooltip" });
let tipFor = null, tipTimer = 0, tipHidden = 0;

function tipText(el) {
  if (el.hasAttribute("title")) {
    el.dataset.tip = el.title;
    if (!el.hasAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-label", el.title.split(/\s{2,}/)[0]);
    el.removeAttribute("title");
  }
  return el.dataset.tip;
}

function keyCaps(keys) {
  const caps = Object.assign(document.createElement("span"), { className: "caps" });
  for (const key of keys.split(" ")) caps.append(Object.assign(document.createElement("kbd"), { textContent: key }));
  return caps;
}

function fillTip(el) {
  if (el.matches(".group-toggle")) {
    const verb = el.closest(".group").classList.contains("collapsed") ? "expand" : "collapse";
    const line = (keys, text) => { const div = document.createElement("div"); div.append(keyCaps(keys), ` to ${text}`); return div; };
    const lines = Object.assign(document.createElement("div"), { className: "lines" });
    lines.append(line("T", `${verb} group`), line("Alt Click", `${verb} all`));
    tip.replaceChildren(lines);
    return;
  }
  const [label, keys] = el.dataset.tip.split(/\s{2,}/);
  tip.replaceChildren(label);
  if (keys) tip.append(keyCaps(keys));
}

function showTip(el) {
  if (!el.isConnected) return;
  fillTip(el);
  tip.className = el.closest(".group") ? "tip raised" : "tip";
  tip.style.left = tip.style.top = "0"; // measured at the window's corner, so it is not squeezed by the edge it last sat at
  tip.remove();
  document.body.append(tip); // anew, so it fades in again
  const at = el.getBoundingClientRect(), gap = el.matches(".group-toggle") ? 12 : 8;
  const below = at.bottom + gap + tip.offsetHeight <= innerHeight - 8;
  tip.classList.toggle("above", !below);
  tip.style.top = `${below ? at.bottom + gap : Math.max(8, at.top - gap - tip.offsetHeight)}px`;
  const centred = at.left + at.width / 2 - tip.offsetWidth / 2;
  tip.style.left = `${Math.max(8, Math.min(centred, innerWidth - tip.offsetWidth - 8))}px`;
}

function hideTip(fade = true) {
  clearTimeout(tipTimer);
  if (!tip.isConnected || tip.classList.contains("out")) return;
  tipHidden = Date.now();
  if (!fade) { tip.remove(); return; }
  tip.classList.add("out");
  setTimeout(() => { if (tip.classList.contains("out")) tip.remove(); }, 200);
}

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.("[title], [data-tip], .group-toggle") ?? null;
  if (el === tipFor) return;
  tipFor = el;
  const warm = (tip.isConnected && !tip.classList.contains("out")) || Date.now() - tipHidden < 300;
  hideTip();
  if (el && (el.matches(".group-toggle") || tipText(el))) tipTimer = setTimeout(() => showTip(el), warm ? 0 : 450);
});
for (const type of ["mousedown", "keydown", "scroll"]) document.addEventListener(type, () => hideTip(false), true);

document.addEventListener("click", (e) => {
  const t = e.target, closed = justClosed;
  const toggled = (anchor) => anchor === closed;
  justClosed = null;
  if (t.closest(".menu")) return;
  const notice = t.closest(".inbox-row");
  if (notice && !e.ctrlKey && !e.metaKey && !e.shiftKey && !t.closest(".item .icon")) { e.preventDefault(); go(notice.getAttribute("href")); return; }
  if (t.closest(".keys-close")) { toggleKeys(false); return; }
  const history = t.closest(".dock-history");
  if (history) { if (!toggled(history)) sessionsMenu(history); return; }
  if (t.closest(".keys-clear")) { const box = $("#keys input"); box.value = ""; filterKeys(""); box.focus(); return; }
  const anchor = t.closest('a[href^="#"]');
  if (anchor) unfoldTo(document.getElementById(decodeURIComponent(anchor.hash.slice(1))));
  if (t.closest(".side-toggle")) { toggleSide(); return; }
  if (sideOpen() && (t.closest(".side a") || !t.closest(".side"))) closeSide(); // so Back returns to a page with it closed
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
  const waiting = t.closest(".waiting-pick");
  if (waiting) { if (!toggled(waiting)) waitingMenu(waiting.dataset.slug, waiting.dataset.value, { anchor: waiting }); return; }
  const projectChip = t.closest(".project-chip");
  if (projectChip) {
    const slug = projectChip.dataset.slug;
    if (!toggled(projectChip)) projectPicker(projectChip.dataset.value, { anchor: projectChip }, (value) => setField(slug, "project", value));
    return;
  }
  const more = t.closest(".bar .more");
  if (more && page()) { if (!toggled(more)) actionsMenu({ ...page() }, { anchor: more }); return; }
  if (t.closest(".side .new-issue")) { openCreator(); return; }
  const groupToggle = t.closest(".group-toggle");
  if (groupToggle) { toggleGroup(groupToggle.closest(".group"), e.altKey); return; }
  const groupAdd = t.closest(".group-add");
  if (groupAdd) { openCreator({ priority: groupAdd.dataset.priority }); return; }
  const projectAdd = t.closest(".project-add");
  if (projectAdd) { const d = projectAdd.closest(".project-page").dataset; openCreator({ project: d.project, projectTitle: d.title }); return; }
  if (t.closest(".issue .add-sub")) { openCreator({ parent: page().slug, parentTitle: raw().title }); return; }
  const head = t.closest(".sec-head");
  if (head && !t.closest("a, input, textarea, .add-sub") && !getSelection().toString()) { toggleSection(head.parentElement, e.altKey); return; }
  const help = t.closest(".help-open");
  if (help) { if (!toggled(help)) helpMenu(help); return; }
  const shot = t.closest(".body img");
  if (shot && !shot.closest("a")) { openViewer(shot); return; }
  const d2 = t.closest(".d2");
  if (d2) { openViewer(d2.querySelector(`.for-${document.documentElement.dataset.theme} svg`) ?? d2.querySelector("svg")); return; }
  const title = t.closest(".issue h1.title");
  if (title) { editTitle(title); return; }
  const text = t.closest(".issue .description");
  if (text && !t.closest("a, button, input, textarea") && !getSelection().toString()) editBody(text, e);
});

// --- the new issue panel -------------------------------------------------------------------------
// Linear's create panel, measured on linear.app on 2026-10-14: a title, a description, chips that open
// the same status, priority and parent menus as the rest of desk, and a Create more switch beside the
// Create issue button. C, the sidebar's pencil and a group's + open it; Add sub-issue opens it with the
// parent set. Enter in the title moves to the description, Ctrl+Enter creates, Esc closes, and what
// you typed waits in localStorage as a draft until it is created, as Linear keeps its drafts.
// Its keys are read on the window in the capture phase, ahead of the page's Esc and its
// shortcuts; an open menu still gets its keys first, since the panel steps aside while one is open.
let creator = null;
const BLANK = { title: "", body: "", state: "backlog", priority: "none", protocol: "design", parent: "", parentTitle: "", project: "", projectTitle: "" };
const CLOSE = svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>');

// An issue's title from the page, for the parent chip; the slug when the page does not show it.
function titleOf(slug) {
  if (page()?.slug === slug) return raw().title;
  return document.querySelector(`.item[data-slug="${CSS.escape(slug)}"] .title`)?.textContent ?? slug;
}

function openCreator(preset = {}) {
  closeMenu();
  creator?.close();
  const draft = { ...BLANK, ...JSON.parse(localStorage.newIssueDraft ?? "{}"), ...preset };
  const el = document.createElement("div");
  el.className = "creator";
  el.innerHTML = `<form class="create-panel" role="dialog" aria-modal="true" aria-label="New issue">
    <header><span>New issue</span><button type="button" class="close" title="Close  Esc">${CLOSE}</button></header>
    <textarea class="create-title" rows="1" placeholder="Issue title" aria-label="Issue title"></textarea>
    <textarea class="create-body" placeholder="Add description…" aria-label="Issue description"></textarea>
    <div class="create-fields">
      <button type="button" class="field-chip" data-field="state" title="Change status"></button>
      <button type="button" class="field-chip" data-field="priority" title="Change priority"></button>
      <button type="button" class="field-chip" data-field="protocol" title="Change protocol: how much plan, and whether it waits for go"></button>
      <button type="button" class="field-chip" data-field="parent" title="Set parent"></button>
      <button type="button" class="field-chip" data-field="project" title="Set project"></button>
    </div>
    <footer><label class="switch"><input type="checkbox" role="switch">Create more</label>
      <button class="primary" title="Create issue  Ctrl Enter">Create issue</button></footer>
  </form>`;
  document.body.append(el);
  const form = el.querySelector("form"), title = form.querySelector(".create-title"), body = form.querySelector(".create-body");
  const more = form.querySelector(".switch input"), chip = (field) => form.querySelector(`.field-chip[data-field=${field}]`);
  const fit = (box) => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };
  let box = title, composing = false, escDown = false, sending = false;

  function paint() {
    const unset = { priority: draft.priority === "none", parent: !draft.parent, project: !draft.project };
    chip("state").innerHTML = `${icon("state", draft.state)}<span>${esc(nameOf("state", draft.state))}</span>`;
    chip("priority").innerHTML = `${icon("priority", draft.priority)}<span>${unset.priority ? "Priority" : esc(nameOf("priority", draft.priority))}</span>`;
    chip("protocol").innerHTML = `${icon("protocol", draft.protocol)}<span>${esc(nameOf("protocol", draft.protocol))}</span>`;
    chip("parent").innerHTML = `${GLYPH.parent}<span>${unset.parent ? "Parent" : esc(draft.parentTitle || draft.parent)}</span>`;
    chip("project").innerHTML = `${GLYPH.project}<span>${unset.project ? "Project" : esc(draft.projectTitle || draft.project)}</span>`;
    for (const field in unset) chip(field).classList.toggle("unset", unset[field]);
  }

  // A chip's menu is desk's own; when it closes, the caret goes back to the box it left.
  function choose(field) {
    const where = { anchor: chip(field), onClose: () => { if (creator?.el === el) box.focus(); } };
    const set = (changes) => { Object.assign(draft, changes); paint(); };
    if (field === "project") projectPicker(draft.project, where, (slug, name) => set({ project: slug, projectTitle: name }));
    else if (field === "parent") parentPicker(draft.parent, "", where, (slug, name) => set({ parent: slug, parentTitle: name }));
    else valueMenu(field, draft[field], where, (value) => set({ [field]: value }));
  }

  function close(keep = true) {
    if (keep && (title.value.trim() || body.value.trim())) {
      localStorage.newIssueDraft = JSON.stringify({ ...draft, title: title.value, body: body.value });
    } else localStorage.removeItem("newIssueDraft");
    if (menu) closeMenu();
    el.remove();
    if (creator?.el === el) creator = null;
  }

  async function submit() {
    const name = title.value.trim().replace(/\s+/g, " ");
    if (!name) { toast("Give the issue a title first"); title.focus(); return; }
    if (sending) return;
    sending = true;
    const res = await fetch("/api/issues", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name, body: body.value, state: draft.state, priority: draft.priority, protocol: draft.protocol, parent: draft.parent || null, project: draft.project || null }),
    });
    sending = false;
    if (!res.ok) { toast(await reason(res)); return; }
    const made = await res.json();
    if (more.checked) {
      localStorage.removeItem("newIssueDraft");
      title.value = body.value = "";
      fit(title); fit(body);
      title.focus();
    } else close(false);
    toast(made.parent ? "Sub-issue created" : "Issue created", { label: "View issue", run: () => go(made.url) });
    await refresh();
  }

  // Esc's keyup closes too, for when an input method kept its keydown; Tab stays inside the panel.
  function onKey(e) {
    const k = keyOf(e);
    if (e.type === "keyup") {
      if (k === "Escape" && !escDown && !menu) close();
      if (k === "Escape") escDown = false;
      return;
    }
    if (k === "Escape") escDown = true;
    if (menu || e.isComposing || composing) return;
    if (k === "Escape") close();
    else if (k === "Enter" && (e.ctrlKey || e.metaKey)) submit();
    else if (k === "Enter" && e.target === title) body.focus();
    else if (k === "Tab") {
      const stops = [...form.querySelectorAll("textarea, button, input")], i = stops.indexOf(document.activeElement);
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  title.value = draft.title;
  body.value = draft.body;
  more.checked = localStorage.createMore === "1";
  paint();
  fit(title); fit(body);
  el.addEventListener("compositionstart", () => { composing = true; });
  el.addEventListener("compositionend", () => { composing = false; });
  form.addEventListener("focusin", (e) => { if (e.target.matches("textarea")) box = e.target; });
  // A title is one line: a pasted line break becomes a space.
  title.addEventListener("input", () => { if (title.value.includes("\n")) title.value = title.value.replace(/\s*\n\s*/g, " "); fit(title); });
  body.addEventListener("input", () => fit(body));
  more.addEventListener("change", () => { if (more.checked) localStorage.createMore = "1"; else delete localStorage.createMore; });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  form.addEventListener("click", (e) => {
    const c = e.target.closest(".field-chip");
    if (c) { if (justClosed !== c) choose(c.dataset.field); return; }
    if (e.target.closest(".close")) close();
  });
  // A press on the dimmed page closes the panel, unless it only closed a chip's menu.
  el.addEventListener("mousedown", (e) => { if (e.target === el && !justClosed) close(); });
  creator = { el, onKey, close };
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);
}

addEventListener("keydown", (e) => creator?.onKey(e), true);
addEventListener("keyup", (e) => creator?.onKey(e), true);

// --- diagram and screenshot viewer: click to open full screen, wheel to zoom, drag to move ----------------------
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
    const picture = copyOf.tagName === "IMG"; // a screenshot opens at its own size, fitted to the window
    const w = picture ? svgEl.naturalWidth : copyOf.viewBox.baseVal?.width || copyOf.getBoundingClientRect().width;
    const h = picture ? svgEl.naturalHeight : copyOf.viewBox.baseVal?.height || copyOf.getBoundingClientRect().height;
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

// --- keyboard shortcuts: keys.html, as Linear's panel --------------------------------------------
// It opens with its search box focused and empty. Typing keeps the rows whose name, keys or group name hold
// every word typed, and hides a group left with none.
function toggleKeys(open = $("#keys").hidden) {
  const panel = $("#keys"), box = panel.querySelector("input");
  panel.hidden = !open;
  if (open) { box.value = ""; filterKeys(""); box.focus(); }
  else if (panel.contains(document.activeElement)) document.activeElement.blur();
}

function filterKeys(text) {
  const panel = $("#keys"), words = fold(text).split(/\s+/).filter(Boolean);
  for (const section of panel.querySelectorAll("section")) {
    const rows = [...section.querySelectorAll(".key-row")], group = section.querySelector("h2").textContent;
    for (const row of rows) row.hidden = !words.every((word) => fold(`${group} ${row.textContent}`).includes(word));
    section.hidden = rows.every((row) => row.hidden);
  }
  panel.querySelector(".keys-none").hidden = !!panel.querySelector("section:not([hidden])");
  panel.querySelector(".keys-clear").hidden = !text;
}

document.addEventListener("input", (e) => { if (e.target.closest?.("#keys")) filterKeys(e.target.value); });

// --- keys ----------------------------------------------------------------------------------------
let gPressed = 0;
const target = () => focused?.dataset.slug ?? page()?.slug; // what S, P and Ctrl+Delete act on

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && viewer) { closeViewer(); return; }
  if (menu || viewer || editing || creator) return;
  // Ctrl+/ works from a text box too, and Esc closes the shortcuts from their own search box.
  if ((e.ctrlKey || e.metaKey) && e.key === "/") { toggleKeys(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyO") { newSession(); e.preventDefault(); return; }
  if (e.key === "Escape" && !$("#keys").hidden) { toggleKeys(false); return; }
  if (e.key === "Escape" && sideOpen()) { closeSide(); return; } // before an issue's Esc goes back
  if (typing(e.target)) { if (e.key === "Escape") e.target.blur(); return; }
  const key = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    // The issue's next step, its strip's one button.
    const step = keyOf(e) === "Enter" && $(".strip .strip-go:not(:disabled)");
    if (step) { step.click(); e.preventDefault(); }
    else if (key === "z" && undoList().length) { undo(); e.preventDefault(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && target()) { remove(target()); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (gPressed && Date.now() - gPressed < 1500) {
    gPressed = 0;
    if (key === "b") location.href = "/backlog";
    if (key === "i") location.href = "/inbox";
    if (key === "s") location.href = "/sessions";
    if (key === "p") location.href = "/projects";
    return;
  }
  if (key === "g") { gPressed = Date.now(); return; }

  if (key === "j" || e.key === "ArrowDown" || key === "k" || e.key === "ArrowUp") {
    moveFocus(key === "j" || e.key === "ArrowDown" ? 1 : -1);
    if (focused?.classList.contains("inbox-row")) go(focused.getAttribute("href")); // Linear's Inbox opens as you move
    e.preventDefault();
  }
  else if (e.key === "Enter" && focused) {
    if (focused.dataset.session) openWindow(`/sessions/${focused.dataset.session}/open`);
    else if (focused.classList.contains("inbox-row")) go(focused.getAttribute("href"));
    else location.href = focused.getAttribute("href");
  }
  else if (key === "c") { openCreator(); e.preventDefault(); }
  // O opens the issue's chat, as its Open chat button does: back to its session once it is done ("approve is ctrl
  // enter right. how about open chat", the user, 15 Oct). An issue with no session says so in a toast.
  else if (key === "o" && target()) { openWindow(`/issue/${target()}/window`); e.preventDefault(); }
  else if (key === "t") {
    const group = $(".group[data-group]:hover") ?? (focused && groupOf(focused));
    if (group) toggleGroup(group);
  }
  else if (key === "s" || key === "p") {
    const field = key === "s" ? "state" : "priority";
    // The issue's status and priority sit in its Properties column or, in a narrow Inbox pane, in its chips.
    const row = focused?.dataset.slug ? focused : null, pick = [...document.querySelectorAll(`.pick[data-field=${field}]`)].find((el) => el.checkVisibility());
    if (row) fieldMenu(row.dataset.slug, field, row.dataset[field], { anchor: row.querySelector(`.icon[data-field=${field}]`) });
    else if (pick) fieldMenu(pick.dataset.slug, field, pick.dataset[field], { anchor: pick });
    e.preventDefault();
  }
  else if (e.key === "/") { const box = document.getElementById("search-q"); if (box) box.focus(); else location.href = "/search"; e.preventDefault(); }
  else if (e.key === "[") { toggleSide(); }
  else if (e.key === "Escape") {
    if ($(".inbox") && page()) go("/inbox");
    else if (page()) goBack();
    else focusRow(null);
  }
});

// The project picker on an issue page saves as soon as it changes.
document.addEventListener("change", async (e) => {
  const select = e.target.closest?.(".project-pick select");
  if (select && page()) await setField(page().slug, "project", select.value);
});

// A page reached after acting elsewhere says what happened in a toast (?note=, as the Inbox's review form leaves
// it), once: the note leaves the address straight away, so a refresh does not say it again.
{
  const url = new URL(location.href), note = url.searchParams.get("note");
  if (note) { url.searchParams.delete("note"); history.replaceState(null, "", url); toast(note); }
}
