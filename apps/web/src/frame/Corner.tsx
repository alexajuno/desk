// The pill of a chat you left, above a phone's tabs (phone.css). A wider screen shows no corner since 3 Nov ("i talked
// about the new session and the session tab", the user): Ctrl Shift O starts a session, and the search finds a chat.
import { DockPill } from "../sessions/Dock";

export function Corner() {
  return (
    <div className="corner">
      <DockPill />
    </div>
  );
}
