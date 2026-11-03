// The thread a Slack thread's, DM's or mail thread's Inbox row opens on the right (the server's
// notices.ts and pages.ts, threadRow): what came in from Slack or Gmail that the firewall let through, now or later
// (the desk issue "desk as my notification center", 2 Nov; its row is InboxPage.tsx's ThreadRow). It lists the thread's
// messages as desk got them, oldest first, under the firewall's line on why it reached you, with Open in Slack or Gmail
// for the rest of it: your own replies are no notices, so they are not here.
//
// A composer under it starts a chat with Claude on the thread, which only you see (the server's threads.ts: "pops up
// and carry it on with me", the user, 2 Nov), picked from two mockups on 2 Nov over one with Draft a reply, File an
// issue and Mark done above the box. From then on the row opens on that chat, which opens on a card of the thread as
// Claude read it, wherever it is opened (sessions/Came.tsx, 3 Nov): the whole thread shows only before you wrote. The
// chat follows the thread, so the thread's row leaves the Inbox for the chat's, which carries its news (the server's
// pages.ts, withNews), and the pane goes with it.
//
// A reply the chat's Claude drafted waits on a card above the composer (ReplyCard; the server's replies.ts), yours to
// edit, and only your Send there posts it to Slack or sends it from Gmail as you: Claude has no call that sends.
//
// A Slack or Gmail login that ended has a row of its own (the server's logins.ts and pages.ts, loginRow), which opens on
// what to do (LoginView), picked from two mockups over a strip above the Inbox's list, which the phone hides.
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { postJson, reason } from "../api/http";
import { usePage } from "../api/page";
import { SessionView } from "../sessions/Dock";
import { issues, type InboxRow, type Reply } from "../store/issues";
import { toast } from "../ui/toast";

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
  mine: boolean; // a reply you sent from desk
}

const HASH = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13" /></svg>;
const BUBBLE = <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg>;
const ENVELOPE = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const OUT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;

// A thread's row's badge: a channel's #, a DM's bubble, a mail's envelope.
const KEY = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="5.5" cy="10.5" r="3" /><path d="M7.7 8.3 13.5 2.5M11 5l2 2" /></svg>;

const isLogin = (r: InboxRow) => r.slug.startsWith("login:");
export const badgeOf = (r: InboxRow) => (isLogin(r) ? KEY : r.source === "mail" ? ENVELOPE : r.title.startsWith("#") ? HASH : BUBBLE);
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

const SEND = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>;

// The chat each thread started from this tab, by thread, until its row says so itself.
const started = observable.map<string, string>();

// The session of the thread's chat, or null while you have not written in it.
export const chatOf = (row: InboxRow) => row.session ?? started.get(row.slug) ?? null;

// The chat you started on a thread from this tab, once its row left for the chat's (InboxPage).
export const startedOn = (thread: string) => started.get(thread);

// The thread open on the right: the thread with a composer under it, or once you wrote, the chat on it.
export const ThreadView = observer(function ThreadView({ row }: { row: InboxRow }) {
  if (isLogin(row)) return <LoginView row={row} />;
  const session = chatOf(row);
  if (session) return <SessionView id={session} foot={<ReplyCard thread={row.slug} />} />;
  return (
    <div className="thread-pane">
      <ThreadBody row={row} />
      <ThreadComposer row={row} />
    </div>
  );
});

// A login that ended: since when, what refused it, and what mends it. The row leaves once desk is signed in again.
function LoginView({ row }: { row: InboxRow }) {
  const { data } = usePage<{ login?: { source: "slack" | "mail"; at: number; why: string } }>(`/api/page/thread?id=${encodeURIComponent(row.slug)}`, String(row.at));
  const login = data?.login, slack = row.source === "slack";
  return (
    <div className="thread-pane">
      <div className="thread-view">
        <div className="thread-head">
          <div className="thread-name"><span className="thread-place">{row.title}</span><span className="thread-kind">{slack ? "Slack" : "Mail"}</span></div>
          {slack && <button type="button" className="thread-out" onClick={() => window.open("https://ownego.slack.com", "_blank", "noopener")}>{OUT}Open Slack</button>}
        </div>
        {login && (
          <div className="thread-why">
            <span className="why-tag">Login</span>
            <span className="why-text">{login.why}</span>
            <span className="why-by">since {when(login.at)}</span>
          </div>
        )}
        <p className="login-text">{slack
          ? "desk reads your Slack login from your Chrome, Profile 2. Log in to Slack there once: desk tries again each minute, and once it holds, reads back what came in meanwhile. Until then nothing from Slack reaches you here."
          : "desk reads Gmail with muse's Gmail login, mail/gmail-muse in pass, and Google no longer takes its refresh token: it was revoked or expired. Put a new one there, from the same client: desk tries again each minute, and once it holds, reads from where it stopped. Until then no mail reaches you here."}</p>
        <p className="login-text login-note">This row leaves on its own once desk is signed in again.</p>
      </div>
    </div>
  );
}

