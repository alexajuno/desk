// With an input method (fcitx5 on Wayland, typing Vietnamese) a key pressed in a text box can arrive as "Process" or
// "Unidentified", or not at all; e.code still names the physical key.
const BY_CODE: Record<string, string> = {
  Escape: "Escape", Enter: "Enter", NumpadEnter: "Enter", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Backspace: "Backspace", Tab: "Tab",
};

export function keyOf(e: KeyboardEvent | React.KeyboardEvent): string {
  if (e.key !== "Process" && e.key !== "Unidentified") return e.key;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  return BY_CODE[e.code] ?? (digit ? digit[1] : e.key);
}

export const typing = (el: EventTarget | Element | null) =>
  (el as Element | null)?.closest?.("input, textarea, select, [contenteditable]") ?? null;
