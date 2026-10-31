// A chat's Browser, a view of its right half (Half.tsx): the tabs its session has open in the agents' Chrome, which the
// session host's relay notes and desk keeps (the server's tabs.ts), as a strip, then back, forward, reload and the open
// tab's address, then the page ("okay A", the user's pick from three mockups, 31 Oct). The strip has no new tab or ×:
// the tabs are the session's, opened and closed by Claude.
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { dock } from "../store/dock";
import { issues, type Tab } from "../store/issues";
import { GLYPH } from "../ui/icons";

export const BrowserView = observer(function BrowserView({ session }: { session: string }) {
  const tabs = issues.tabsOf(session);
  if (!tabs.length) return <p className="browser-empty">No tabs yet</p>;
  // The tab you picked, while it is open; else the one opened last, where Claude most likely works.
  const shown = tabs.find((t) => t.target === dock.tab[session]) ?? tabs[tabs.length - 1];
  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Tabs">
        {tabs.map((t) => (
          <button key={t.target} className={`browser-tab${t === shown ? " here" : ""}`} type="button" role="tab" aria-selected={t === shown}
            title={`${t.title || t.url}\n${t.url}`} onClick={() => dock.showTab(session, t.target)}>
            <Favicon tab={t} />
            <span>{t.title || where(t.url).host || t.url}</span>
          </button>
        ))}
      </div>
      <div className="browser-nav">
        <button className="dock-btn" type="button" title="Back" disabled>{GLYPH.back}</button>
        <button className="dock-btn" type="button" title="Forward" disabled>{GLYPH.forward}</button>
        <button className="dock-btn" type="button" title="Reload" disabled>{GLYPH.reload}</button>
        <Address tab={shown} />
      </div>
      <Page key={shown.target} tab={shown} />
    </div>
  );
});

// The tab's picture, live (the server's cast.ts), fit into the half: the tab is in the agents' Chrome's window, the size
// Claude works in, which stays as it is. Chrome draws it at the size the half shows it, in the screen's pixels. desk
// restarting drops the socket, so it watches again, once a second for a minute, the last picture kept meanwhile.
function Page({ tab }: { tab: Tab }) {
  const shot = useRef<HTMLImageElement>(null);
  const [stand, setStand] = useState<"waiting" | "on" | "away" | "failed">("waiting");
  useEffect(() => {
    const img = shot.current!, box = img.parentElement!;
    const size = () => ({ w: Math.round(box.clientWidth * devicePixelRatio), h: Math.round(box.clientHeight * devicePixelRatio) });
    let socket: WebSocket | null = null, gone = false, tries = 0, retry = 0, shown = "", next = "";
    // Each picture shows once it has loaded, and the one before it is let go then; one that came before it loaded is
    // dropped for the next.
    img.onload = () => {
      if (shown) URL.revokeObjectURL(shown);
      shown = next;
      next = "";
    };
    const watch = () => {
      const { w, h } = size();
      const ws = socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/tabs/${tab.target}/screen?w=${w}&h=${h}`);
      ws.binaryType = "blob";
      ws.onopen = () => { tries = 0; };
      ws.onmessage = (e) => {
        if (next) URL.revokeObjectURL(next);
        img.src = next = URL.createObjectURL(e.data as Blob);
        setStand("on");
      };
      ws.onclose = (e) => {
        if (gone || ws !== socket || e.code === 4404) return; // a tab that closed leaves the strip
        setStand("away");
        if (++tries <= 60) retry = window.setTimeout(watch, 1000);
        else setStand("failed");
      };
    };
    watch();
    // a half dragged wider, or the window, gets its pictures at the new size
    let wait = 0;
    const sized = new ResizeObserver(() => {
      clearTimeout(wait);
      wait = window.setTimeout(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(size())), 300);
    });
    sized.observe(box);
    return () => {
      gone = true;
      clearTimeout(retry);
      clearTimeout(wait);
      sized.disconnect();
      socket?.close();
      for (const url of [shown, next]) if (url) URL.revokeObjectURL(url);
    };
  }, [tab.target]);
  return (
    <div className="browser-page">
      <img ref={shot} className="browser-shot" alt={tab.title || tab.url} draggable={false} hidden={stand === "waiting"} />
      {(stand === "away" || stand === "failed") && <p className="term-note">{stand === "away" ? "Reconnecting…" : "desk does not answer."}</p>}
    </div>
  );
}

// The address as Chrome's bar shows it: the host brighter than the rest. Any other address, such as data: or
// about:blank, whole.
function Address({ tab }: { tab: Tab }) {
  const { host, rest } = where(tab.url);
  return <div className="browser-url" title={tab.url}>{host ? <><b>{host}</b>{rest}</> : tab.url.slice(0, 300)}</div>;
}

const where = (url: string): { host: string; rest: string } => {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { host: "", rest: "" };
    return { host: u.host, rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}` };
  } catch {
    return { host: "", rest: "" };
  }
};

// The site's own icon, which desk fetches (the server's tabs.ts), or a globe where it finds none.
function Favicon({ tab }: { tab: Tab }) {
  const site = where(tab.url).host ? new URL(tab.url).origin : "";
  const [broken, setBroken] = useState("");
  if (!site || broken === site) return <span className="browser-fav">{GLYPH.globe}</span>;
  return <img className="browser-fav" src={`/api/tabs/${tab.target}/icon?site=${encodeURIComponent(site)}`} alt="" onError={() => setBroken(site)} />;
}
