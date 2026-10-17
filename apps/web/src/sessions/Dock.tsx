// A session's chat, in the middle of the screen, drawn as claude.ai draws a chat: replies stream in as Markdown, tool
// steps fold under one line, questions come as buttons, and the composer queues a message while Claude works (Enter)
// or stops it (Esc). Its issue sits beside it on the right, in the frame's panel (store/dock.ts says where each stands).
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { postJson, reason } from "../api/http";
import { go } from "../app/nav";
import { markdown } from "../lib/markdown";
import { dock, SIDE_WIDTH } from "../store/dock";
import { issues } from "../store/issues";
import { toggleSide as toggleSidebar } from "../frame/side";
import { GLYPH, SIDE_ICON } from "../ui/icons";
import { toast } from "../ui/toast";
import { live, useLive, type Ask, type Block, type Image, type Item, type LiveSession } from "./live";

const focusComposer = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".dock .composer textarea")?.focus());

// Open a session's chat in the middle: its issue's page when it has one, which shows the chat with the issue beside it.
export function openSession(id: string, slug?: string | null) {
  slug ??= [...issues.bySlug.values()].find((i) => i.session === id)?.slug;
  go(slug ? `/issue/${slug}` : `/sessions/${id}`);
  focusComposer();
}

// New session: an agent chat, in the middle. Its issue comes beside it once the agent files one (SessionFullRoute).
export async function newSession() {
  const res = await postJson("/sessions/new");
  if (!res.ok) return toast(await reason(res));
  openSession((await res.json()).id);
}

// A change of layout moves as one piece, through the browser's view transitions: the issue page shrinks into the side
// as its chat rises in the middle, and slides out when hidden (dock.css says how). Where the browser has none, or
// motion is turned down, it changes at once.
const still = matchMedia("(prefers-reduced-motion: reduce)");
function move(next: string, change: () => void) {
  if (next === dock.layout || !document.startViewTransition || still.matches) return change();
  document.startViewTransition(() => flushSync(change));
}

// What the page on screen asks for (the frame calls it as the address changes).
export const arrange = (session: string | null, issue: boolean) => move(dock.layoutAfter(session, issue), () => dock.arrange(session, issue));

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
  const s = useLive(shown);
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

const SessionView = observer(function SessionView({ id }: { id: string }) {
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
  // A composer that grows or a question card that comes shrinks the view, and a reply that streams grows what is in
  // it: either way it keeps to the bottom while it was there.
  useEffect(() => {
    const el = scroller.current!;
    const keep = new ResizeObserver(() => { if (stuck.current) el.scrollTo({ top: el.scrollHeight }); });
    keep.observe(el);
    keep.observe(el.firstElementChild!); // the conversation itself, as words stream and steps unfold
    return () => keep.disconnect();
  }, []);

  return (
    <div className="session-view">
      <ChatHead s={s} />
      <div className="dock-scroll" ref={scroller} onScroll={onScroll}>
        <div className="convo">
          {!s.loaded ? <p className="convo-empty">Connecting…</p>
            : !s.items.length && !s.pending.length && !s.working ? <p className="convo-empty">{m?.chat ? "Ask desk's agent anything: it files the work and does it here." : "Nothing said yet."}</p>
            : null}
          <Conversation s={s} />
        </div>
      </div>
      {s.asks.map((a) => <AskCard key={a.id} s={s} ask={a} />)}
      <Composer s={s} />
    </div>
  );
});

// The chat's head: the sidebar's toggle while it is hidden, as a page's top bar has, whether it works, its issue's
// title, and its folder. The title shows or hides the issue beside it.
const ChatHead = observer(function ChatHead({ s }: { s: LiveSession }) {
  const m = s.meta;
  return (
    <header className="dock-head">
      <button className="side-icon side-toggle" type="button" title="Show sidebar  [" onClick={toggleSidebar}>{SIDE_ICON}</button>
      <Dot s={s} />
      <div className="dock-title">
        {dock.issue && m?.issue
          ? <button type="button" className={`dock-issue${dock.sideShown ? " on" : ""}`} title={`${dock.sideShown ? "Hide" : "Show"} the issue  ]`} onClick={toggleIssue}>{m.issue.title}</button>
          : <span>{m?.issue?.title ?? m?.title ?? ""}</span>}
        {m?.folder && <span className="dock-folder" title={m.cwd}>{m.folder}</span>}
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
        if (r.kind === "note") return <p key={r.item.key} className="convo-note">{r.item.text}</p>;
        const running = n === rows.length - 1 && s.working ? liveSteps : [];
        return <Steps key={r.key} s={s} items={r.items} running={running} live={n === rows.length - 1 && s.working} />;
      })}
      {liveSteps.length > 0 && last?.kind !== "steps" && <Steps s={s} items={[]} running={liveSteps} live />}
      {liveText.map((b) => <Reply key={`${b.msg}:${b.index}`} text={b.text} streaming />)}
      {s.pending.map((p) => <You key={p.key} text={p.text} images={p.images} queued={s.working} />)}
      {s.working && !liveText.length && !s.asks.length && <Working since={s.since} />}
    </>
  );
});

