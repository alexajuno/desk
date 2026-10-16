// [ or the sidebar's toggle hides and shows it. A wide window collapses it, remembered in this browser (index.html
// sets the class before the page draws). At 900px and under it opens over the page as a drawer instead, until Esc,
// a click outside it or a link in it, and it starts each page closed.
const narrow = matchMedia("(max-width: 900px)");
export const sideOpen = () => document.documentElement.classList.contains("side-open");
export const closeSide = () => document.documentElement.classList.remove("side-open");
narrow.addEventListener("change", closeSide);

export function toggleSide() {
  const root = document.documentElement;
  if (narrow.matches) root.classList.toggle("side-open");
  else if (root.classList.toggle("side-collapsed")) localStorage.sideCollapsed = "1";
  else delete localStorage.sideCollapsed;
}
