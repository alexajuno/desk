// Your box above the composer of a chat that follows a Slack or mail thread. Reply on a thread's card in the talk
// (Came.tsx) opens it on that card's thread, under the steps, over the composer, which stays Claude's: two boxes for two
// jobs, the one above going to Slack, the composer to Claude ("next", the user, 3 Nov, on mockup 6 of step 1.9: "we
// have to make the reply cheap enough, mechanically i suppose?"). Its head says where it goes, read from the thread as
// its Inbox pane reads it (inbox/where.ts). It is the pane's box: Enter posts to Slack as you, Shift Enter makes a new
// line, a mail's Ctrl Enter sends it from Gmail (the server's replies.ts, yours), and Claude has no call that sends. Esc
// or × closes it, keeping your text for the next time it opens on that thread; one box at a time, Reply on another
// thread's card switching it. Sent, it closes, and the reply shows as a line in the talk where you sent it (Came.tsx,
// RepliedLine), drawn from the replies the app holds, costing no turn. A refusal keeps your text, with the reason.
import { action, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { whereTo, type Message, type Where } from "../inbox/where";
import { slackMark } from "../ui/icons";

const ENVELOPE = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const X = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

const box = observable({
  on: new Map<string, { thread: string; asked: number }>(), // by chat session: the thread its box is open on, and the Reply that asked
  texts: new Map<string, string>(), // by thread: what you wrote there and did not send
});
let asked = 0;

// Reply on a thread's card: the chat's box opens on its thread, or takes the cursor again if it is open on it.
export const replyTo = action((session: string, thread: string) => { box.on.set(session, { thread, asked: ++asked }); });
const shut = action((session: string) => { box.on.delete(session); });
const keep = action((thread: string, text: string) => { if (text) box.texts.set(thread, text); else box.texts.delete(thread); });

// Where a thread's reply goes, read once a box first opens on it, since the pane's read is Slack's whole thread; a read
// that found nothing is asked again the next time.
const read = new Map<string, Promise<Where | null>>();
function whereOf(thread: string): Promise<Where | null> {
  let w = read.get(thread);
  if (!w) {
    w = fetch(`/api/page/thread?id=${encodeURIComponent(thread)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { messages?: Message[] }).messages ?? [] : []))
      .then((all) => (all.length ? whereTo(thread, all) : null), () => null);
    read.set(thread, w);
    void w.then((got) => { if (!got) read.delete(thread); });
  }
  return w;
}

export const YourReply = observer(function YourReply({ session }: { session: string }) {
  const on = box.on.get(session);
  return on ? <Box key={on.thread} session={session} thread={on.thread} asked={on.asked} /> : null;
});

function Box({ session, thread, asked }: { session: string; thread: string; asked: number }) {
  const [to, setTo] = useState<Where | null>(null);
  const [text, setText] = useState(() => box.texts.get(thread) ?? "");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const mail = (to?.source ?? (thread.startsWith("mail:") ? "mail" : "slack")) === "mail";
  useEffect(() => {
    let live = true;
    void whereOf(thread).then((w) => live && setTo(w));
    return () => { live = false; };
  }, [thread]);
  useEffect(() => { // once the click on Reply is done with the focus, at the end of what you wrote
    const f = requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(f);
  }, [asked]);
  // Closed, the cursor goes to the composer under it, Claude's
  const close = () => {
    const composer = ref.current?.closest(".dock-foot")?.querySelector<HTMLTextAreaElement>(".composer textarea");
    shut(session);
    composer?.focus();
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setRefused("");
    const res = await postJson(`/api/threads/${encodeURIComponent(thread)}/send`, { text, whom: to?.whom ?? "" });
    setBusy(false);
    if (!res.ok) {
      setRefused(await reason(res));
      requestAnimationFrame(() => ref.current?.focus());
      return;
    }
    keep(thread, "");
    close(); // it shows in the talk where you sent it
  };
  return (
    <div className="reply-card your-reply">
      <div className="reply-head">
        <span className="reply-icon">{mail ? ENVELOPE : slackMark(12)}</span>
        <span className="reply-as">Reply as you</span>
        <span className="reply-whom">{to?.whom ?? ""}</span>
        <span className="spacer" />
        <button className="reply-close" type="button" title="Close, keeping what you wrote  Esc" onClick={close}>{X}</button>
      </div>
      <textarea ref={ref} className="reply-text" rows={1} value={text} spellCheck={false} disabled={busy}
        placeholder={to?.placeholder ?? "Reply, as you"}
        onChange={(e) => {
          setText(e.target.value);
          keep(thread, e.target.value);
          setRefused(""); // the reason was the text's as sent
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
          if (e.key === "Enter" && (mail ? e.ctrlKey || e.metaKey : !e.shiftKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // the frame's Esc would also leave the chat
            close();
          }
        }} />
      <div className="reply-foot">
        <span className={`reply-note${refused ? " failed" : ""}`}>{refused
          || (mail ? "Ctrl Enter sends it from Gmail as you, Enter makes a new line." : "Enter posts it to Slack as you, Shift Enter makes a new line.")}</span>
        <button className="primary" type="button" title={mail ? "Send from Gmail  Ctrl Enter" : "Send to Slack  Enter"} disabled={!text.trim() || busy}
          onClick={() => void send()}>{busy ? "Sending…" : mail ? "Send from Gmail" : "Send to Slack"}</button>
      </div>
    </div>
  );
}
