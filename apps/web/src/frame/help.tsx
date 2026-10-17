// The Help menu, at the sidebar's foot: Linear's Help menu, cut to the keyboard shortcuts, plus Settings, which Linear
// opens from its workspace menu and desk has none of. The theme is set in Settings › Preferences.
import { GLYPH } from "../ui/icons";
import { openMenu } from "../ui/menu";
import { go } from "../app/nav";
import { ui } from "../store/ui";

export function helpMenu(button: Element) {
  openMenu({
    anchor: button, className: "actions help",
    items: () => [
      { group: 0, icon: GLYPH.keys, label: "Keyboard shortcuts", hint: "Ctrl /", run: () => ui.setKeys(!ui.keysOpen) },
      { group: 0, icon: GLYPH.sliders, label: "Settings", hint: "Ctrl ,", run: () => go("/settings") },
    ],
  });
}
