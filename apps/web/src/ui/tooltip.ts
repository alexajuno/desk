// Linear's tooltip, in place of the browser's, for every element with a title (measured on linear.app, 2026-10-15),
// as desk.js draws it. A title reads "Label  Keys": two spaces, then the keys, each drawn as a cap. The title moves
// into data-tip on the first hover, so the browser never shows its own; an icon-only button keeps the label as its
// name. It shows after 450 ms, centred 8px under the element (12px under the list's triangle), or above when the
// window has no room below, and keeps 8px inside the window. From one tooltip to the next it shows at once, as
// Linear's does, for 300 ms after one hides. A click, a key or a scroll hides it.
const tip = Object.assign(document.createElement("div"), { className: "tip", role: "tooltip" });
let tipFor: Element | null = null, tipTimer = 0, tipHidden = 0;

function tipText(el: HTMLElement): string | undefined {
  if (el.hasAttribute("title")) {
    el.dataset.tip = el.title;
    if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", el.title.split(/\s{2,}/)[0]);
    el.removeAttribute("title");
  }
  return el.dataset.tip;
}

function keyCaps(keys: string) {
  const caps = Object.assign(document.createElement("span"), { className: "caps" });
  for (const key of keys.split(" ")) caps.append(Object.assign(document.createElement("kbd"), { textContent: key }));
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
  const [label, keys] = (el.dataset.tip ?? "").split(/\s{2,}/);
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
    const el = (e.target as Element).closest?.("[title], [data-tip], .group-toggle") as HTMLElement | null ?? null;
    if (el === tipFor) return;
    tipFor = el;
    const warm = (tip.isConnected && !tip.classList.contains("out")) || Date.now() - tipHidden < 300;
    hideTip();
    if (el && (el.matches(".group-toggle") || tipText(el))) tipTimer = window.setTimeout(() => showTip(el), warm ? 0 : 450);
  });
  for (const type of ["mousedown", "keydown", "scroll"]) document.addEventListener(type, () => hideTip(false), true);
}
