import { frame, type FrameData } from "../store/frame";
import type { IssueStore, SyncMessage } from "../store/issues";

// The one connection to desk (the server's sync.ts): every issue and the frame on connect, then each change as it
// happens. On a drop, such as desk restarting, try again each second; the snapshot on reconnect brings back whatever
// was missed.
export function connect(store: IssueStore) {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/sync`);
  socket.onopen = () => store.setConnected(true);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as SyncMessage | { type: "frame"; frame: FrameData };
    if (message.type === "frame") frame.take(message.frame);
    else store.apply(message);
  };
  socket.onclose = () => {
    store.setConnected(false);
    setTimeout(() => connect(store), 1000);
  };
}
