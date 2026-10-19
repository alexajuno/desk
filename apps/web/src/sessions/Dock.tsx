// A session's chat, in the middle of the screen, drawn as claude.ai draws a chat: replies stream in as Markdown, tool
// steps fold under one line, questions come as buttons, and the composer queues a message while Claude works (Enter)
// or stops it (Ctrl C); Esc leaves it for desk's keys and I comes back, as vim's modes. Its issue sits beside it on
// the right, in the frame's panel (store/dock.ts says where each stands).
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { postJson, reason } from "../api/http";
import { go } from "../app/nav";
import { markdown } from "../lib/markdown";
import { seenPage } from "../api/page";
import { Title, type IssuePageData } from "../issues/IssueView";
import { folderMenu } from "../issues/menus";
import { dock, SIDE_WIDTH, type Layout, type Reading } from "../store/dock";
import { issues } from "../store/issues";
import { toggleSide as toggleSidebar } from "../frame/side";
import { GLYPH, SIDE_ICON } from "../ui/icons";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { live, renameChat, useLive, type Ask, type Block, type Image, type Item, type LiveSession, type Status, type Task } from "./live";
import { effortName, runsMenu, warm } from "./models";

// The chat whose composer takes the cursor: the one openSession opened. Its composer takes it as it comes on screen,
// which a view transition can make a frame or more after the address changes, or at once when it is there already.
const wantsFocus = observable.box<string | null>(null);

// Open a session's chat in the middle: its issue's page when it has one, which shows the chat with the issue beside it.
export function openSession(id: string, slug?: string | null) {
  slug ??= [...issues.bySlug.values()].find((i) => i.session === id)?.slug;
  go(slug ? `/issue/${slug}` : `/sessions/${id}`);
  runInAction(() => wantsFocus.set(id));
}

// I, as vim's insert: the cursor back into the composer of the chat in the middle, or of the one Triage shows. False
// when no chat is there.
export function focusComposer() {
  const box = document.querySelector<HTMLTextAreaElement>(".dock .composer textarea, .triage-open .composer textarea");
  box?.focus();
  return Boolean(box);
}

// New session: an agent chat, in the middle. Its issue comes beside it once the agent files one (SessionFullRoute).
// A draft, such as New automation's, waits typed in its composer.
export async function newSession(draft = "") {
  const res = await postJson("/sessions/new");
  if (!res.ok) return toast(await reason(res));
  const { id } = await res.json();
  if (draft && !drafts()[id]) keepDraft(id, draft);
  openSession(id);
}

// A change of layout moves as one piece, through the browser's view transitions: the issue page shrinks into the side
// as its chat rises in the middle, and slides out when hidden (dock.css says how). Where the browser has none, or
// motion is turned down, it changes at once.
const still = matchMedia("(prefers-reduced-motion: reduce)");
let moving: Promise<void> | null = null; // the move on screen, which the issue's own slide in waits for
function move(next: Layout, change: () => void) {
  if (next === dock.layout || !document.startViewTransition || still.matches) return change();
  const t = document.startViewTransition(() => flushSync(change));
  const done = moving = t.finished.catch(() => {}).then(() => { if (moving === done) moving = null; });
}

// What an issue's page has to read beside its chat: its plan while it waits for go (in review on it, or the session
// idle, no result yet), or its card from review on. A mark of both tells when the agent wrote either anew.
const CARDED = ["review", "landing", "waiting", "done"];
export function readingOf(data: IssuePageData): Reading {
  const { plan, result } = data, state = data.issue.state;
  const want = data.issue.review_of === "plan" ? Boolean(plan)
    : result ? CARDED.includes(state) : ["running", "review"].includes(state) && Boolean(plan) && data.live !== "working";
  return { want, has: Boolean(plan || result), mark: `${hash(plan)}.${hash(result)}` };
}

function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// What the page on screen asks for (the frame calls it as the address changes): an issue page's chat comes with its
// issue beside it when the page, as its route's loader just fetched it, has something to read.
export function arrange(session: string | null, slug: string | null) {
  const page = slug ? seenPage<IssuePageData>(`/api/page/issue/${slug}`) : null;
  const reading = page && page.issue.session === session ? readingOf(page) : null;
  move(dock.layoutAfter(session, Boolean(slug), reading), () => dock.arrange(session, Boolean(slug), reading));
}

// The issue's page came in, or in again: a plan or card the agent just wrote slides in beside its chat, once the
// chat's own move is over.
export async function offerIssue(session: string, reading: Reading) {
  while (moving) await moving;
  move(dock.layoutOffered(session, reading), () => dock.offer(session, reading));
}

// ] or the issue's title in the chat's head: the issue beside its chat, or the chat alone.
export function toggleIssue() {
  if (!dock.center || !dock.issue) return;
  move(dock.layout === "both" ? "chat" : "both", () => dock.toggleSide());
}

