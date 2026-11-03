// The pill of a chat you left, floating above a phone's tabs (phone.css). A wider screen shows none: the bar along the
// window's bottom that held it, New session, the Help menu's ? and seat's profile left on 3 Nov ("remove this bottom in
// desk. i don't think i need it"). Ctrl Shift O still starts a session, and the model menu shows the usage.
import { DockPill } from "../sessions/Dock";

export function Corner() {
  return (
    <div className="corner">
      <DockPill />
    </div>
  );
}
