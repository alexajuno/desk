// Chrome's keys that went with its menu, which desk's windows (main.ts) and Claude's tabs (tabs.ts) have none of.
import type { Input, WebContents } from "electron";

export function shortcut(page: WebContents, key: Input): boolean {
  const ctrl = key.control || key.meta;
  if ((ctrl && key.code === "KeyR") || key.code === "F5") page.reload();
  else if (ctrl && key.shift && key.code === "KeyI") page.toggleDevTools();
  else if (key.code === "F12") page.toggleDevTools();
  else if (ctrl && (key.code === "Equal" || key.code === "NumpadAdd")) page.setZoomLevel(page.getZoomLevel() + 0.5);
  else if (ctrl && (key.code === "Minus" || key.code === "NumpadSubtract")) page.setZoomLevel(page.getZoomLevel() - 0.5);
  else if (ctrl && (key.code === "Digit0" || key.code === "Numpad0")) page.setZoomLevel(0);
  else if (key.alt && key.code === "ArrowLeft" && page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
  else if (key.alt && key.code === "ArrowRight" && page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
  else return false;
  return true;
}
