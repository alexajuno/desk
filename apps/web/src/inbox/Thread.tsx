// The thread a Slack thread's, DM's or mail thread's Inbox row opens on the right (the server's
// notices.ts and pages.ts, threadRow): what came in from Slack or Gmail that the firewall let through, now or later
// (the desk issue "desk as my notification center", 2 Nov; its row is InboxPage.tsx's ThreadRow). It lists the thread's
// messages, oldest first, under the firewall's line on why it reached you, with Open in Slack or Gmail. A Slack thread
// is read whole from Slack, your own messages too, with their reactions and files (the server's threads.ts, pane); a
// mail thread is what desk got of it.
//
// A Slack message shows its reactions as pills, the emoji and how many, yours with an accent edge, and its files as
// cards, by name, kind and size, with Open in Slack and no preview ("a lot of messages i have to react and reply within
// the chat", the user, 3 Nov; mockup 5 of step 1.8). A click on a pill adds yours or takes it back, and under the mouse
// a bar of four quick reactions and the picker does the same, as you in Slack (the server's threads.ts, react): only
// your click sends it. The pane shows the change at once and reads the thread again behind it.
//
// The box under it is yours: what you write there posts to Slack as you on Enter, or on Ctrl Enter sends from Gmail,
// since a mail runs long, and shows in the thread at once (YourBox; the server's replies.ts, yours): "we have to make
// the reply cheap enough, mechanically i suppose?" (the user, 3 Nov; mockup 5 of step 1.8). Its foot says where it
// goes. Ask Claude in the head opens Claude's box in its place, and Esc brings yours back: what you write there starts
// a chat with Claude on the thread, which only you see (the server's threads.ts: "pops up and carry it on with me", the
// user, 2 Nov). From then on the row opens on that chat, which opens on a card of the thread as Claude read it,
// wherever it is opened (sessions/Came.tsx, 3 Nov): the whole thread shows only before you wrote. The chat follows the
// thread, so the thread's row leaves the Inbox for the chat's, which carries its news (the server's pages.ts,
// withNews), and the pane goes with it.
//
// A reply the chat's Claude drafted waits on a card above the composer (ReplyCard; the server's replies.ts), yours to
// edit, and only your Send there posts it to Slack or sends it from Gmail as you: Claude has no call that sends.
//
// A Slack or Gmail login that ended has a row of its own (the server's logins.ts and pages.ts, loginRow), which opens on
// what to do (LoginView), picked from two mockups over a strip above the Inbox's list, which the phone hides.
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { usePage } from "../api/page";
import { SessionView } from "../sessions/Dock";
import { issues, type InboxRow, type Reply } from "../store/issues";
import { closeMenu, openMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { charOf, emojiGroups } from "./emoji";

interface Message {
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
interface Reaction {
  name: string; // Slack's, such as +1 or eyes, ::skin-tone-2 after it for a tone
  count: number;
  mine: boolean;
  image?: string; // the workspace's own emoji, its picture's address
}

const HASH = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13" /></svg>;
const BUBBLE = <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg>;
const ENVELOPE = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const OUT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;

// Slack's mark in its four colours, as Slack's brand draws it (the paths are Simple Icons'), on a Slack row's badge and its
// thread's head: "inside inbox, with slack icon" (the user, 3 Nov).
const SLACK_PATHS = [
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
  "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
  "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
  "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
];
const SLACK_FILLS = ["var(--slack-red)", "var(--slack-blue)", "var(--slack-green)", "var(--slack-yellow)"];
export const slackMark = (px: number) => (
  <svg width={px} height={px} viewBox="0 0 24 24">{SLACK_PATHS.map((d, i) => <path key={i} d={d} style={{ fill: SLACK_FILLS[i] }} />)}</svg>
);
const SMILE_PLUS = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M13.6 7.2A5.75 5.75 0 1 1 8.8 2.3" /><path d="M5.75 9.5c.5.8 1.3 1.25 2.25 1.25s1.75-.45 2.25-1.25" /><path d="M6 6.5h.01M10 6.5h.01" strokeWidth="1.8" /><path d="M12.5 1.5v4M10.5 3.5h4" /></svg>;
const FILE = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 1.75H4.75a1.25 1.25 0 0 0-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.25z" /><path d="M9 1.75v3.5h3.5" /></svg>;

// A thread's row's badge: Slack's mark, a mail's envelope, and a login's key.
const KEY = <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="5.5" cy="10.5" r="3" /><path d="M7.7 8.3 13.5 2.5M11 5l2 2" /></svg>;

const isLogin = (r: InboxRow) => r.slug.startsWith("login:");
export const badgeOf = (r: InboxRow) => (isLogin(r) ? KEY : r.source === "mail" ? ENVELOPE : slackMark(10));
export const initial = (who: string | null | undefined) => (who ?? "?").trim().slice(0, 1).toUpperCase() || "?";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

// When a message came: 08:41 today, Nov 1, 20:45 before.
function when(at: number) {
  const d = new Date(at * 1000), time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

// What the thread is, beside its name: a channel's thread by whose it is, as Slack's own head says.
function kindOf(n: Message, root: Message | undefined, thread: string) {
  if (n.source === "mail") return n.place === "mail" ? "Mail" : `Mail${n.place.slice(4)}`;
  if (n.place === "DM") return "DM · Slack";
  if (n.place.startsWith("group DM")) return "Group DM · Slack";
  const whose = thread.split(":").length === 3 && root ? (root.who === "you" ? "your thread" : `${root.who}’s thread`) : "";
  return whose ? `${whose} · Slack` : "Slack";
}

// A file's size, as Slack's card says it: 312 B, 4 KB, 1.2 MB.
function sizeOf(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// The door's whys (the server's notices.ts, RULED), as the line on why it reached you says them.
const RULED: Record<string, string> = { "a DM": "a DM to you", "a group DM": "a group DM with you", "@you": "it mentions you", "a reply in your thread": "a reply in your thread" };

const SMILE = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.75" /><path d="M5.75 9.5c.5.8 1.3 1.25 2.25 1.25s1.75-.45 2.25-1.25" /><path d="M6 6.5h.01M10 6.5h.01" strokeWidth="1.8" /></svg>;
// The chat icon of desk's sidebar (ui/icons.tsx, chat), on Ask Claude
const CHAT = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" clipRule="evenodd" d="M11.869 11.52c.946-.767 1.631-1.956 1.631-3.77s-.685-3.003-1.631-3.77C10.879 3.178 9.486 2.75 8 2.75c-1.694 0-3.065.44-3.985 1.213-.88.74-1.515 1.918-1.515 3.787 0 1.104.255 1.96.641 2.622.541.81.224 1.65.119 1.906-.073.177-.16.344-.219.455l-.03.057a7 7 0 0 0-.136.268c.242.18.563.217 1.1.078a7 7 0 0 0 .893-.32l.027-.01c.124-.052.29-.12.438-.17.08-.027.21-.067.36-.092.09-.014.365-.057.695.03A7.3 7.3 0 0 0 8 12.75c1.486 0 2.88-.428 3.869-1.23m-5.852 2.507A8.8 8.8 0 0 0 8 14.25c3.501 0 7-2.005 7-6.5s-3.499-6.5-7-6.5c-3.866 0-7 2.005-7 6.5 0 1.372.326 2.512.878 3.434.168.222.003.535-.19.901-.3.565-.665 1.257.02 1.942 1.215 1.215 2.864.534 3.739.173.289-.119.493-.203.57-.173" /></svg>;
const SEND = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>;

// The chat each thread started from this tab, by thread, until its row says so itself.
const started = observable.map<string, string>();

// The session of the thread's chat, or null while you have not written in it.
export const chatOf = (row: InboxRow) => row.session ?? started.get(row.slug) ?? null;

// The chat you started on a thread from this tab, once its row left for the chat's (InboxPage).
export const startedOn = (thread: string) => started.get(thread);

// The thread open on the right: the thread with your box under it, or once you asked Claude, the chat on it.
export const ThreadView = observer(function ThreadView({ row }: { row: InboxRow }) {
  if (isLogin(row)) return <LoginView row={row} />;
  const session = chatOf(row);
  if (session) return <SessionView id={session} foot={<ReplyCard thread={row.slug} />} />;
  return <ThreadPane row={row} />;
});

interface Page { messages: Message[]; me?: string }

// The thread, asked of desk each time its row moves, or a reply you sent goes into it (the app holds no notices), and
// under it your box, or Claude's while you ask it.
const ThreadPane = observer(function ThreadPane({ row }: { row: InboxRow }) {
  const sent = [...issues.replies.values()].filter((r) => r.thread === row.slug && (r.state === "sent" || r.state === "kept")).length;
  const page = usePage<Page>(`/api/page/thread?id=${encodeURIComponent(row.slug)}`, `${row.at}:${sent}`);
  const [asking, setAsking] = useState(false);
  const all = page.data?.messages ?? [];
  return (
    <div className="thread-pane">
      <ThreadBody row={row} page={page} asking={asking} ask={() => setAsking((a) => !a)} />
      <div className="dock-foot">
        <ReplyCard thread={row.slug} />
        {asking ? <AskBox row={row} back={() => setAsking(false)} />
          : all.length > 0 && <YourBox row={row} to={whereTo(row.slug, all)} />}
      </div>
    </div>
  );
});

// Where your reply goes, as your box's foot and its placeholder say it: in whose thread in which channel, to whom in a
// DM or by mail. A mail goes to the thread's last sender who is not you, as Gmail's Reply.
function whereTo(thread: string, all: Message[]) {
  const last = all[all.length - 1], root = all[0];
  const them = [...all].reverse().find((n) => !n.mine)?.who ?? last.who;
  if (last.source === "mail") return { source: last.source, chip: `to ${them}`, placeholder: `Reply to ${them}, as you` };
  if (last.place === "DM") return { source: last.source, chip: `DM with ${them}`, placeholder: `Reply to ${them}, as you` };
  if (last.place.startsWith("group DM")) return { source: last.source, chip: last.place.replace(/^g/, "G"), placeholder: "Reply in the group DM, as you" };
  if (thread.split(":").length !== 3) return { source: last.source, chip: last.place, placeholder: `Reply in ${last.place}, as you` };
  const whose = root.mine ? "your" : `${root.who}’s`;
  return { source: last.source, chip: `${last.place}, in ${whose} thread`, placeholder: `Reply in ${whose} thread, as you` };
}

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

// Your box, under the thread: Enter posts to Slack as you, Shift Enter makes a new line; a mail's Enter makes a new line
// and Ctrl Enter sends it from Gmail. What you sent shows in the thread at once, as from desk until Slack's copy is
// read; a refusal keeps your text, with the reason under it, to send again.
function YourBox({ row, to }: { row: InboxRow; to: ReturnType<typeof whereTo> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const mail = to.source === "mail";
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setRefused("");
    const res = await postJson(`/api/threads/${encodeURIComponent(row.slug)}/send`, { text });
    setBusy(false);
    if (!res.ok) {
      setRefused(await reason(res));
      return;
    }
    setText(""); // it shows in the thread, as from desk, or kept on a test desk
    requestAnimationFrame(() => box.current?.focus());
  };
  // An emoji from the picker, where the caret is: its character, or a workspace's own as :name:, which Slack draws
  const put = (name: string, image?: string) => {
    const el = box.current, emoji = image ? `:${name}:` : charOf(name) ?? `:${name}:`;
    const at = el?.selectionStart ?? text.length, upto = el?.selectionEnd ?? at;
    setText(text.slice(0, at) + emoji + text.slice(upto));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  };
  return (
    <div className="composer">
      <div className="composer-text">
        <textarea ref={box} rows={1} value={text} spellCheck={false} disabled={busy} placeholder={to.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
            if (e.key === "Enter" && (mail ? e.ctrlKey || e.metaKey : !e.shiftKey)) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // the frame's Esc would also leave the page: that is the next Esc's to do
              e.currentTarget.blur();
            }
          }} />
      </div>
      {refused && <div className="reply-refused">{refused}</div>}
      <div className="composer-foot" onMouseDown={(e) => e.preventDefault()}>
        <span className="reply-to">{mail ? ENVELOPE : slackMark(12)}<span>{to.chip}</span></span>
        {!mail && <button className="emoji" type="button" title="Emoji" onClick={(e) => pickEmoji(e.currentTarget, put)}>{SMILE}</button>}
        <span className="spacer" />
        <button className="send" type="button" title={mail ? "Send from Gmail  Ctrl Enter" : "Send to Slack  Enter"} disabled={!text.trim() || busy}
          onClick={() => void send()}>{SEND}</button>
      </div>
    </div>
  );
}

// Claude's box, in yours' place while you ask it: what you write starts a chat on the thread, which only you see, and
// the pane turns to it. Esc brings your box back.
function AskBox({ row, back }: { row: InboxRow; back: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { // once the click on Ask Claude is done with the focus
    const f = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);
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
    <div className="composer">
      <div className="composer-text">
        <textarea ref={box} rows={1} value={text} spellCheck={false} disabled={busy} placeholder="Ask Claude about it: draft a reply, file it, look into it"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // your box again, not the frame's Esc
              back();
            }
          }} />
      </div>
      <div className="composer-foot" onMouseDown={(e) => e.preventDefault()}>
        <span className="reply-to">{CHAT}<span>Claude, only you see it</span></span>
        <span className="spacer" />
        <button className="send" type="button" title="Ask Claude  Enter" disabled={!text.trim() || busy} onClick={() => void send()}>{SEND}</button>
      </div>
    </div>
  );
}

