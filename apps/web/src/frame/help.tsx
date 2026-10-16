// The Help menu, at the sidebar's foot: Linear's Help menu, cut to the keyboard shortcuts, plus the theme, which Linear
// keeps in Settings › Preferences and desk has no page for. The theme follows the system, as Linear's "System
// preference", or is pinned to one.
import { GLYPH } from "../ui/icons";
import { openMenu } from "../ui/menu";
import { ui } from "../store/ui";
import { applyTheme } from "./theme";

export function helpMenu(button: Element) {
  const pinned = ["light", "dark"].includes(localStorage.theme) ? localStorage.theme : "system";
  const pick = (theme: string) => () => {
    if (theme === "system") delete localStorage.theme;
    else localStorage.theme = theme;
    applyTheme();
  };
  const themes: [keyof typeof GLYPH, string][] = [["system", "System preference"], ["light", "Light"], ["dark", "Dark"]];
  openMenu({
    anchor: button, className: "actions help",
    items: () => [
      { group: 0, icon: GLYPH.keys, label: "Keyboard shortcuts", hint: "Ctrl /", run: () => ui.setKeys(!ui.keysOpen) },
      ...themes.map(([theme, label], i) => ({ group: 1, heading: i ? undefined : "Theme", icon: GLYPH[theme], label, current: theme === pinned, run: pick(theme) })),
    ],
  });
}
