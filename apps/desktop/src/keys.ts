// Chrome's keys that went with its menu, which desk's windows (main.ts) and Claude's tabs (tabs.ts) have none of.
import { clipboard, Menu, type Input, type MenuItemConstructorOptions, type WebContents } from "electron";

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

// Electron shows no right-click menu of its own, so an image could not be copied: this gives the page Chrome's usual one.
export function rightClick(page: WebContents) {
  page.on("context-menu", (_e, p) => {
    const can = p.editFlags, items: MenuItemConstructorOptions[] = [];
    if (p.mediaType === "image") {
      items.push({ label: "Copy Image", click: () => page.copyImageAt(p.x, p.y) });
      if (p.srcURL) items.push({ label: "Copy Image Address", click: () => clipboard.writeText(p.srcURL) });
    }
    if (p.linkURL) items.push({ label: "Copy Link Address", click: () => clipboard.writeText(p.linkURL) });
    if (p.isEditable) items.push({ role: "cut", enabled: can.canCut }, { role: "copy", enabled: can.canCopy }, { role: "paste", enabled: can.canPaste }, { role: "selectAll" });
    else if (p.selectionText) items.push({ role: "copy" });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}