// The thread itself, its head holding Ask Claude, then Open in Slack or Gmail.
function ThreadBody({ row, page: { data, reload }, asking, ask }: { row: InboxRow; page: { data: Page | null; reload: () => unknown }; asking: boolean; ask: () => void }) {
  // Your reactions as you clicked them, shown until the thread is read again with them
  const [clicked, setClicked] = useState<Map<string, Reaction[]>>(() => new Map());
  useEffect(() => setClicked(new Map()), [data]);
  const all = data?.messages ?? [];
  const last = all[all.length - 1];
  // Why it reached you: its newest ask that needs you, though a later reply came after it, else its newest message's
  const judged = [...all].reverse().find((n) => n.verdict === "now") ?? [...all].reverse().find((n) => n.verdict === "later");
  if (!last) return <div className="thread-view" />;
  const why = judged ? RULED[judged.why] ?? judged.why : "";
  const slackThread = row.slug.startsWith("slack:");
  const out = [...all].reverse().find((n) => n.link)?.link; // a reply of yours a test desk kept has none
  const reactionsOf = (n: Message) => clicked.get(n.id) ?? n.reactions;
  // Yours on the message, added or taken back: on Slack's pill, its quick bar and its picker alike
  const react = async (n: Message, name: string, image?: string) => {
    const list = reactionsOf(n), had = list.find((r) => r.name === name), on = !had?.mine;
    const next = had
      ? list.map((r) => (r === had ? { ...r, mine: on, count: r.count + (on ? 1 : -1) } : r)).filter((r) => r.count > 0)
      : [...list, { name, count: 1, mine: true, ...(image ? { image } : {}) }];
    setClicked((was) => new Map(was).set(n.id, next));
    const res = await postJson("/api/reactions", { message: n.id, name, on });
    if (!res.ok) toast(await reason(res));
    void reload();
  };
  return (
    <div className="thread-view">
      <div className="thread-head">
        <div className="thread-name">
          {slackThread && <span className="thread-mark">{slackMark(16)}</span>}
          <span className="thread-place">{row.title}</span><span className="thread-kind">{kindOf(last, all[0], row.slug)}</span>
        </div>
        <button type="button" className={`thread-out${asking ? " on" : ""}`} title={asking ? "Back to your reply  Esc" : "Ask Claude about it"} onClick={ask}>{CHAT}Ask Claude</button>
        {out && <button type="button" className="thread-out" onClick={() => window.open(out, "_blank", "noopener")}>
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
          const reacts = n.source === "slack" && n.id.startsWith("slack:"); // a reply only desk has yet takes none
          const reactions = reactionsOf(n);
          return (
            <div className="thread-msg" key={n.id}>
              {reacts && (
                <div className="react-bar">
                  {QUICK.map((q) => <button key={q} type="button" title={`:${q}:`} onClick={() => void react(n, q)}>{charOf(q)}</button>)}
                  <button type="button" className="more" title="Add reaction" onClick={(e) => pickEmoji(e.currentTarget, (name, image) => void react(n, name, image))}>{SMILE_PLUS}</button>
                </div>
              )}
              <span className={`thread-avatar${n.mine ? " me" : ""}`}>{initial(n.mine && data?.me ? data.me : n.who)}</span>
              <div className="thread-body">
                <div className="thread-meta"><span className="thread-who">{n.who}</span><span className="thread-at">{when(n.at)}{n.desk && (n.link ? " · from desk" : " · kept, a test desk sends nothing")}</span></div>
                {n.source === "mail"
                  ? <div className="thread-text"><strong>{first}</strong>{rest.length > 0 && <>{"\n"}{rest.join("\n")}</>}</div>
                  : n.text && <div className="thread-text">{n.text}</div>}
                {n.files.map((f, i) => (
                  <div className="file-card" key={i}>
                    {FILE}<span className="file-name">{f.name}</span>
                    <span className="file-meta">{[f.kind, sizeOf(f.size)].filter(Boolean).join(" · ")}</span>
                    {f.link && <button type="button" className="thread-out" onClick={() => window.open(f.link, "_blank", "noopener")}>{OUT}Open in Slack</button>}
                  </div>
                ))}
                {reacts && reactions.length > 0 && (
                  <div className="reacts">
                    {reactions.map((r) => (
                      <button key={r.name} type="button" className={`react${r.mine ? " mine" : ""}`} title={`:${r.name}:`} onClick={() => void react(n, r.name)}>
                        {r.image ? <img src={r.image} alt={`:${r.name}:`} /> : <span className="react-emoji">{charOf(r.name) ?? `:${r.name}:`}</span>}
                        <span>{r.count}</span>
                      </button>
                    ))}
                    <button type="button" className="react add" title="Add reaction" onClick={(e) => pickEmoji(e.currentTarget, (name, image) => void react(n, name, image))}>{SMILE_PLUS}</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The bar under the mouse: Slack's own four quick reactions, then the picker.
const QUICK = ["+1", "white_check_mark", "eyes", "pray"];

// The workspace's own emoji, asked of desk once, for the picker.
let workspace: Promise<Record<string, string>> | null = null;
const workspaceEmoji = () => (workspace ??= fetch("/api/slack/emoji")
  .then(async (r) => (r.ok ? ((await r.json()) as { emoji?: Record<string, string> }).emoji ?? {} : {}))
  .catch(() => ({})));

// The picker, in the menu's place under what opened it: a search box over every emoji by category, the workspace's own
// first, as Slack's. Enter takes the first found; Esc and a click outside close it.
function pickEmoji(anchor: Element, pick: (name: string, image?: string) => void) {
  openMenu({ anchor, className: "emoji-pick", items: () => [], render: () => <EmojiPick pick={(name, image) => { closeMenu(); pick(name, image); }} /> });
}

interface Pickable { name: string; names: string[]; char?: string; image?: string }

function EmojiPick({ pick }: { pick: (name: string, image?: string) => void }) {
  const [typed, setTyped] = useState("");
  const [custom, setCustom] = useState<Record<string, string>>({});
  useEffect(() => void workspaceEmoji().then(setCustom), []);
  const query = typed.trim().toLowerCase().replace(/^:|:$/g, "");
  const groups: { title: string; emoji: Pickable[] }[] = [
    { title: "Custom", emoji: Object.entries(custom).sort(([a], [b]) => a.localeCompare(b)).map(([name, image]) => ({ name, names: [name], image })) },
    ...emojiGroups(),
  ].map((g) => ({ title: g.title, emoji: query ? g.emoji.filter((e) => e.names.some((n) => n.includes(query))) : g.emoji }))
    .filter((g) => g.emoji.length);
  const firstFound = groups[0]?.emoji[0];
  return (
    <div className="emoji-pick-in">
      <input autoFocus type="text" placeholder="Search emoji" value={typed} spellCheck={false} onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !firstFound) return;
          e.preventDefault();
          pick(firstFound.name, firstFound.image);
        }} />
      <div className="emoji-list">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="emoji-group">{g.title}</div>
            <div className="emoji-grid">
              {g.emoji.map((e) => (
                <button key={e.name} type="button" title={`:${e.name}:`} onClick={() => pick(e.name, e.image)}>
                  {e.image ? <img src={e.image} alt="" loading="lazy" /> : e.char}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div className="emoji-none">No emoji is named “{query}”</div>}
      </div>
    </div>
  );
}
