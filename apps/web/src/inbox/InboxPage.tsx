// Linear's Inbox (templates/inbox.html): the notifications on the left, newest first; the one picked (?i=<slug>) opens
// on the right, as the issue's page shows it. Each row is the issue's session telling you something: its status where
// Linear draws who acted, since every row's session would look the same (19 Oct: "there is nobody"), a dot until you
// open it, the issue's title, then what the session did and how long ago. A row may instead be one of the
// user's agents or a bare chat writing (?i=<chat id>), whose chat opens on the right, as Triage shows one. The top bar splits at the
// list's edge: "Inbox" over the list, the open notification's title over it.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { IssueView, type IssuePageData } from "../issues/IssueView";
import { actionsMenu } from "../issues/menus";
import { painted } from "../issues/painted";
import { useLive } from "../issues/useLive";
import { SessionView } from "../sessions/Dock";
import { STATE_NAMES, type IssueRow } from "../lib/desk";
import { frame, lineKey } from "../store/frame";
import { issues } from "../store/issues";
import { ui } from "../store/ui";
import { StateIcon } from "../ui/icons";
import { toggled } from "../ui/menu";

interface InboxItem extends IssueRow {
  why: string;
  says: string;
  kind: "review" | "needs";
  seen: string; // "<slug>:<why>:<time>": a new event on the issue is a new key, so it shows unread again
  ago: string;
  at: string;
  chat?: { session: string; agent: string | null }; // a row from a chat with one of the user's agents, or a bare one
}

interface InboxData {
  items: InboxItem[];
  open: IssuePageData | null;
  chat: { slug: string; session: string; agent: string | null; title: string } | null; // the agent's or bare chat picked
}

// The rows you have opened (localStorage.inboxSeen, shared with the old pages): a read row loses its dot, as in
// Linear's Inbox; the one open now counts as read; keys no longer in the Inbox are let go.
function useSeen(items: InboxItem[] | undefined, open: string | null) {
  const [seen, setSeen] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.inboxSeen ?? "[]")));
  useEffect(() => {
    if (!items) return;
    const now = new Set(items.map((n) => n.seen));
    const kept = new Set<string>(JSON.parse(localStorage.inboxSeen ?? "[]").filter((key: string) => now.has(key)));
    const opened = items.find((n) => n.slug === open);
    if (opened) kept.add(opened.seen);
    localStorage.inboxSeen = JSON.stringify([...kept]);
    setSeen(kept);
  }, [items, open]);
  return seen;
}

function NotifyAsk() {
  const [asked, setAsked] = useState(window.Notification?.permission !== "default");
  if (asked) return null;
  return (
    <div className="notify-ask">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1.25 1.5H2.75L4 11Z" /><path d="M6.5 14.25h3" /></svg>
      <span>Desktop notifications are off</span>
      <button type="button" className="small" onClick={async () => { await Notification.requestPermission(); setAsked(Notification.permission !== "default"); }}>Turn on</button>
    </div>
  );
}

