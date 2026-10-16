// Theme: light or dark as the system is, unless pinned to one in this browser (localStorage.theme, from the Help menu
// at the sidebar's foot), as base.html does. index.html sets it before the page draws; this keeps it current when the
// system or another tab changes it.
const systemLight = matchMedia("(prefers-color-scheme: light)");

export function applyTheme() {
  document.documentElement.dataset.theme = ["light", "dark"].includes(localStorage.theme) ? localStorage.theme
    : systemLight.matches ? "light" : "dark";
}

export function watchTheme() {
  applyTheme();
  systemLight.addEventListener("change", applyTheme);
  addEventListener("storage", applyTheme);
}
