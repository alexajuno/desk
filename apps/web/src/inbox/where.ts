// A Slack or mail thread's messages as its pane reads them (the server's threads.ts, pane, through /api/page/thread),
// and where your reply to it goes, which your box says: the Inbox's pane under the thread (Thread.tsx), and the box
// above the composer of the chat that follows it (sessions/YourReply.tsx).

export interface Message {
  id: string;
  source: "slack" | "mail";
  place: string;
  who: string;
  text: string;
  link: string;
  at: number;
  verdict: "now" | "later" | null;
  why: string;
  mine: boolean; // yours
  desk: boolean; // sent from desk
  reactions: Reaction[];
  files: { name: string; kind: string; size: number | null; link: string }[];
}

export interface Reaction {
  name: string; // Slack's, such as +1 or eyes, ::skin-tone-2 after it for a tone
  count: number;
  mine: boolean;
  image?: string; // the workspace's own emoji, its picture's address
}

export interface Where {
  source: "slack" | "mail";
  chip: string; // the pane's box's foot: "#imagenhub, in minhnt’s thread", "DM with chinhdt"
  whom: string; // after "Reply as you" and "You replied": "in #imagenhub, in minhnt’s thread", "to chinhdt"
  placeholder: string;
}

// Where your reply goes: in whose thread in which channel, to whom in a DM or by mail. A mail goes to the thread's last
// sender who is not you, as Gmail's Reply.
export function whereTo(thread: string, all: Message[]): Where {
  const last = all[all.length - 1], root = all[0], source = last.source;
  const them = [...all].reverse().find((n) => !n.mine)?.who ?? last.who;
  if (source === "mail") return { source, chip: `to ${them}`, whom: `to ${them}`, placeholder: `Reply to ${them}, as you` };
  if (last.place === "DM") return { source, chip: `DM with ${them}`, whom: `to ${them}`, placeholder: `Reply to ${them}, as you` };
  if (last.place.startsWith("group DM")) return { source, chip: last.place.replace(/^g/, "G"), whom: `in the ${last.place}`, placeholder: "Reply in the group DM, as you" };
  if (thread.split(":").length !== 3) return { source, chip: last.place, whom: `in ${last.place}`, placeholder: `Reply in ${last.place}, as you` };
  const whose = root.mine ? "your" : `${root.who}’s`;
  return { source, chip: `${last.place}, in ${whose} thread`, whom: `in ${last.place}, in ${whose} thread`, placeholder: `Reply in ${whose} thread, as you` };
}
