// Your box above the composer of a chat that follows a Slack or mail thread. Reply on a thread's card in the talk
// (Came.tsx) opens it on that card's thread, under the steps, over the composer, which stays Claude's: two boxes for two
// jobs, the one above going to Slack, the composer to Claude ("next", the user, 3 Nov, on mockup 6 of step 1.9: "we
// have to make the reply cheap enough, mechanically i suppose?"). Its head says where it goes, read from the thread as
// its Inbox pane reads it (inbox/where.ts). It is the pane's box: Enter posts to Slack as you, Shift Enter makes a new
// line, a mail's Ctrl Enter sends it from Gmail (the server's replies.ts, yours), and Claude has no call that sends. Esc
// or × closes it, keeping your text for the next time it opens on that thread; one box at a time, Reply on another
// thread's card switching it. Sent, it closes, and the reply shows as a line in the talk where you sent it (Came.tsx,
// RepliedLine), drawn from the replies the app holds, costing no turn. A refusal keeps your text, with the reason.
//
// Claude's draft, put when you ask for one (the server's replies.ts, draft), opens the box on its thread, tagged
// Claude's draft, yours to edit, with Discard; your Enter or Send there posts it as you. A draft on the thread the box is
// on takes it, since you asked for it; one on another thread waits, the head saying "1 more", which switches to it.
import { action, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { postJson, reason } from "../api/http";
import { whereTo, type Message, type Where } from "../inbox/where";
import { issues, type Reply } from "../store/issues";
import { slackMark } from "../ui/icons";

const ENVELOPE = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const X = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

const box = observable({
  on: new Map<string, { thread: string; asked: number }>(), // by chat session: the thread its box is open on, and the Reply that asked
  texts: new Map<string, { text: string; of: string }>(), // by thread: what you wrote there and did not send, and over which draft of Claude's
});
let asked = 0;
const opened = new Set<string>(); // Claude's drafts that opened a box, by keyOf, so that each opens it once

// Reply on a thread's card: the chat's box opens on its thread, or takes the cursor again if it is open on it.
export const replyTo = action((session: string, thread: string) => { box.on.set(session, { thread, asked: ++asked }); });
const shut = action((session: string) => { box.on.delete(session); });
const keep = action((thread: string, text: string, of: string) => { if (text) box.texts.set(thread, { text, of }); else box.texts.delete(thread); });

// A draft as Claude last put it: a newer one on the thread keeps its id and takes a new time.
const keyOf = (r: Reply) => `${r.id}:${r.at}`;

// Claude's drafts on the threads the chat follows, not sent yet, the newest first; one Slack or Gmail refused too.
function draftsOf(session: string): Reply[] {
  const threads = [...issues.chats.values()].find((c) => c.session === session)?.threads ?? [];
  if (!threads.length) return [];
  return [...issues.replies.values()]
    .filter((r) => threads.includes(r.thread) && r.state !== "sent" && r.state !== "kept")
    .sort((a, b) => b.at - a.at);
}

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
  const drafts = draftsOf(session);
  const fresh = drafts.filter((d) => !opened.has(keyOf(d)));
  const news = fresh.map(keyOf).join();
  useEffect(() => { // a draft Claude put opens the box on its thread, while it is shut; open, the box takes or counts it
    if (!fresh.length) return;
    for (const d of fresh) opened.add(keyOf(d));
    if (!box.on.get(session)) replyTo(session, fresh[0].thread);
  }, [news]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = box.on.get(session);
  if (!on) return null;
  const draft = drafts.find((d) => d.thread === on.thread) ?? null;
  const more = [...new Set(drafts.filter((d) => d.thread !== on.thread).map((d) => d.thread))];
  return <Box key={on.thread} session={session} thread={on.thread} asked={on.asked} draft={draft} more={more} />;
});

