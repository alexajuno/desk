// What desk's page gets from the app (main.ts), as window.deskApp: a chat's Browser (apps/web/src/sessions/Browser.tsx)
// shows a tab of Claude's in its place, the tab itself (tabs.ts). Plain JavaScript, as Electron runs a preload as it is.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskApp", {
  // The tab at the place, {x, y, width, height} in the page's pixels, or none when the target is null.
  show: (target, at) => ipcRenderer.send("tab", target, at),
});

// A key of desk's pressed in a tab desk shows, which the tab hands back (tabs.ts): desk's page hears it where the tab
// stands, the Browser's box for it, from where it goes on to desk's own keys (Frame.tsx).
ipcRenderer.on("key", (_e, target, key) => {
  const at = [...document.querySelectorAll("[data-tab]")].find((el) => el.dataset.tab === target) ?? document.body;
  at.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
});
