// The diagram and screenshot viewer, as desk.js's: click to open full screen, wheel to zoom, drag to move,
// double-click to fit, Esc to close (the shortcuts close it). V opens the picture on screen, and ← and →, or vim's h and
// l, walk every one in the chat or page it sits in, as Telegram's viewer walks a chat's media; Esc leaves the chat at
// the last one seen (27 Oct: "i like the v and arrows"; "vim motion h/l for moving between artifacts in v view?").
let viewer: HTMLDivElement | null = null;
let walk: Element[] = [], at = 0, show: (() => void) | null = null;

export const viewerOpen = () => viewer !== null;

// A picture: a screenshot in a drawn document, not one inside a link, or a diagram.
const PICTURES = ".body img, .d2";
const isPicture = (el: Element) => !(el.tagName === "IMG" && el.closest("a"));

// GLYPH.close (icons.tsx), as markup, since the viewer is built outside React.
const CROSS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

// What a picture shows full screen: a screenshot itself, or a diagram's drawing in the theme on screen.
function drawingOf(picture: Element): Element | null {
  if (!picture.classList.contains("d2")) return picture;
  return picture.querySelector(`.for-${document.documentElement.dataset.theme} svg`) ?? picture.querySelector("svg");
}

// The pictures a picture walks with: those of its chat, or of the page it is on, that show now (not under a folded
// Details).
function picturesBy(picture: Element): Element[] {
  const home = picture.closest(".convo, .scroll") ?? document.body;
  return [...home.querySelectorAll(PICTURES)].filter((el) => isPicture(el) && drawingOf(el) && el.checkVisibility());
}

// The picture clicked: open it, to walk its chat's or page's from there.
export function openPicture(target: Element): boolean {
  const picture = target.closest(PICTURES);
  if (!picture || !isPicture(picture) || !drawingOf(picture)) return false;
  open(picturesBy(picture), picture);
  return true;
}

// V: the picture nearest the middle of the chat in the middle, or of the page, as you see it. False when there is none.
export function openNearest(): boolean {
  // The chat in the middle, on whichever view, else the page.
  const view = document.querySelector(".chat-center .dock .dock-scroll") ?? document.querySelector(".panel .scroll");
  if (!view) return false;
  const pictures = [...view.querySelectorAll(PICTURES)].filter((el) => isPicture(el) && drawingOf(el) && el.checkVisibility());
  if (!pictures.length) return false;
  const box = view.getBoundingClientRect(), middle = (box.top + box.bottom) / 2;
  const off = (el: Element) => { const r = el.getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - middle); };
  open(pictures, pictures.reduce((a, b) => (off(b) < off(a) ? b : a)));
  return true;
}

// ← and →, or h and l: the previous or next picture, stopping at either end.
export function stepViewer(by: number) {
  if (!viewer || at + by < 0 || at + by >= walk.length) return;
  at += by;
  show?.();
}

function open(pictures: Element[], picture: Element) {
  walk = pictures.length ? pictures : [picture];
  at = Math.max(0, walk.indexOf(picture));
  viewer = document.createElement("div");
  viewer.className = "viewer";
  // × closes it where no Esc key is, on a phone (27 Oct: "on phone there is no way to escape the view?").
  viewer.innerHTML = `<div class="viewer-stage"></div><div class="viewer-help"></div>
    <button class="viewer-close" type="button" title="Close  Esc" aria-label="Close">${CROSS}</button>`;
  const stage = viewer.querySelector(".viewer-stage") as HTMLDivElement;
  const help = viewer.querySelector(".viewer-help") as HTMLDivElement;
  const close = viewer.querySelector(".viewer-close") as HTMLButtonElement;
  close.addEventListener("mousedown", (e) => e.stopPropagation());
  close.addEventListener("click", () => closeViewer());
  document.body.append(viewer);
  history.pushState({ ...history.state, viewer: true }, "");
  let scale = 1, x = 0, y = 0, drag: { sx: number; sy: number } | null = null;
  let source: Element, copyOf: SVGSVGElement & HTMLImageElement;
  const apply = () => { stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const fit = () => {
    const picture = copyOf.tagName === "IMG"; // a screenshot opens at its own size, fitted to the window
    const img = source as HTMLImageElement;
    const w = picture ? img.naturalWidth : copyOf.viewBox?.baseVal?.width || copyOf.getBoundingClientRect().width;
    const h = picture ? img.naturalHeight : copyOf.viewBox?.baseVal?.height || copyOf.getBoundingClientRect().height;
    copyOf.setAttribute("width", String(w));
    copyOf.setAttribute("height", String(h));
    scale = Math.min((innerWidth - 80) / w, (innerHeight - 80) / h);
    x = (innerWidth - w * scale) / 2;
    y = (innerHeight - h * scale) / 2;
    apply();
  };
  show = () => {
    source = drawingOf(walk[at])!;
    copyOf = source.cloneNode(true) as SVGSVGElement & HTMLImageElement;
    copyOf.removeAttribute("style");
    stage.replaceChildren(copyOf);
    help.textContent = [walk.length > 1 && `${at + 1} of ${walk.length} · ← → or h l to walk`, "Wheel to zoom · drag to move · double-click to fit · Esc to close"].filter(Boolean).join(" · ");
    fit();
  };
  show();
  const v = viewer;
  v.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    x = e.clientX - (e.clientX - x) * k;
    y = e.clientY - (e.clientY - y) * k;
    scale *= k;
    apply();
  }, { passive: false });
  v.addEventListener("mousedown", (e) => { drag = { sx: e.clientX - x, sy: e.clientY - y }; v.classList.add("dragging"); });
  v.addEventListener("mousemove", (e) => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
  v.addEventListener("mouseup", () => { drag = null; v.classList.remove("dragging"); });
  v.addEventListener("dblclick", fit);
}

// Back closes it too, as a phone's photo viewer: it opens on an entry of its own in the tab's history, at the same
// address, which Back leaves and Esc or × steps back off, so Back is never spent on it twice. The router never sees
// those steps, which change no page.
let steppingBack = false;
addEventListener("popstate", (e) => {
  if (viewer) closeViewer(true);
  else if (!steppingBack && !(e.state as { viewer?: boolean } | null)?.viewer) return;
  steppingBack = false;
  e.stopImmediatePropagation();
}, { capture: true });

// Esc, × or Back: the viewer closes, and the chat or page shows the picture last seen, in its middle when it was out of
// sight or under the chat's composer.
export function closeViewer(byBack = false) {
  if (!viewer) return;
  if (!byBack && (history.state as { viewer?: boolean } | null)?.viewer) { steppingBack = true; history.back(); }
  viewer.remove();
  viewer = null;
  show = null;
  const last = walk[at], view = last?.closest(".dock-scroll, .scroll");
  if (last && view) {
    const r = last.getBoundingClientRect(), box = view.getBoundingClientRect();
    const bottom = view.querySelector(".dock-foot")?.getBoundingClientRect().top ?? box.bottom;
    if (r.top < box.top || r.bottom > bottom) last.scrollIntoView({ block: "center" });
  }
  walk = [];
}