const LONG = 600; // characters past which a message shows its first lines only, as claude.ai shows a long paste

function You({ text, images, queued }: { text: string; images?: number; queued?: boolean }) {
  const [all, setAll] = useState(false);
  const long = text.length > LONG && !all;
  return (
    <div className={`you${queued ? " queued" : ""}`}>
      <div className={`you-bubble${long ? " folded" : ""}`}>
        {images ? <span className="you-images">{images === 1 ? "1 image" : `${images} images`}</span> : null}
        {text}
      </div>
      {long && <button className="you-more" type="button" onClick={() => setAll(true)}>Show all</button>}
      {queued && <span className="you-queued">{GLYPH.clock}Queued</span>}
    </div>
  );
}

const Reply = function Reply({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => markdown(text), [text]);
  return <div className={`reply body${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
};

function Working({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  return (
    <p className="working">
      <span className="spark" aria-hidden="true" />
      Working{secs ? ` · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : ""}
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
          {items.map((i) => (i.t === "thinking" ? <Thought key={i.key} text={i.text ?? ""} /> : <Step key={i.key} item={i} result={s.results.get(i.id!)} />))}
          {running.map((b) => <p key={`${b.msg}:${b.index}`} className="step running"><span className="step-name">{b.kind === "thinking" ? "Thinking" : b.name}</span><span className="step-what">…</span></p>)}
        </div>
      )}
    </div>
  );
});

function Thought({ text }: { text: string }) {
  return <div className="step thought"><span className="step-name">Thought</span><div className="thought-text">{text}</div></div>;
}

function Step({ item, result }: { item: Item; result?: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`step${result?.error ? " error" : ""}${result ? "" : " running"}`}>
      <button className="step-line" type="button" onClick={() => setOpen(!open)}>
        <span className="step-name">{item.name}</span>
        <span className="step-what">{item.summary}</span>
      </button>
      {open && (
        <div className="step-detail">
          <pre>{item.input}</pre>
          {result && <pre className="step-result">{result.text || "(no output)"}</pre>}
        </div>
      )}
    </div>
  );
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

// A word being typed that the composer completes: a / at the start, or an @ after a space.
function tokenAt(text: string, caret: number): { kind: "/" | "@"; start: number; word: string } | null {
  const before = text.slice(0, caret);
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash) return { kind: "/", start: 0, word: slash[1] };
  const at = /(^|\s)@([^\s]*)$/.exec(before);
  if (at) return { kind: "@", start: before.length - at[2].length - 1, word: at[2] };
  return null;
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

const Composer = observer(function Composer({ s }: { s: LiveSession }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Image[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const [token, setToken] = useState<ReturnType<typeof tokenAt>>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const commands = useRef<Pick[] | null>(null);
  const asked = useRef(0);

  useLayoutEffect(() => { // grows with what is typed, up to a third of the panel
    const el = box.current!;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function complete(t: ReturnType<typeof tokenAt>) {
    setToken(t);
    if (!t) return setPicks([]);
    const n = ++asked.current;
    let list: Pick[];
    if (t.kind === "/") {
      commands.current ??= ((await (await fetch(`/api/live/${s.id}/commands`)).json()) as { name: string; description: string }[])
        .map((c) => ({ label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` }));
      const w = t.word.toLowerCase();
      list = commands.current.filter((c) => c.label.slice(1).toLowerCase().includes(w))
        .sort((a, b) => Number(!a.label.slice(1).toLowerCase().startsWith(w)) - Number(!b.label.slice(1).toLowerCase().startsWith(w))).slice(0, 12);
    } else {
      list = ((await (await fetch(`/api/live/${s.id}/files?q=${encodeURIComponent(t.word)}`)).json()) as string[])
        .slice(0, 12).map((f) => ({ label: f, insert: `@${f} ` }));
    }
    if (n !== asked.current) return; // a later keystroke asked again
    setPicks(list);
    setAt(0);
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
      <textarea ref={box} rows={1} value={text} spellCheck={false}
        placeholder={s.working ? "Queue a message for when it's ready…" : "Reply…"}
        onChange={(e) => { setText(e.target.value); void complete(tokenAt(e.target.value, e.target.selectionStart)); }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) { e.preventDefault(); void attach(files); }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
          if (picks.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setAt((at + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length);
          } else if (picks.length && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            choose(picks[at]);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // the frame's Esc would leave the page
            if (picks.length) setPicks([]);
            else if (s.working) void s.interrupt();
            else e.currentTarget.blur();
          }
        }} />
      <div className="composer-foot">
        <label className="dock-btn attach" title="Attach an image">
          {GLYPH.plus}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ""; }} />
        </label>
        <span className="composer-hint">{s.working ? "Enter queues · Esc stops" : "Enter sends · Shift Enter for a new line"}</span>
        {s.working && (
          <button className="stop" type="button" title="Stop  Esc" onClick={() => void s.interrupt()}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1.5" /></svg>
          </button>
        )}
        <button className="send" type="button" title="Send  Enter" disabled={!text.trim() && !images.length} onClick={() => void send()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
});
