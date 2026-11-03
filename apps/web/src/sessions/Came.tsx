// The card a chat opens on when desk started it from something that came in (the server's transcript.ts, Came): a
// Slack thread or DM, a mail thread, or a run of an automation with no agent. It says what "this" is in "check this out
// and fix it" wherever the chat opens, the Inbox's pane or the middle, where until 3 Nov only the Inbox showed the
// thread. It draws what Claude read, from the chat's first message: where it came from, the newest message with the
// earlier ones folded above it, and Open in Slack, Gmail or the automation ("A", the user, 3 Nov, on three mockups, over
// the whole thread and a quote on your first words; the desk issue "A chat from a Slack message, mail or event starts
// with its context, then we file the issue"). A followed thread's new messages, which woke the chat (the server's
// wakes.ts), are the same card where they came in its talk, "1 new message".
import { useLayoutEffect, useRef, useState } from "react";
import { go } from "../app/nav";
import type { Came } from "./live";
import { sent, whole } from "./time";

const HASH = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6.5 2.5l-1 11M10.5 2.5l-1 11M3 6h10.5M2.5 10H13" /></svg>;
const BUBBLE = <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg>;
const ENVELOPE = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;
const CLOCK = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3.25l2 1.25" /></svg>;
const OUT = <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;
const CARET = <svg className="steps-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z" /></svg>;

const initial = (who: string) => who.trim().slice(0, 1).toUpperCase() || "?";
const many = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// at: when the chat's first message was sent, in ms, the time a run came.
export function CameCard({ came, at }: { came: Came; at?: number }) {
  const [open, setOpen] = useState(false);
  const run = came.source === "automation";
  const earlier = run ? 0 : came.said.length - 1;
  const shown = run || open ? came.said : came.said.slice(-1);
  const icon = run ? CLOCK : came.source === "mail" ? ENVELOPE : came.name.startsWith("#") ? HASH : BUBBLE;
  const kind = run ? `Automation${at ? ` · ${sent(at)}` : ""}` : `${came.kind} · ${many(came.said.length, came.fresh ? "new message" : "message")}`;
  const where = run ? "automation" : came.source === "mail" ? "in Gmail" : "in Slack";
  const out = !came.link ? null : run ? () => go(`/automation/${came.link}`) : () => window.open(came.link, "_blank", "noopener");
  return (
    <div className="came">
      <div className="came-head">
        <span className="came-icon">{icon}</span>
        <span className="came-place">{came.name}</span>
        <span className="came-kind">{kind}</span>
        <span className="spacer" />
        {out && <button className="ghost came-out" type="button" onClick={out}>{OUT}Open {where}</button>}
      </div>
      {earlier > 0 && (
        <button className={`came-more${open ? " open" : ""}`} type="button" onClick={() => setOpen(!open)}>
          {CARET}{open ? `Fold ${earlier === 1 ? "the earlier message" : `the ${earlier} earlier messages`}` : `${many(earlier, "earlier message")}`}
        </button>
      )}
      {run ? shown.map((s, n) => (
        <div className="came-said" key={n}>
          {s.who && <span className="came-from">{s.who}:</span>}
          <Folded text={s.text} className="came-text" />
        </div>
      )) : (
        <div className="thread-msgs">
          {shown.map((s, n) => (
            <div className="thread-msg" key={n}>
              <span className="thread-avatar">{initial(s.who)}</span>
              <div className="thread-body">
                <div className="thread-meta">
                  <span className="thread-who">{s.who}</span>
                  <time className="thread-at" title={whole(s.at * 1000)}>{sent(s.at * 1000)}</time>
                </div>
                <Folded text={s.text} className="thread-text" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A message folded at four lines with Show more, as your own long messages fold in the chat.
function Folded({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!all) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, all]);
  return (
    <>
      <div ref={ref} className={`${className}${all ? "" : " came-fold"}`}>{text}</div>
      {long && <button className="you-more came-show" type="button" onClick={() => setAll(!all)}>{all ? "Show less" : "Show more"}</button>}
    </>
  );
}
