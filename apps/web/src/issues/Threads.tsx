// The threads an issue's chat follows, in its details under the chat title's ⌄, each with a switch: off stops its new
// messages waking the chat, which keeps the thread, and on gives the chat those that waited, as one (the server's chats.ts,
// setSubscribed; "it's more like, toggle to unsubscribe", "it's likely would be in the session's title dropdown", the
// user, 5 Nov, on a thread that kept waking a chat whose job was done). Read each time the details open, and after each
// switch, so that its count of waiting messages holds.
import { useCallback, useEffect, useState } from "react";
import { slackMark } from "../ui/icons";
import { toast } from "../ui/toast";

interface FollowedThread {
  id: string;
  chat: string;
  source: "slack" | "mail";
  name: string;
  kind: string;
  on: boolean;
  waiting: number;
}

const ENVELOPE = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" /><path d="M2.25 4l5.75 4.5L13.75 4" /></svg>;

export function Threads({ slug }: { slug: string }) {
  const [list, setList] = useState<FollowedThread[]>([]);
  const read = useCallback(async () => {
    const res = await fetch(`/api/page/issue-threads?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (res.ok) setList(((await res.json()) as { threads: FollowedThread[] }).threads);
  }, [slug]);
  useEffect(() => { void read(); }, [read]);
  const change = async (t: FollowedThread, on: boolean) => {
    setList((now) => now.map((x) => (x.id === t.id ? { ...x, on, waiting: on ? 0 : x.waiting } : x)));
    const res = await fetch(`/api/chats/${encodeURIComponent(t.chat)}/threads/subscribed`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: t.id, on }) });
    if (!res.ok) toast(`Could not ${on ? "subscribe" : "unsubscribe"}: ${((await res.json()) as { detail?: string }).detail ?? res.status}`);
    await read();
  };
  if (!list.length) return null;
  return (
    <div className="details-threads">
      <div className="details-label">Threads</div>
      {list.map((t) => (
        <div className="details-thread" key={t.id}>
          <span className="details-thread-icon">{t.source === "mail" ? ENVELOPE : slackMark(12)}</span>
          <span className="details-thread-name" title={t.name}>{t.name}</span>
          {t.kind && <span className="details-thread-kind">{t.kind}</span>}
          {!t.on && <span className="details-thread-off">Unsubscribed{t.waiting > 0 && ` · ${t.waiting} ${t.waiting === 1 ? "message" : "messages"} waiting`}</span>}
          <label className="switch" title={t.on ? "Unsubscribe: its new messages wait and wake nothing" : "Subscribe: wakes this chat, with any that waited"}>
            <input type="checkbox" role="switch" aria-label={`Subscribed to ${t.name}`} checked={t.on} onChange={(e) => void change(t, e.target.checked)} />
          </label>
        </div>
      ))}
    </div>
  );
}
