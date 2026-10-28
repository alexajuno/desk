// The tabs at the bottom of a phone's screen, where the sidebar would not fit: the Inbox, where the app opens and an
// automation's report lands; and a new chat with desk's agent, which is how a new automation starts. The automations
// left them as they left the sidebar ("remove automation tab. this tab was removed on laptop size", the user, 28 Oct),
// and open on their address. The CSS shows the tabs at phone width only.
import { observer } from "mobx-react-lite";
import { useLocation } from "react-router";
import { Go } from "../app/nav";
import { newSession } from "../sessions/Dock";
import { issues } from "../store/issues";
import { GLYPH } from "../ui/icons";

export const Tabs = observer(function Tabs() {
  const { pathname } = useLocation();
  const at = (...paths: string[]) => (paths.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? " here" : "");
  return (
    <nav className="tabs">
      <Go className={`tab${at("/inbox")}`} to="/inbox">
        <svg viewBox="0 0 16 16"><path d="M2 9h3l1 2h4l1-2h3M3 3h10l1 6v4H2V9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        Inbox{issues.unread.length > 0 && <span className="count">{issues.unread.length}</span>}
      </Go>
      <button className="tab" type="button" onClick={() => newSession()}>{GLYPH.chat}New chat</button>
    </nav>
  );
});
