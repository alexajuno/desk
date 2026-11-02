// The thread a Slack thread's, DM's or mail thread's Inbox row opens on the right (the server's
// notices.ts and pages.ts, threadRow): what came in from Slack or Gmail that the firewall let through, now or later
// (the desk issue "desk as my notification center", 2 Nov; its row is InboxPage.tsx's ThreadRow). It lists the thread's
// messages as desk got them, oldest first, under the firewall's line on why it reached you, with Open in Slack or Gmail
// for the rest of it: your own replies are no notices, so they are not here.
import { observer } from "mobx-react-lite";
import { usePage } from "../api/page";
import type { InboxRow } from "../store/issues";

interface Notice {
  id: string;
  source: "slack" | "mail";
  place: string;
  who: string;
  text: string;
  link: string;
  at: number;
  verdict: "now" | "later" | null;
  why: string;
}

const HASH = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13" /></svg>;
const BUBBLE = <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg>;
const ENVELOPE = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const OUT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;

// A thread's row's badge: a channel's #, a DM's bubble, a mail's envelope.
export const badgeOf = (r: InboxRow) => (r.source === "mail" ? ENVELOPE : r.title.startsWith("#") ? HASH : BUBBLE);
export const initial = (who: string | null | undefined) => (who ?? "?").trim().slice(0, 1).toUpperCase() || "?";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

// When a message came: 08:41 today, Nov 1, 20:45 before.
function when(at: number) {
  const d = new Date(at * 1000), time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

// What the thread is, beside its name.
function kindOf(n: Notice) {
  if (n.source === "mail") return n.place === "mail" ? "Mail" : `Mail${n.place.slice(4)}`;
  return n.place === "DM" ? "DM · Slack" : n.place.startsWith("group DM") ? "Group DM · Slack" : "Slack";
}

// The door's whys (the server's notices.ts, RULED), as the line on why it reached you says them.
const RULED: Record<string, string> = { "a DM": "a DM to you", "a group DM": "a group DM with you", "@you": "it mentions you", "a reply in your thread": "a reply in your thread" };

// The thread open on the right, asked of desk each time its row moves (the app holds no notices).
export const ThreadView = observer(function ThreadView({ row }: { row: InboxRow }) {
  const { data } = usePage<{ notices: Notice[] }>(`/api/page/thread?id=${encodeURIComponent(row.slug)}`, row.at);
  const all = data?.notices ?? [];
  const last = all[all.length - 1];
  // Why it reached you: its newest ask that needs you, though a later reply came after it, else its newest message's
  const judged = [...all].reverse().find((n) => n.verdict === "now") ?? [...all].reverse().find((n) => n.verdict === "later");
  if (!last) return <div className="thread-view" />;
  const why = judged ? RULED[judged.why] ?? judged.why : "";
  return (
    <div className="thread-view">
      <div className="thread-head">
        <div className="thread-name"><span className="thread-place">{row.title}</span><span className="thread-kind">{kindOf(last)}</span></div>
        {last.link && <button type="button" className="thread-out" onClick={() => window.open(last.link, "_blank", "noopener")}>
          {OUT}Open in {last.source === "mail" ? "Gmail" : "Slack"}</button>}
      </div>
      {judged && (
        <div className="thread-why">
          <span className="why-tag">{judged.verdict === "now" ? "Now" : "Later"}</span>
          <span className="why-text">{why || (judged.verdict === "now" ? "needs you" : "can wait")}</span>
          <span className="why-by">{RULED[judged.why] ? "by rule" : "by Claude"}</span>
        </div>
      )}
      <div className="thread-msgs">
        {all.map((n) => {
          const [first, ...rest] = n.text.split("\n");
          return (
            <div className="thread-msg" key={n.id}>
              <span className="thread-avatar">{initial(n.who)}</span>
              <div className="thread-body">
                <div className="thread-meta"><span className="thread-who">{n.who}</span><span className="thread-at">{when(n.at)}</span></div>
                {n.source === "mail"
                  ? <div className="thread-text"><strong>{first}</strong>{rest.length > 0 && <>{"\n"}{rest.join("\n")}</>}</div>
                  : <div className="thread-text">{n.text}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