export const Dock = observer(function Dock() {
  const id = dock.center ? dock.session : null;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("chat-center", Boolean(id));
    root.classList.toggle("side-off", Boolean(id) && !dock.sideShown);
    root.style.setProperty("--side-w", `${dock.width}px`);
  }, [id, dock.sideShown, dock.width]);
  return (
    <aside className="dock" aria-hidden={!id}>
      {id ? <SessionView key={id} id={id} /> : null}
    </aside>
  );
});

// The left edge of the issue beside its chat: drag it to make the issue wider or narrower, as Linear's panels are; a
// double-click gives back the width it opens at.
export const SideEdge = observer(function SideEdge() {
  if (!dock.sideShown || dock.narrow) return null;
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const edge = e.currentTarget, root = document.documentElement, from = e.clientX, width = dock.width;
    const left = document.querySelector(".dock")!.getBoundingClientRect().left;
    const resize = (m: PointerEvent) => dock.setWidth(width + from - m.clientX, left);
    edge.setPointerCapture(e.pointerId);
    root.classList.add("side-resizing");
    edge.addEventListener("pointermove", resize);
    edge.addEventListener("lostpointercapture", () => {
      edge.removeEventListener("pointermove", resize);
      root.classList.remove("side-resizing");
    }, { once: true });
  };
  return <div className="side-edge" title="Drag to resize" onPointerDown={drag} onDoubleClick={() => dock.setWidth(SIDE_WIDTH, 0)} />;
});

// The pill the chat you left waits as, at the bottom right: its title and whether it works. A click takes you back to it.
export const DockPill = observer(function DockPill() {
  const shown = dock.pill && !dock.center ? dock.session : null;
  const s = useLive(shown, false);
  if (!s) return null;
  return (
    <span className="dock-pill">
      <button type="button" title="Back to the chat" onClick={() => openSession(s.id, s.meta?.issue?.slug)}>
        <Dot s={s} />
        <span>{s.meta?.title ?? "Session"}</span>
      </button>
      <button className="dock-pill-x" type="button" title="Dismiss" onClick={() => dock.dismiss()}>{GLYPH.close}</button>
    </span>
  );
});

const Dot = observer(function Dot({ s }: { s: LiveSession }) {
  const state = s.asks.length ? "asks" : s.working ? "working" : s.connected ? "idle" : "off";
  return <span className={`live-dot ${state}`} title={{ asks: "Waiting for you", working: "Working", idle: "Idle", off: "Connecting…" }[state]} />;
});

