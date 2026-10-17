// Linear's tooltip, in place of the browser's, for every element with a title (measured on linear.app, 2026-10-15),
// as desk.js draws it. A title reads "Label  Keys": two spaces, then the keys, each drawn as a cap, and "then" between
// the keys of a sequence as a word. A title of several lines, such as the sidebar's Issues, draws a row per line, its
// keys lined up. The title moves into data-tip on the first hover, so the browser never shows its own; an icon-only
// button keeps the label as its name. It shows after 450 ms, centred 8px under the element (12px under the list's
// triangle), or above when the window has no room below, and keeps 8px inside the window. A sidebar link's shows 8px
// to its right instead, as Linear's does (measured 2026-10-17), and a sidebar row with no title of its own shows its
// title in full when the sidebar cuts it off. From one tooltip to the next it shows at once, as Linear's does, for
// 300 ms after one hides. A click, a key or a scroll hides it.
const tip = Object.assign(document.createElement("div"), { className: "tip", role: "tooltip" });
let tipFor: Element | null = null, tipTimer = 0, tipHidden = 0;

function tipText(el: HTMLElement): string | undefined {
  if (el.hasAttribute("title")) {
    el.dataset.tip = el.title;
    if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", el.title.split(/\s{2,}/)[0]);
    el.removeAttribute("title");
  }
  return el.dataset.tip ?? cutTitle(el);
}

const SIDE_LINK = ".side .nav-item, .side a.nav-label";

function cutTitle(el: HTMLElement) {
  const title = el.matches(SIDE_LINK) ? el.querySelector<HTMLElement>(".nav-title") : null;
  return title && title.scrollWidth > title.clientWidth ? title.textContent ?? undefined : undefined;
}

function keyCaps(keys: string) {
  const caps = Object.assign(document.createElement("span"), { className: "caps" });
  for (const key of keys.split(" "))
    caps.append(key === "then" ? Object.assign(document.createElement("span"), { className: "then", textContent: key })
      : Object.assign(document.createElement("kbd"), { textContent: key }));
  return caps;
}

function fillTip(el: HTMLElement) {
  if (el.matches(".group-toggle")) {
    const verb = el.closest(".group")?.classList.contains("collapsed") ? "expand" : "collapse";
    const line = (keys: string, text: string) => { const div = document.createElement("div"); div.append(keyCaps(keys), ` to ${text}`); return div; };
    const lines = Object.assign(document.createElement("div"), { className: "lines" });
    lines.append(line("T", `${verb} group`), line("Alt Click", `${verb} all`));
    tip.replaceChildren(lines);
    return;
  }
  const lines = (tipText(el) ?? "").split("\n");
  if (lines.length > 1) {
    const rows = Object.assign(document.createElement("div"), { className: "rows" });
    for (const line of lines) {
      const [label, keys] = line.split(/\s{2,}/);
      rows.append(Object.assign(document.createElement("span"), { textContent: label }), keys ? keyCaps(keys) : "");
    }
    tip.replaceChildren(rows);
    return;
  }
  const [label, keys] = lines[0].split(/\s{2,}/);
  tip.replaceChildren(label);
  if (keys) tip.append(keyCaps(keys));
}

export function showTip(el: HTMLElement) {
  if (!el.isConnected) return;
  fillTip(el);
  tip.className = el.closest(".group") ? "tip raised" : "tip";
  tip.style.left = tip.style.top = "0"; // measured at the window's corner, so it is not squeezed by the edge it last sat at
  tip.remove();
  document.body.append(tip); // anew, so it fades in again
  const at = el.getBoundingClientRect(), gap = el.matches(".group-toggle") ? 12 : 8;
  if (el.matches(SIDE_LINK)) {
    tip.classList.add("right");
    const top = at.top + parseFloat(getComputedStyle(el).paddingTop); // a section's name sits under its padding
    const middle = (top + at.bottom) / 2 - tip.offsetHeight / 2;
    tip.style.top = `${Math.max(8, Math.min(middle, innerHeight - tip.offsetHeight - 8))}px`;
    tip.style.left = `${at.right + gap}px`;
    return;
  }
  const below = at.bottom + gap + tip.offsetHeight <= innerHeight - 8;
  tip.classList.toggle("above", !below);
  tip.style.top = `${below ? at.bottom + gap : Math.max(8, at.top - gap - tip.offsetHeight)}px`;
  const centred = at.left + at.width / 2 - tip.offsetWidth / 2;
  tip.style.left = `${Math.max(8, Math.min(centred, innerWidth - tip.offsetWidth - 8))}px`;
}

export function hideTip(fade = true) {
  clearTimeout(tipTimer);
  if (!tip.isConnected || tip.classList.contains("out")) return;
  tipHidden = Date.now();
  if (!fade) { tip.remove(); return; }
  tip.classList.add("out");
  setTimeout(() => { if (tip.classList.contains("out")) tip.remove(); }, 200);
}

// The group triangle's tip says the new verb after a fold; the list asks for it again.
export const tipShownFor = () => tipFor;

export function installTooltips() {
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as Element).closest?.(`[title], [data-tip], .group-toggle, ${SIDE_LINK}`) as HTMLElement | null ?? null;
    if (el === tipFor) return;
    tipFor = el;
    const warm = (tip.isConnected && !tip.classList.contains("out")) || Date.now() - tipHidden < 300;
    hideTip();
    if (el && (el.matches(".group-toggle") || tipText(el))) tipTimer = window.setTimeout(() => showTip(el), warm ? 0 : 450);
  });
  for (const type of ["mousedown", "keydown", "scroll"]) document.addEventListener(type, () => hideTip(false), true);
}