export const InboxPage = observer(function InboxPage() {
  const [params] = useSearchParams();
  const i = params.get("i") ?? "";
  // The open issue's files and Try button, as on its page.
  const { data, reload } = usePage<InboxData>(`/api/page/inbox${i ? `?i=${encodeURIComponent(i)}` : ""}`, `${issues.files.get(i) ?? 0} ${lineKey()}`);
  const open = data?.open && data.open.issue.slug === i ? data.open : data?.open ?? null;
  const chat = data?.chat?.slug === i ? data.chat : null;
  const seen = useSeen(data?.items, open?.issue.slug ?? chat?.slug ?? null);
  // A session that replies, waits for you or writes its plan changes no issue, so the sync socket's changes say
  // nothing; the frame desk sends then (store/frame.ts) has the Inbox's rows, and the page asks again when they changed.
  const rows = frame.data?.rows.map((n) => `${n.slug}:${n.why}`).join(" ");
  const shownRows = useRef(rows);
  useEffect(() => {
    if (rows === shownRows.current) return;
    shownRows.current = rows;
    reload();
  }, [rows, reload]);
  useLive(open, reload);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => { document.title = "Inbox · desk"; }, []);
  // The open issue's pane starts at its top for each notification, and keeps its place while the same one redraws.
  useLayoutEffect(() => { pane.current?.scrollTo(0, 0); }, [open?.issue.slug]);
  const p = open && painted(open.issue);
  return (
    <>
      <Bar
        crumb={<><Go className="inbox-head" to="/inbox">Inbox</Go>{(p || chat) && <><span className="sep">›</span><span className="inbox-crumb">{p ? p.title : chat!.agent ? `${chat!.agent}: ${chat!.title}` : chat!.title}</span></>}</>}
        tools={p && (
          <button className="more" title="Actions" onClick={(e) => { if (!toggled(e.currentTarget)) actionsMenu(p, { anchor: e.currentTarget }, p.slug); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
          </button>
        )}
      />
      <div className="scroll">
        {data && (
          <div className="inbox">
            <div className="inbox-list" data-keep-scroll="always">
              <NotifyAsk />
              {data.items.map((n) => n.chat ? <ChatRow key={n.slug} n={n} open={chat?.slug === n.slug} read={seen.has(n.seen)} /> : (
                <Go key={n.slug} className={`item inbox-row${n.slug === open?.issue.slug ? " selected" : ""}${seen.has(n.seen) ? " read" : ""}${ui.focused === n.slug ? " focus" : ""}`}
                  to={`/inbox?i=${n.slug}`} title={n.title} data-slug={n.slug} data-state={n.state} data-priority={n.priority} data-parent={n.parent ?? ""} data-seen={n.seen}
                  onMouseMove={() => { if (ui.focused !== n.slug) ui.focus(n.slug, true); }}
                  onContextMenu={(e) => { e.preventDefault(); ui.focus(n.slug); actionsMenu(n, { x: e.clientX, y: e.clientY }, open?.issue.slug ?? null); }}>
                  <span className="avatar status" aria-label={STATE_NAMES[n.state]}><StateIcon state={n.state} />
                    <span className="badge">
                      {n.kind === "review"
                        ? <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
                        : <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg>}
                    </span>
                  </span>
                  <span className="lines">
                    <span className="line"><span className="dot" aria-label="Unread" /><span className="title">{n.title}</span></span>
                    <span className="line sub"><span className="says">{`Session ${n.says}`}</span><span className="age" title={n.at}>{n.ago}</span></span>
                  </span>
                </Go>
              ))}
            </div>
            <div className={`inbox-open${chat ? " triage-open" : ""}`} data-keep-scroll="same" ref={pane}>
              {chat ? <SessionView key={chat.session} id={chat.session} /> : open ? <IssueView data={open} inInbox /> : (
                <div className="inbox-empty">
                  {/* Linear's empty Inbox drawing, its strokes in desk's own text colours */}
                  <svg width="98" height="100" viewBox="0 0 78 80" fill="none" aria-hidden="true">
                    <path style={{ stroke: "var(--text-3)" }} strokeWidth="1.5" d="M10.4 9.11A10 10 0 0 1 20.22 1h37.56a10 10 0 0 1 9.82 8.11l8.11 42.2a10 10 0 0 1-9.82 11.9H54.7a6.36 6.36 0 0 0-5.65 3.45 6.36 6.36 0 0 1-5.66 3.45H34.6a6.36 6.36 0 0 1-5.66-3.45 6.36 6.36 0 0 0-5.65-3.46H12.1a10 10 0 0 1-9.8-11.89l8.11-42.2Z" />
                    <path style={{ stroke: "var(--text-2)" }} strokeWidth="1.5" d="M14.3 9.03a5 5 0 0 1 4.91-4.08H58.8a5 5 0 0 1 4.91 4.08l8.07 43.22a6 6 0 0 1-5.9 7.1H52.76a5.72 5.72 0 0 0-5.24 3.41 5.72 5.72 0 0 1-5.23 3.42h-6.58a5.72 5.72 0 0 1-5.23-3.42 5.72 5.72 0 0 0-5.24-3.4h-13.1a6 6 0 0 1-5.9-7.1L14.3 9.02Z" />
                    <path style={{ stroke: "var(--text-3)" }} strokeWidth="1.5" d="m2.36 55.6 3.2 14.06A12 12 0 0 0 17.26 79h43.48a12 12 0 0 0 11.7-9.34l3.2-14.06" />
                  </svg>
                  <span>{data.items.length ? "No notification selected" : "No notifications"}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
});

// An agent's or a bare chat's row: what it said, unread until you open it, which opens its chat on the right. It is no
// issue, so it has no status, and the issue keys pass it by. An agent shows its initial, a bare chat a speech bubble.
const ChatRow = observer(function ChatRow({ n, open, read }: { n: InboxItem; open: boolean; read: boolean }) {
  const agent = n.chat!.agent;
  return (
    <Go className={`item inbox-row${open ? " selected" : ""}${read ? " read" : ""}${ui.focused === n.slug ? " focus" : ""}`}
      to={`/inbox?i=${n.slug}`} title={n.title} data-key={n.slug} data-session={n.chat!.session} data-seen={n.seen}
      onMouseMove={() => { if (ui.focused !== n.slug) ui.focus(n.slug, true); }}>
      {agent
        ? <span className="avatar agent" aria-label={agent}>{agent.slice(0, 1).toUpperCase()}</span>
        : <span className="avatar" aria-label="Chat"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.1-1.8-.2L3 14.1c-.4.2-.8-.2-.7-.6l.6-2.4C2 10.1 1.5 8.8 1.5 7.4 1.5 4.4 4.4 2 8 2z" /></svg></span>}
      <span className="lines">
        <span className="line"><span className="dot" aria-label="Unread" /><span className="title">{n.title}</span></span>
        <span className="line sub"><span className="says">{`${agent ?? "Chat"} ${n.says}`}</span><span className="age" title={n.at}>{n.ago}</span></span>
      </span>
    </Go>
  );
});
