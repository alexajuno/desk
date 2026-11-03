// The Help menu, at the window bar's left end (frame/StatusBar.tsx), and at the sidebar's foot on a phone, which has no
// bar: Linear's Help menu, cut to the keyboard shortcuts, plus Settings, which Linear opens from its workspace menu and
// desk has none of. The theme is set in Settings › Preferences.
import { GLYPH } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
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

// Linear's Help button, measured 2026-10-15 as a 24px circle round a 16px question mark.
export function HelpButton() {
  return (
    <button className="side-icon help-open" type="button" title="Help, shortcuts and settings"
      onClick={(e) => { if (!toggled(e.currentTarget)) helpMenu(e.currentTarget); }}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.569 9.75c-.332 0-.614-.27-.578-.6.021-.188.061-.372.136-.62q.158-.51.447-.82a3.4 3.4 0 0 1 .703-.577q.284-.182.507-.396.229-.219.358-.486a1.4 1.4 0 0 0 .13-.606 1.2 1.2 0 0 0-.171-.653 1.2 1.2 0 0 0-.466-.429 1.36 1.36 0 0 0-.647-.152q-.33 0-.628.148a1.23 1.23 0 0 0-.587.622c-.123.295-.367.555-.686.555h-.472c-.337 0-.616-.28-.55-.611q.103-.513.363-.905a2.55 2.55 0 0 1 1.08-.915A3.6 3.6 0 0 1 7.998 3q.888 0 1.563.32.68.319 1.057.91.382.586.382 1.392 0 .543-.172.972a2.4 2.4 0 0 1-.48.763 3.5 3.5 0 0 1-.74.595 3.2 3.2 0 0 0-.62.496 1.7 1.7 0 0 0-.353.605l-.034.106c-.1.316-.35.591-.682.591zM8.75 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0" /></svg>
    </button>
  );
}
