// The buttons at the bottom right of every page (templates/corner.html), where Linear keeps Agent and Chat history:
// New session starts a Claude Code session in a window over desk, and the clock lists the sessions.
import { openWindow } from "../issues/actions";
import { openMenu, toggled } from "../ui/menu";

export const newSession = () => openWindow("/sessions/new");

// As Linear's Chat history: the newest sessions, or those matching what is typed, each with its folder and age.
function sessionsMenu(anchor: Element) {
  openMenu({
    anchor, className: "sessions-menu", filter: "keys", placeholder: "Find a session…", empty: "No matching sessions",
    items: async (query) => ((await (await fetch(`/sessions/recent?q=${encodeURIComponent(query)}`)).json()) as { id: string; title: string; folder?: string; age?: string }[])
      .map((s) => ({ label: s.title, hint: [s.folder, s.age].filter(Boolean).join(" · "), run: () => openWindow(`/sessions/${s.id}/open`) })),
  });
}

export function Corner() {
  return (
    <div className="corner">
      <button className="corner-new new-session" type="button" title="New session  Ctrl Shift O" onClick={newSession}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M4.5 6l2 2-2 2M8 10.5h3.5" /></svg>New session
      </button>
      <button className="dock-history" type="button" title="Sessions" onClick={(e) => { if (!toggled(e.currentTarget)) sessionsMenu(e.currentTarget); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.65 9.65l1.79-1.8c.32-.31.1-.85-.35-.85H3.05a5.25 5.25 0 1 1 1.82 4.77.75.75 0 1 0-.97 1.15A6.75 6.75 0 1 0 1.54 7H.5c-.45 0-.67.54-.35.85l1.79 1.8c.2.19.52.19.71 0Z" /><path d="M8.37 5.68a.69.69 0 0 0-1.37 0v2.7c0 .38.31.69.69.69h2.74a.69.69 0 0 0 0-1.36H8.37V5.68Z" /></svg>
      </button>
    </div>
  );
}
