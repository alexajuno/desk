// A chat's Browser, a view of its right half (Half.tsx): the tabs its session has open in the agents' Chrome, which the
// session host's relay notes and desk keeps (the server's tabs.ts), as a strip, then back, forward, reload and the open
// tab's address, then the page ("okay A", the user's pick from three mockups, 31 Oct). The strip has no new tab or ×:
// the tabs are the session's, opened and closed by Claude.
import { observer } from "mobx-react-lite";
import { useState } from "react";
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
      <div className="browser-page" />
    </div>
  );
});

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
