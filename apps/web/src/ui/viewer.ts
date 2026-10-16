// The diagram and screenshot viewer, as desk.js's: click to open full screen, wheel to zoom, drag to move,
// double-click to fit, Esc to close (the shortcuts close it).
let viewer: HTMLDivElement | null = null;

export const viewerOpen = () => viewer !== null;

export function openViewer(source: Element) {
  viewer = document.createElement("div");
  viewer.className = "viewer";
  viewer.innerHTML = '<div class="viewer-stage"></div><div class="viewer-help">Wheel to zoom · drag to move · double-click to fit · Esc to close</div>';
  const stage = viewer.querySelector(".viewer-stage") as HTMLDivElement;
  const copyOf = source.cloneNode(true) as SVGSVGElement & HTMLImageElement;
  copyOf.removeAttribute("style");
  stage.append(copyOf);
  document.body.append(viewer);
  let scale = 1, x = 0, y = 0, drag: { sx: number; sy: number } | null = null;
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
  fit();
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

export function closeViewer() {
  viewer?.remove();
  viewer = null;
}