// The thread's reply not sent yet, the newest: Claude's draft, or one Slack or Gmail refused.
const unsent = (thread: string): Reply | null =>
  [...issues.replies.values()].filter((r) => r.thread === thread && r.state !== "sent" && r.state !== "kept").sort((a, b) => b.at - a.at)[0] ?? null;

// The card above the composer, mockup A of two (2 Nov) over one in the conversation, which scrolls away. A newer draft
// starts it afresh, what you typed in it gone with the one it replaced.
const ReplyCard = observer(function ReplyCard({ thread }: { thread: string }) {
  const r = unsent(thread);
  return r ? <ReplyBox key={`${r.id}:${r.at}`} reply={r} /> : null;
});

function ReplyBox({ reply }: { reply: Reply }) {
  const [text, setText] = useState(reply.text);
  const [busy, setBusy] = useState(false);
  const where = reply.source === "mail" ? "Gmail" : "Slack";
  const sending = busy || reply.state === "sending";
  const send = async () => {
    if (!text.trim() || sending) return;
    setBusy(true);
    const res = await postJson(`/api/replies/${reply.id}/send`, { text });
    setBusy(false);
    if (!res.ok) return toast(await reason(res));
    const { state } = (await res.json()) as { state: Reply["state"] };
    if (state === "sent") toast(reply.source === "mail" ? "Sent from Gmail" : "Sent to Slack");
    else if (state === "kept") toast("Kept: a test desk sends nothing");
  };
  const discard = async () => {
    const res = await fetch(`/api/replies/${reply.id}`, { method: "DELETE" });
    if (!res.ok) toast(await reason(res));
  };
  return (
    <div className="reply-card">
      <div className="reply-head">
        <span className="reply-icon">{reply.source === "mail" ? ENVELOPE : reply.whom.startsWith("in #") ? HASH : BUBBLE}</span>
        <span className="reply-as">Reply as you</span>
        <span className="reply-whom">{reply.whom}</span>
      </div>
      <textarea className="reply-text" value={text} spellCheck={false} disabled={sending} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // the frame's Esc would also leave the page
            e.currentTarget.blur();
          }
        }} />
      <div className="reply-foot">
        {reply.state === "failed"
          ? <span className="reply-note failed">{where} refused it: {reply.error}</span>
          : <span className="reply-note">Claude’s draft, yours to edit. Only Send posts it.</span>}
        <button className="ghost" type="button" disabled={sending} onClick={() => void discard()}>Discard</button>
        <button className="primary" type="button" title={`Send  Ctrl Enter`} disabled={!text.trim() || sending} onClick={() => void send()}>
          {sending ? "Sending…" : reply.source === "mail" ? "Send from Gmail" : "Send to Slack"}</button>
      </div>
    </div>
  );
}

// The box under a thread no chat is on yet: what you write starts the chat, and the pane turns to it.
function ThreadComposer({ row }: { row: InboxRow }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const res = await postJson("/api/threads/chat", { thread: row.slug, text });
    if (!res.ok) {
      toast(await reason(res));
      setBusy(false);
      return;
    }
    const { session } = (await res.json()) as { session: string };
    runInAction(() => started.set(row.slug, session));
  };
  return (
    <div className="dock-foot">
      <ReplyCard thread={row.slug} />
      <div className="composer">
        <div className="composer-text">
          <textarea rows={1} value={text} spellCheck={false} disabled={busy} placeholder="Ask Claude about it: draft a reply, file it, look into it"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation(); // the frame's Esc would also leave the page: that is the next Esc's to do
                e.currentTarget.blur();
              }
            }} />
        </div>
        <div className="composer-foot" onMouseDown={(e) => e.preventDefault()}>
          <span className="spacer" />
          <button className="send" type="button" title="Send  Enter" disabled={!text.trim() || busy} onClick={() => void send()}>{SEND}</button>
        </div>
      </div>
    </div>
  );
}

// The thread itself, asked of desk each time its row moves, or a reply you sent goes into it (the app holds no notices).
const ThreadBody = observer(function ThreadBody({ row }: { row: InboxRow }) {
  const sent = [...issues.replies.values()].filter((r) => r.thread === row.slug && (r.state === "sent" || r.state === "kept")).length;
  const { data } = usePage<{ notices: Notice[] }>(`/api/page/thread?id=${encodeURIComponent(row.slug)}`, `${row.at}:${sent}`);
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
                <div className="thread-meta"><span className="thread-who">{n.who}</span><span className="thread-at">{when(n.at)}{n.mine && (n.link ? " · from desk" : " · kept, a test desk sends nothing")}</span></div>
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
