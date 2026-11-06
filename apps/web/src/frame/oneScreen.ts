// One screen at a time. The chat is a 480px column beside its right half (dock.css), and a browser or a terminal needs
// about 780px to lay out as a window of its own would. Where the dock can't give both, the half takes the chat's place
// under the same head, as on a phone, and the head's Chat button brings the chat back: html.one-screen, which dock.css
// reads. The dock runs from the sidebar's edge (244px, or 8px when it is hidden or a drawer, at 900px and under, as
// dock.css has it) to 8px short of the window's right edge, so its width is told from the window's, with no measuring
// of the dock, which is not always on screen.
const CHAT = 480, HALF = 780, SIDE = 244, EDGE = 8;

// Whether the chat in the middle has room beside a half, now.
export function oneScreen(): boolean {
  const root = document.documentElement;
  const sideShown = !root.classList.contains("side-collapsed") && innerWidth > 900;
  return innerWidth - (sideShown ? SIDE : EDGE) - EDGE < CHAT + HALF;
}

// Keeps html.one-screen true to the window and to the sidebar, which a class on html shows and hides.
export function watchOneScreen() {
  const root = document.documentElement;
  const apply = () => root.classList.toggle("one-screen", oneScreen());
  apply();
  addEventListener("resize", apply);
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["class"] });
}