function Box({ session, thread, asked, draft, more }: { session: string; thread: string; asked: number; draft: Reply | null; more: string[] }) {
  const of = draft ? keyOf(draft) : "";
  const [to, setTo] = useState<Where | null>(null);
  const [text, setText] = useState(() => {
    const kept = box.texts.get(thread);
    return draft ? (kept?.of === of ? kept.text : draft.text) : kept?.text ?? "";
  });
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const mail = (to?.source ?? draft?.source ?? (thread.startsWith("mail:") ? "mail" : "slack")) === "mail";
  const sending = busy || draft?.state === "sending";
  useEffect(() => {
    let live = true;
    void whereOf(thread).then((w) => live && setTo(w));
    return () => { live = false; };
  }, [thread]);
  // A newer draft of Claude's on this thread takes the box, what you wrote in it going, since you asked for it
  const was = useRef(of);
  useEffect(() => {
    if (draft && of !== was.current) {
      setText(draft.text);
      setRefused("");
      keep(thread, "", "");
    }
    was.current = of;
  }, [of]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const refuse = (why: string) => {
    setRefused(why);
    requestAnimationFrame(() => ref.current?.focus());
  };
  // Your reply goes at once; Claude's draft goes as you left it, by its own call, which a test desk keeps
  const send = async () => {
    if (!text.trim() || sending) return;
    setBusy(true);
    setRefused("");
    const res = draft
      ? await postJson(`/api/replies/${draft.id}/send`, { text })
      : await postJson(`/api/threads/${encodeURIComponent(thread)}/send`, { text, whom: to?.whom ?? "" });
    setBusy(false);
    if (!res.ok) return refuse(await reason(res));
    const { state, error } = (await res.json()) as { state: Reply["state"]; error?: string };
    if (state === "failed") return refuse(`${mail ? "Gmail" : "Slack"} refused it: ${error}`);
    keep(thread, "", "");
    close(); // it shows in the talk where you sent it
  };
  const discard = async () => {
    if (!draft) return;
    const res = await fetch(`/api/replies/${draft.id}`, { method: "DELETE" });
    if (!res.ok) return refuse(await reason(res));
    keep(thread, "", "");
    close();
  };
  const failed = refused || (draft?.state === "failed" ? `${mail ? "Gmail" : "Slack"} refused it: ${draft.error}` : "");
  const how = mail ? "Ctrl Enter sends it from Gmail as you, Enter makes a new line." : "Enter posts it to Slack as you, Shift Enter makes a new line.";
  return (
    <div className="reply-card your-reply">
      <div className="reply-head">
        <span className="reply-icon">{mail ? ENVELOPE : slackMark(12)}</span>
        <span className="reply-as">Reply as you</span>
        <span className="reply-whom">{to?.whom || draft?.whom || ""}</span>
        <span className="spacer" />
        {more.length > 0 && (
          <button className="reply-more" type="button" title="Claude’s draft for another thread: open it" onClick={() => replyTo(session, more[0])}>
            {more.length} more</button>
        )}
        {draft && <span className="reply-tag">Claude’s draft</span>}
        <button className="reply-close" type="button" title="Close, keeping what you wrote  Esc" onClick={close}>{X}</button>
      </div>
      <textarea ref={ref} className="reply-text" rows={1} value={text} spellCheck={false} disabled={sending}
        placeholder={to?.placeholder ?? "Reply, as you"}
        onChange={(e) => {
          setText(e.target.value);
          keep(thread, e.target.value, of);
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
        <span className={`reply-note${failed ? " failed" : ""}`}>{failed || (draft ? `Yours to edit. ${how}` : how)}</span>
        {draft && <button className="ghost" type="button" disabled={sending} onClick={() => void discard()}>Discard</button>}
        <button className="primary" type="button" title={mail ? "Send from Gmail  Ctrl Enter" : "Send to Slack  Enter"} disabled={!text.trim() || sending}
          onClick={() => void send()}>{sending ? "Sending…" : mail ? "Send from Gmail" : "Send to Slack"}</button>
      </div>
    </div>
  );
}
