// The buttons at the bottom right of every page (templates/corner.html), where Linear keeps Agent and Chat history:
// New session starts a Claude Code session, and a hidden session waits there as a pill. The clock that listed the
// sessions left it on 31 Oct: the search finds them (search/SearchBox.tsx).
import { DockPill, newSession } from "../sessions/Dock";

export function Corner() {
  return (
    <div className="corner">
      <DockPill />
      <button className="corner-new new-session" type="button" title="New session  Ctrl Shift O" onClick={() => newSession()}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M4.5 6l2 2-2 2M8 10.5h3.5" /></svg>New session
      </button>
    </div>
  );
}