// A chat as the middle shows it; the Triage page draws one in its right pane too.
export const SessionView = observer(function SessionView({ id }: { id: string }) {
  const s = useLive(id)!;
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true); // following the bottom, as new words come
  const m = s.meta;

  const onScroll = () => {
    const el = scroller.current!;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const streamed = s.partial.reduce((n, b) => n + b.text.length, 0);
  useLayoutEffect(() => {
    if (stuck.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [s.items.length, streamed, s.pending.length, s.asks.length, s.working, s.loaded]);
  // A reply that streams grows the conversation, and a composer that grows or a question card that comes grows the
  // foot over its end: either way the view keeps to the bottom while it was there. The view itself changes size only
  // with the window.
  useEffect(() => {
    const el = scroller.current!;
    const keep = new ResizeObserver(() => { if (stuck.current) el.scrollTo({ top: el.scrollHeight }); });
    keep.observe(el);
    keep.observe(el.firstElementChild!); // the conversation itself, as words stream and steps unfold
    keep.observe(el.lastElementChild!); // the foot: the composer and any question card
    return () => keep.disconnect();
  }, []);

  // The composer lies over the conversation's end, as claude.ai's does: the foot sticks to the bottom of the view, and
  // the conversation runs on behind it (dock.css).
  return (
    <div className="session-view">
      <ChatHead s={s} />
      <div className="dock-scroll" ref={scroller} onScroll={onScroll}>
        <div className="convo">
          {!s.loaded ? <p className="convo-empty">Connecting…</p>
            : !s.items.length && !s.pending.length && !s.working ? <p className="convo-empty">{m?.agent ? `Talk to ${m.agent}.`
              : m?.bare || (m?.chat && s.startAs === "chat") ? `Just Claude, as claude runs in a terminal ${startsIn(s) === "~" ? "from your home folder" : `in ${startsIn(s)}`}: no issue and no desk instructions.`
              : m?.chat ? "Ask desk's agent anything: it files the work and does it here. Start with @ and a name to talk to one of your agents."
              : "Nothing said yet."}</p>
            : null}
          <Conversation s={s} />
        </div>
        <div className="dock-foot">
          <Running s={s} />
          {s.asks.map((a) => <AskCard key={a.id} s={s} ask={a} />)}
          <Composer s={s} />
        </div>
      </div>
    </div>
  );
});

// The chat's head: the sidebar's toggle while it is hidden, as a page's top bar has, whether it works, its issue's
// title, and its folder. The title shows or hides the issue beside it; a chat with no issue is renamed there.
const ChatHead = observer(function ChatHead({ s }: { s: LiveSession }) {
  const m = s.meta;
  return (
    <header className="dock-head">
      <button className="side-icon side-toggle" type="button" title="Show sidebar  [" onClick={toggleSidebar}>{SIDE_ICON}</button>
      <Dot s={s} />
      <div className="dock-title">
        {dock.issue && m?.issue
          ? <button type="button" className={`dock-issue${dock.sideShown ? " on" : ""}`} title={`${dock.sideShown ? "Hide" : "Show"} the issue  ]`} onClick={toggleIssue}>{m.issue.title}</button>
          : m?.chat && !m.issue ? <Title line title={m.title} save={(t) => renameChat(s.id, t)} />
          : <span>{m?.issue?.title ?? m?.title ?? ""}</span>}
        {startsIn(s) && <span className="dock-folder" title={startsIn(s)}>{startsIn(s)}</span>}
      </div>
    </header>
  );
});

// --- the conversation ------------------------------------------------------------------------------------------------

type Row =
  | { kind: "you"; item: Item }
  | { kind: "text"; item: Item }
  | { kind: "note"; item: Item }
  | { kind: "steps"; key: string; items: Item[] };

// The items in the order drawn, the tool steps and thoughts between two replies folded into one row.
function rowsOf(items: Item[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.t === "tool" || item.t === "thinking") {
      const last = rows[rows.length - 1];
      if (last?.kind === "steps") last.items.push(item);
      else rows.push({ kind: "steps", key: item.key, items: [item] });
    } else if (item.t === "you" || item.t === "text" || item.t === "note") rows.push({ kind: item.t, item } as Row);
  }
  return rows;
}

const Conversation = observer(function Conversation({ s }: { s: LiveSession }) {
  const rows = useMemo(() => rowsOf(s.items), [s.items]);
  // A reply streaming now: its words show as they come, its tool calls join the last fold.
  const liveSteps = s.partial.filter((b) => b.kind === "tool_use" || b.kind === "thinking");
  const liveText = s.partial.filter((b) => b.kind === "text");
  const last = rows[rows.length - 1];
  return (
    <>
      {rows.map((r, n) => {
        // One typed mid-turn is in the transcript once Claude takes it in, at its next step: by then it's sent, not queued.
        if (r.kind === "you") return <You key={r.item.key} text={r.item.text ?? ""} images={r.item.images} />;
        if (r.kind === "text") return <Reply key={r.item.key} text={r.item.text ?? ""} />;
        if (r.kind === "note") {
          const agent = r.item.id ? s.items.find((i) => i.t === "tool" && i.id === r.item.id && (i.name === "Agent" || i.name === "Task")) : undefined;
          return agent ? <AgentNote key={r.item.key} s={s} note={r.item} /> : <p key={r.item.key} className="convo-note">{r.item.text}</p>;
        }
        const running = n === rows.length - 1 && s.working ? liveSteps : [];
        return <Steps key={r.key} s={s} items={r.items} running={running} live={n === rows.length - 1 && s.working} />;
      })}
      {liveSteps.length > 0 && last?.kind !== "steps" && <Steps s={s} items={[]} running={liveSteps} live />}
      {liveText.map((b) => <Reply key={`${b.msg}:${b.index}`} text={b.text} streaming />)}
      {s.pending.map((p) => (
        <You key={p.key} text={p.text} images={p.images.length} queued={s.working && !p.lost} lost={p.lost} onSend={() => void s.resend(p)} />
      ))}
      {s.working && !liveText.length && !s.asks.length && <Working since={s.since} status={s.status} />}
    </>
  );
});

const LONG = 600; // characters past which a message shows its first lines only, as claude.ai shows a long paste

function You({ text, images, queued, lost, onSend }: { text: string; images?: number; queued?: boolean; lost?: boolean; onSend?: () => void }) {
  const [all, setAll] = useState(false);
  const long = text.length > LONG && !all;
  return (
    <div className={`you${queued || lost ? " queued" : ""}`}>
      <div className={`you-bubble${long ? " folded" : ""}`}>
        {images ? <span className="you-images">{images === 1 ? "1 image" : `${images} images`}</span> : null}
        {text}
      </div>
      {long && <button className="you-more" type="button" onClick={() => setAll(true)}>Show all</button>}
      {queued && <span className="you-queued">{GLYPH.clock}Queued</span>}
      {lost && (
        <span className="you-queued">
          {GLYPH.none}Not sent
          <button className="you-more" type="button" title="Send it again" onClick={onSend}>Send</button>
        </span>
      )}
    </div>
  );
}

const Reply = function Reply({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => markdown(text), [text]);
  return <div className={`reply body${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
};

// Draws again each second while on, for a time that runs.
function useTick(on = true) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

// How long since a moment: 12s, 3m 4s, 1h 5m.
function elapsed(from: number): string {
  const secs = Math.max(0, Math.round((Date.now() - from) / 1000));
  return secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor(secs / 60) % 60}m`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// What holds the turn up, in the working line's words.
function held(status: Status): string {
  if (status.kind === "compacting") return "Compacting the conversation";
  if (status.kind === "limit") return `Usage limit reached${status.resets ? ` · resets ${clock(status.resets * 1000)}` : ""}`; // resetsAt is in seconds
  const wait = Math.ceil((status.until - Date.now()) / 1000);
  return `${wait > 0 ? `Retrying in ${wait}s` : "Retrying"} · ${status.error.replace(/_/g, " ")} · attempt ${status.attempt} of ${status.of}`;
}

function Working({ since, status }: { since: number; status: Status | null }) {
  useTick();
  return (
    <p className="working">
      <span className="spark" aria-hidden="true" />
      {status ? held(status) : `Working${Date.now() - since >= 1000 ? ` · ${elapsed(since)}` : ""}`}
      <span className="working-key">Esc to stop</span>
    </p>
  );
}

// What a fold of tool steps did, in a few words: "Read 3 files, ran 2 commands".
function summed(items: (Item | Block)[]): string {
  const count = new Map<string, number>();
  for (const i of items) {
    const name = "t" in i ? (i.t === "thinking" ? "Thinking" : i.name ?? "") : i.kind === "thinking" ? "Thinking" : i.name ?? "";
    const word = name === "Read" ? "read" : name === "Edit" || name === "Write" || name === "NotebookEdit" ? "edit"
      : name === "Bash" ? "ran" : name === "Grep" || name === "Glob" ? "search" : name === "WebSearch" || name === "WebFetch" ? "web"
      : name === "Agent" || name === "Task" ? "agent" : name === "Thinking" ? "think" : name === "Skill" ? "skill"
      : name === "AskUserQuestion" ? "ask" : "tool";
    count.set(word, (count.get(word) ?? 0) + 1);
  }
  const n = (k: string, one: string, many: string) => (count.get(k) ? [count.get(k) === 1 ? one : many.replace("#", String(count.get(k)))] : []);
  const parts = [
    ...n("think", "thought", "thought"), ...n("read", "read a file", "read # files"), ...n("search", "searched", "searched # times"),
    ...n("edit", "edited a file", "edited # files"), ...n("ran", "ran a command", "ran # commands"), ...n("web", "looked on the web", "looked on the web # times"),
    ...n("agent", "ran an agent", "ran # agents"), ...n("skill", "used a skill", "used # skills"), ...n("ask", "asked you", "asked you # times"),
    ...n("tool", "used a tool", "used # tools"),
  ];
  const text = parts.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

const Steps = observer(function Steps({ s, items, running, live: isLive }: { s: LiveSession; items: Item[]; running: Block[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = items.some((i) => i.t === "tool" && s.results.get(i.id!)?.error);
  const now = running[running.length - 1];
  const lastTool = [...items].reverse().find((i) => i.t === "tool");
  const pendingTool = isLive && lastTool && !s.results.has(lastTool.id!) ? lastTool : null;
  return (
    <div className={`steps${open ? " open" : ""}${isLive ? " live" : ""}`}>
      <button className="steps-head" type="button" onClick={() => setOpen(!open)}>
        <svg className="steps-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z" /></svg>
        <span>{summed([...items, ...running]) || "Working"}</span>
        {failed && <span className="steps-failed">a step failed</span>}
      </button>
      {!open && isLive && (now || pendingTool) && (
        <p className="steps-now">{now ? (now.kind === "thinking" ? "Thinking…" : `${now.name ?? "Tool"}…`) : `${pendingTool!.name} ${pendingTool!.summary ?? ""}`}</p>
      )}
      {open && (
        <div className="steps-list">
          {items.map((i) => (i.t === "thinking" ? <Thought key={i.key} text={i.text ?? ""} /> : <Step key={i.key} s={s} item={i} result={s.results.get(i.id!)} />))}
          {running.map((b) => <p key={`${b.msg}:${b.index}`} className="step running"><span className="step-name">{b.kind === "thinking" ? "Thinking" : b.name}</span><span className="step-what">…</span></p>)}
        </div>
      )}
    </div>
  );
});

function Thought({ text }: { text: string }) {
  return <div className="step thought"><span className="step-name">Thought</span><div className="thought-text">{text}</div></div>;
}

function Step({ s, item, result }: { s: LiveSession; item: Item; result?: Item }) {
  const [open, setOpen] = useState(false);
  const agent = item.name === "Agent" || item.name === "Task";
  return (
    <div className={`step${result?.error ? " error" : ""}${result ? "" : " running"}`}>
      <button className="step-line" type="button" onClick={() => setOpen(!open)}>
        <span className="step-name">{item.name}</span>
        <span className="step-what">{item.summary}</span>
      </button>
      {open && (
        <div className="step-detail">
          <pre>{item.input}</pre>
          {agent ? <AgentSteps s={s} tool={item.id!} result={result} /> : result && <pre className="step-result">{result.text || "(no output)"}</pre>}
        </div>
      )}
    </div>
  );
}

// A subagent's own steps, under its Agent step, ending with its reply: read from its transcript when the step opens,
// and again at each step it takes while it runs. Its tool result stands in only when no steps were kept; a subagent in
// the background has none worth showing, only Claude Code's note to Claude that it started.
const AgentSteps = observer(function AgentSteps({ s, tool, result }: { s: LiveSession; tool: string; result?: Item }) {
  const task = s.tasks.find((t) => t.tool === tool);
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/live/${s.id}/agent/${tool}`).then((r) => (r.ok ? r.json() : [])).then((list: Item[]) => { if (!gone) setItems(list); });
    return () => { gone = true; };
  }, [s.id, tool, task?.steps, Boolean(task)]);
  if (!items) return null;
  const results = new Map(items.filter((i) => i.t === "result").map((i) => [i.id!, i]));
  const shown = items.filter((i) => i.t === "tool" || i.t === "thinking" || i.t === "text");
  if (!shown.length) {
    if (result && !result.text?.startsWith("Async agent launched")) return <pre className="step-result">{result.text || "(no output)"}</pre>;
    return <p className="agent-none">{task ? "Starting…" : "No steps recorded."}</p>;
  }
  return (
    <div className="steps-list">
      {shown.map((i) => (i.t === "tool" ? <Step key={i.key} s={s} item={i} result={results.get(i.id!)} />
        : i.t === "thinking" ? <Thought key={i.key} text={i.text ?? ""} /> : <AgentText key={i.key} text={i.text ?? ""} />))}
    </div>
  );
});

// What a subagent says, its report above all, in Markdown as Claude's replies are, a size down.
function AgentText({ text }: { text: string }) {
  const html = useMemo(() => markdown(text), [text]);
  return <div className="reply body agent-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

// A subagent's "finished" notice, as a fold: opened, it shows what the agent did and its report, at the source, rather
// than only as Claude retells it.
function AgentNote({ s, note }: { s: LiveSession; note: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`steps agent-note${open ? " open" : ""}`}>
      <button className="steps-head" type="button" onClick={() => setOpen(!open)}>
        <svg className="steps-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z" /></svg>
        <span>{note.text}</span>
      </button>
      {open && <AgentSteps s={s} tool={note.id!} />}
    </div>
  );
}

// --- what runs beside the conversation ---------------------------------------------------------------------------------

// Each subagent, background command and watch running now, above the composer, with its latest step and how long it
// has run. Only to look at: "i won't try to micromanage each shell or subagents" (the user, 19 Oct).
const Running = observer(function Running({ s }: { s: LiveSession }) {
  useTick(s.tasks.length > 0);
  if (!s.tasks.length) return null;
  return (
    <div className="running" aria-label="Running now">
      {s.tasks.map((t) => (
        <div key={t.id} className="running-row">
          <span className="running-dot" aria-hidden="true" />
          <span className="running-name">{taskName(s, t)}</span>
          <span className="running-what">{t.description}</span>
          {t.doing && <span className="running-doing">{t.doing}</span>}
          <span className="running-time">{t.steps ? `${t.steps} ${t.steps === 1 ? "step" : "steps"} · ` : ""}{elapsed(t.since)}</span>
        </div>
      ))}
    </div>
  );
});

// A task by what it is: a subagent by its type, a watch by the Monitor call that started it, which Claude Code runs as a
// background command too (tried 19 Oct).
function taskName(s: LiveSession, t: Task): string {
  if (t.kind === "local_agent") return t.agent && t.agent !== "general-purpose" ? t.agent : "Agent";
  if (s.items.some((i) => i.id === t.tool && i.name === "Monitor")) return "Watch";
  return t.kind === "local_bash" ? "Shell" : t.kind.includes("workflow") ? "Workflow" : "Task";
}

// --- what waits on the user: a permission, or Claude's questions --------------------------------------------------------

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

const AskCard = observer(function AskCard({ s, ask }: { s: LiveSession; ask: Ask }) {
  if (ask.tool === "AskUserQuestion") return <Questions s={s} ask={ask} />;
  const input = JSON.stringify(ask.input, null, 1);
  return (
    <div className="ask">
      <p className="ask-what">Claude wants to use <strong>{ask.tool}</strong></p>
      <pre className="ask-input">{input.length > 1200 ? `${input.slice(0, 1200)}…` : input}</pre>
      <div className="ask-buttons">
        <button className="ghost" type="button" onClick={() => s.answer(ask.id, { behavior: "deny", message: "The user said no in desk's panel." })}>Deny</button>
        <button className="primary" type="button" onClick={() => s.answer(ask.id, { behavior: "allow", updatedInput: ask.input })}>Allow</button>
      </div>
    </div>
  );
});

const Questions = observer(function Questions({ s, ask }: { s: LiveSession; ask: Ask }) {
  const questions = (ask.input.questions as Question[] | undefined) ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answers = () => Object.fromEntries(questions.map((q) => [q.question, [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(", ")]));
  const submit = (a = answers()) => s.answer(ask.id, { behavior: "allow", updatedInput: { ...ask.input, answers: a } });
  const done = questions.every((q) => (picked[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  const pick = (q: Question, label: string) => {
    const now = picked[q.question] ?? [];
    const next = q.multiSelect ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : [label];
    setPicked({ ...picked, [q.question]: next });
    // One question with one answer: picking it is the answer, as in Claude Code's terminal.
    if (questions.length === 1 && !q.multiSelect) submit({ [q.question]: label });
  };
  return (
    <div className="ask">
      {questions.map((q) => (
        <div key={q.question} className="ask-q">
          {q.header && <span className="ask-header">{q.header}</span>}
          <p className="ask-what">{q.question}</p>
          <div className="ask-options">
            {q.options.map((o) => (
              <button key={o.label} type="button" className={`ask-option${picked[q.question]?.includes(o.label) ? " on" : ""}`} onClick={() => pick(q, o.label)}>
                <span className="ask-label">{o.label}</span>
                {o.description && <span className="ask-desc">{o.description}</span>}
              </button>
            ))}
            <input className="ask-other" placeholder="Something else…" value={other[q.question] ?? ""}
              onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && done) submit(); }} />
          </div>
        </div>
      ))}
      {(questions.length > 1 || questions.some((q) => q.multiSelect) || Object.values(other).some((v) => v.trim())) && (
        <div className="ask-buttons"><button className="primary" type="button" disabled={!done} onClick={() => submit()}>Answer</button></div>
      )}
    </div>
  );
});

// --- the composer ----------------------------------------------------------------------------------------------------

interface Pick { label: string; hint?: string; insert: string }

// The user's agents (GET /api/agents), asked once a page: @ at the start of a new desk chat offers them.
let agentList: Promise<Pick[]> | null = null;
const agentPicks = () => (agentList ??= fetch("/api/agents").then((r) => r.json())
  .then((list: { name: string; description: string }[]) => list.map((a) => ({ label: `@${a.name}`, hint: a.description, insert: `@${a.name} ` })))
  .catch(() => (agentList = null, [])));

// A word being typed that the composer completes: a / at the start, or after a space once a letter follows it, as
// Claude Code's terminal does; or an @ after a space.
function tokenAt(text: string, caret: number): { kind: "/" | "@"; start: number; word: string } | null {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:.-]*)$/.exec(before) ?? /\s\/([\w:.-]+)$/.exec(before);
  if (slash) return { kind: "/", start: before.length - slash[1].length - 1, word: slash[1] };
  const at = /(^|\s)@([^\s]*)$/.exec(before);
  if (at) return { kind: "@", start: before.length - at[2].length - 1, word: at[2] };
  return null;
}

// A skill or command named in what is typed, as / and its name at the start or after a space, as claude.ai's composer
// shows one in blue. The textarea can't colour a word, so its text turns clear and the layer under it draws the text
// again, with each known name marked; null when nothing is known, and the textarea draws its own text.
const SLASHED = /(^|\s)\/([\w:-]+(?:\.[\w:-]+)*)(?![\w/])/g;

function marked(text: string, known: Set<string> | null) {
  if (!known) return null;
  const out: React.ReactNode[] = [];
  let from = 0;
  for (const m of text.matchAll(SLASHED)) {
    if (!known.has(m[2])) continue;
    const start = m.index + m[1].length;
    out.push(text.slice(from, start), <span key={start} className="skill"><span className="skill-slash">/</span>{m[2]}</span>);
    from = start + 1 + m[2].length;
  }
  if (!out.length) return null;
  out.push(text.slice(from) + (text.endsWith("\n") ? " " : "")); // a last empty line, which a div drops and a textarea keeps
  return out;
}

async function readImage(file: File): Promise<Image | null> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return null;
  const url = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
  return { media_type: file.type, data: url.slice(url.indexOf(",") + 1), url };
}

// What is typed and not yet sent, by chat (localStorage.composerDrafts), so a closed or reloaded tab gives it back,
// as claude.ai's composer does. Text only: images would soon fill the browser's few megabytes. The 50 chats typed in
// last keep theirs.
const drafts = (): Record<string, string> => JSON.parse(localStorage.composerDrafts ?? "{}");

function keepDraft(id: string, text: string) {
  const { [id]: _, ...rest } = drafts();
  const all = Object.entries(rest);
  if (text.trim()) all.push([id, text]);
  localStorage.composerDrafts = JSON.stringify(Object.fromEntries(all.slice(-50)));
}

const Composer = observer(function Composer({ s }: { s: LiveSession }) {
  const [text, setText] = useState(() => drafts()[s.id] ?? "");
  useEffect(() => keepDraft(s.id, text), [s.id, text]);
  const [images, setImages] = useState<Image[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const [token, setToken] = useState<ReturnType<typeof tokenAt>>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const commands = useRef<Promise<Pick[]> | null>(null);
  const [known, setKnown] = useState<Set<string> | null>(null); // the names / takes, once asked
  const asked = useRef(0);
  const focus = wantsFocus.get() === s.id;
  // Messages waiting for Claude's next step, or not sent, which ↑ takes back.
  const queued = (s.working && s.pending.length > 0) || s.pending.some((p) => p.lost);

  useEffect(() => {
    if (!focus) return;
    box.current!.focus();
    runInAction(() => wantsFocus.set(null));
  }, [focus]);

  const commandList = () => (commands.current ??= fetch(`/api/live/${s.id}/commands`).then((r) => r.json())
    .then((list: { name: string; description: string }[]) => {
      setKnown(new Set(list.map((c) => c.name)));
      return list.map((c) => ({ label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` }));
    })
    .catch(() => (commands.current = null, [])));

  // A new chat started again in the folder picked for it: its / names are that folder's.
  useEffect(() => {
    commands.current = null;
    setKnown(null);
  }, [s.meta?.cwd]);

  // A / in the text, typed or kept in a draft, asks for the names it may mark.
  useEffect(() => {
    if (!known && /(^|\s)\/\w/.test(text)) void commandList();
  }, [text, known]);

  const marks = marked(text, known);
  // The layer keeps to the textarea's text: as wide as its lines, short of a scrollbar, and scrolled as far.
  useLayoutEffect(() => {
    const el = box.current!, under = layer.current;
    if (!under) return;
    under.style.right = `${el.offsetWidth - el.clientWidth}px`;
    under.scrollTop = el.scrollTop;
  });

  async function complete(t: ReturnType<typeof tokenAt>) {
    setToken(t);
    if (!t) return setPicks([]);
    const n = ++asked.current;
    let list: Pick[];
    if (t.kind === "/") {
      const w = t.word.toLowerCase();
      list = (await commandList()).filter((c) => c.label.slice(1).toLowerCase().includes(w))
        .sort((a, b) => Number(!a.label.slice(1).toLowerCase().startsWith(w)) - Number(!b.label.slice(1).toLowerCase().startsWith(w))).slice(0, 12);
    } else {
      // A new desk chat's first @ names one of the user's agents, whom the chat is then with; otherwise @ is a file. A
      // chat still connecting, as right after New session, offers them too: desk switches only a new desk chat.
      const opening = (!s.meta || (s.meta.chat && !s.meta.agent)) && t.start === 0 && !s.items.length && !s.pending.length;
      const agents = opening ? (await agentPicks()).filter((a) => a.label.slice(1).toLowerCase().includes(t.word.toLowerCase())) : [];
      list = agents.length ? agents : ((await (await fetch(`/api/live/${s.id}/files?q=${encodeURIComponent(t.word)}`)).json()) as string[])
        .slice(0, 12).map((f) => ({ label: f, insert: `@${f} ` }));
    }
    if (n !== asked.current) return; // a later keystroke asked again
    setPicks(list);
    // A / mid-message runs only if Claude takes it up, so, as in Claude Code, no row is picked: Enter still sends.
    setAt(t.kind === "/" && t.start > 0 ? -1 : 0);
  }

  function choose(p: Pick) {
    if (!token) return;
    const caret = box.current!.selectionStart;
    const next = text.slice(0, token.start) + p.insert + text.slice(caret);
    setText(next);
    setPicks([]);
    setToken(null);
    requestAnimationFrame(() => {
      const el = box.current!;
      el.focus();
      el.selectionStart = el.selectionEnd = token.start + p.insert.length;
    });
  }

  async function send() {
    const t = text.trim();
    if (!t && !images.length) return;
    setText("");
    const sending = images;
    setImages([]);
    setPicks([]);
    if (!(await s.send(t, sending))) {
      setText(t); // put back what failed to go
      setImages(sending);
    }
  }

  // ↑ on the box's first line while messages wait: they come back into the box, above what is typed, to edit.
  async function takeBack() {
    const back = await s.withdraw();
    if (!back) return;
    setText((now) => [back.text, now].filter(Boolean).join("\n"));
    setImages((now) => [...back.images, ...now]);
    requestAnimationFrame(() => {
      const el = box.current!;
      el.focus();
      el.selectionStart = el.selectionEnd = back.text.length;
    });
  }

  async function attach(files: Iterable<File>) {
    const read = (await Promise.all([...files].map(readImage))).filter((x): x is Image => Boolean(x));
    if (read.length) setImages((now) => [...now, ...read]);
    else toast("Only images can be attached here: PNG, JPEG, GIF or WebP.");
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files); }}>
      {picks.length > 0 && (
        <div className="picks" role="listbox">
          {picks.map((p, n) => (
            <button key={p.label} type="button" className={`pick-row${n === at ? " on" : ""}`} onMouseDown={(e) => { e.preventDefault(); choose(p); }} onMouseEnter={() => setAt(n)}>
              <span className="pick-label">{p.label}</span>
              {p.hint && <span className="pick-hint">{p.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="attached">
          {images.map((img, n) => (
            <span key={n} className="thumb">
              <img src={img.url} alt="" />
              <button type="button" title="Remove" onClick={() => setImages(images.filter((_, k) => k !== n))}>{GLYPH.close}</button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-text">
        {marks && <div ref={layer} className="composer-marks" aria-hidden="true">{marks}</div>}
        <textarea ref={box} rows={1} value={text} spellCheck={false} className={marks ? "marked" : undefined}
          placeholder={s.working ? "Queue a message for when it's ready…" : "Reply…"}
          onScroll={(e) => { if (layer.current) layer.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={(e) => { setText(e.target.value); void complete(tokenAt(e.target.value, e.target.selectionStart)); }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) { e.preventDefault(); void attach(files); }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
            if (e.key === "Tab" && e.shiftKey && fresh(s)) {
              e.preventDefault(); // Claude Code's key for its modes, here the chip's two
              flipStartAs(s);
            } else if (picks.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setAt(e.key === "ArrowDown" ? (at + 1) % picks.length : (at <= 0 ? picks.length : at) - 1);
            } else if (picks.length && (e.key === "Tab" || (e.key === "Enter" && at >= 0))) {
              e.preventDefault();
              choose(picks[Math.max(at, 0)]);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "ArrowUp" && queued && !e.currentTarget.value.slice(0, e.currentTarget.selectionStart).includes("\n")) {
              e.preventDefault();
              void takeBack();
            } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && s.working && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
              e.preventDefault(); // a terminal's Ctrl C; with text selected it copies
              void s.interrupt();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // the frame's Esc would also leave the page: that is the next Esc's to do
              if (picks.length) setPicks([]);
              else e.currentTarget.blur();
            }
          }} />
      </div>
      <div className="composer-foot">
        <label className="dock-btn attach" title="Attach an image">
          {GLYPH.plus}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ""; }} />
        </label>
        {fresh(s) && <StartAs s={s} />}
        {fresh(s) && <StartIn s={s} />}
        <span className="spacer" />
        <Runs s={s} />
        {s.working && (
          <button className="stop" type="button" title="Stop  Ctrl C" onClick={() => void s.interrupt()}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1.5" /></svg>
          </button>
        )}
        <button className="send" type="button" title={s.working ? "Queue  Enter" : "Send  Enter"} disabled={!text.trim() && !images.length} onClick={() => void send()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
});

// A new desk chat that nobody has written in yet, whose chip still picks what it becomes.
const fresh = (s: LiveSession) => Boolean(s.meta?.chat && !s.meta.agent && !s.meta.bare && !s.meta.issue) && !s.items.length && !s.pending.length && !s.working;

// The chip by +, until the first message: what the chat becomes. Issue is desk's agent, which files the talk in Triage
// and works it; Chat is a bare Claude, which the sidebar lists under Chats (chats.ts, becomeBare).
const START_AS = {
  issue: { label: "Issue", icon: GLYPH.triage, sub: "lands in Triage" },
  chat: { label: "Chat", icon: GLYPH.chat, sub: "just talk, lands in Chats" },
} as const;

// A pick sticks: the next new chat starts on it (live.ts).
const pickStartAs = (s: LiveSession, k: "issue" | "chat") => runInAction(() => { s.startAs = k; localStorage.startAs = k; });

// Shift Tab in the composer: the chip's other choice.
const flipStartAs = (s: LiveSession) => pickStartAs(s, s.startAs === "issue" ? "chat" : "issue");

const StartAs = observer(function StartAs({ s }: { s: LiveSession }) {
  const now = START_AS[s.startAs];
  const items = () => (["issue", "chat"] as const).map((k) => ({ ...START_AS[k], group: 1, heading: "This chat becomes", current: k === s.startAs,
    run: () => pickStartAs(s, k) }));
  return (
    <button className="runs start-as" type="button" title="What this chat becomes  Shift Tab"
      onClick={(e) => { if (!toggled(e.currentTarget)) openMenu({ anchor: e.currentTarget, items }); }}>
      {now.icon}{now.label}
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

// The folder the chat runs in: a Chat's is the home folder and desk's agent's its data folder, until one is picked.
const startsIn = (s: LiveSession) => (fresh(s) && !s.meta?.picked && s.startAs === "chat" ? "~" : s.meta?.folder ?? "");

// The chip by Issue and Chat, until the first message: the folder the chat runs in, picked as an issue's is.
const StartIn = observer(function StartIn({ s }: { s: LiveSession }) {
  const now = startsIn(s);
  return (
    <button className="runs start-in" type="button" title="The folder this chat runs in"
      onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(now, e.currentTarget, (f) => {
        s.startIn(f);
        requestAnimationFrame(focusComposer); // back to typing the first message
      }); }}>
      {GLYPH.folder}<span>{now}</span>
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

// The chip by Send: the model and effort the session runs on; its menu picks others and shows the usage.
const Runs = observer(function Runs({ s }: { s: LiveSession }) {
  const runs = s.meta?.runs;
  if (!runs) return null;
  return (
    <button className="runs" type="button" title="Model and effort" onMouseEnter={warm} onFocus={warm}
      onClick={(e) => { if (!toggled(e.currentTarget)) runsMenu(e.currentTarget, s.id, runs, (set, shown) => void s.pick(set, shown)); }}>
      {runs.effort ? `${runs.name} · ${effortName(runs.effort)}` : runs.name}
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

