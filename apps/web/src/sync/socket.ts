import { frame, type FrameData } from "../store/frame";
import type { IssueStore, SyncMessage } from "../store/issues";
import { reloadPages } from "../store/ui";

// The one connection to desk (the server's sync.ts): every row and the frame on connect, then each change as it is
// written. On a drop, such as desk restarting, try again each second, naming the last change applied: desk sends only
// what was missed, or every row afresh when its log no longer reaches back that far. The pages fetch themselves again,
// since what they show besides the rows may have moved meanwhile.
export function connect(store: IssueStore, again = false) {
  const since = store.log ? `log=${encodeURIComponent(store.log)}&since=${store.seq}` : "log=&since=";
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync?${since}`);
  let older = false;
  socket.onopen = () => {
    store.setConnected(true);
    if (again) void reloadPages();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as SyncMessage | { type: "frame"; frame: FrameData };
    if (message.type === "frame") return frame.take(message.frame);
    if (message.type === "snapshot" && !message.rows) older = olderDesk();
    if (!older && !store.apply(message)) socket.close(); // a change missed: connect again, asking for it
  };
  socket.onclose = () => {
    store.setConnected(false);
    setTimeout(() => connect(store, true), 1000);
  };
}

// A desk from before the log (19 Oct), such as a branch tried that began before it, sends its rows another way, which
// the app it serves reads: so reload to that app, once a minute at most.
function olderDesk(): true {
  if (Date.now() - Number(sessionStorage.olderDeskAt ?? 0) > 60_000) {
    sessionStorage.olderDeskAt = Date.now();
    location.reload();
  }
  return true;
}
