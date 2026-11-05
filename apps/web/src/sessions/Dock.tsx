// A session's chat, in the middle of the screen, drawn as claude.ai draws a chat: replies stream in as Markdown, tool
// steps fold under one line, questions come as buttons, and the composer queues a message while Claude works (Enter)
// or stops it (Ctrl C). A chat opens to read, with desk's keys, unless nothing is said in it yet; I or Enter goes into
// the composer and Esc leaves it, as vim's modes. An issue's chat shows its steps in its right half, and one line of them above the composer (StepsHalf.tsx)
// (store/dock.ts says where each stands). Its right half, beside it, holds what Claude drives, its terminal and its
// browser, and what you read beside the chat, a step's diagram and the issue's Changes (Half.tsx). A chat that follows a Slack or mail thread has
// your box to it above the composer, which Reply on the thread's card opens (YourReply.tsx).
import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { postJson, reason } from "../api/http";
import { go } from "../app/nav";
import { splashUp, useSplash } from "../app/splash";
import { APP } from "../lib/desktop";
import { markdown } from "../lib/markdown";
import { seenPage, usePage } from "../api/page";
import { HeadStatus, IssueDetails, landSkip, Lands, StepButtons, Title, useStep, type IssuePageData } from "../issues/IssueView";
import { useLive as useIssueLive } from "../issues/useLive";
import { folderMenu } from "../issues/menus";
import { toClipboard } from "../issues/actions";
import { dock, type Layout } from "../store/dock";
import { issues, type Reply as SentReply } from "../store/issues";
import { toggleSide as toggleSidebar } from "../frame/side";
import { CHEVRON, GLYPH, SIDE_ICON, StateIcon } from "../ui/icons";
import { isDrawn, StepParts, type PlanStep } from "../issues/Steps";
import { openMenu, toggled } from "../ui/menu";
import { toast } from "../ui/toast";
import { CameCard, RepliedLine } from "./Came";
import { anyCommit, lastCommit } from "./Changes";
import { rising } from "./glide";
import { clock, sent, whole } from "./time";
import { Half } from "./Half";
import { followParts } from "./StepHalf";
import { StepsHalf, StepsLine } from "./StepsHalf";
import { replyTo, YourReply } from "./YourReply";
import { live, renameChat, useLive, type Ask, type Attachment, type Block, type Item, type LiveSession, type Status, type Task } from "./live";
import { EFFORTS, effortName, loadModels, runsMenu, tokens, warm, type Runs as RunsShown } from "./models";

// The chat that takes the cursor: the one openSession opened. It takes it as it comes on screen, which a view transition
// can make a frame or more after the address changes, or at once when it is there already (SessionView says where).
const wantsFocus = observable.box<string | null>(null);

// Open a session's chat in the middle: its issue's page when it has one, which shows the chat with the issue in its
// head. It opens to read, unless nothing is said in it yet ("unless i open an empty chat, don't focus on composer", the user,
// 21 Oct).
export function openSession(id: string, slug?: string | null) {
  slug ??= issues.issueOf(id);
  go(slug ? `/issue/${slug}` : `/sessions/${id}`);
  runInAction(() => wantsFocus.set(id));
}

// I, as vim's insert: the cursor back into the composer of the chat in the middle, or of the one the Inbox shows. False
// when no chat is there.
export function focusComposer() {
  const box = document.querySelector<HTMLTextAreaElement>(".dock .composer textarea, .chat-open .composer textarea");
  box?.focus();
  return Boolean(box);
}

// New session: an agent chat, in the middle. Its issue is in its head once the agent files one (SessionFullRoute).
// A draft, such as New automation's, waits typed in its composer.
export async function newSession(draft = "") {
  const res = await postJson("/sessions/new");
  if (!res.ok) return toast(await reason(res));
  const { id } = await res.json();
  if (draft && !drafts()[id]) keepDraft(id, draft);
  openSession(id);
}

// The issue page of the chat in the middle, as its conversation last fetched it, which the bar on top of the composer
// reads too: one fetch for both.
const chatPage = observable.box<IssuePageData | null>(null, { deep: false });

// A change of layout moves as one piece, through the browser's view transitions: the issue page shrinks away as its
// chat rises in the middle (dock.css says how). Where the browser has none, or motion is turned down, it changes at
// once, and so does the first one, under the splash, where nothing was seen to move from: the page then drew whole only
// after a third of a second's glide (25 Oct). A chat's views change in place, with no move.
const still = matchMedia("(prefers-reduced-motion: reduce)");
let moving: Promise<void> | null = null; // the move on screen, which the issue's own slide in waits for
function move(next: Layout, change: () => void) {
  if (next === dock.layout || !document.startViewTransition || still.matches || splashUp()) return change();
  const t = document.startViewTransition(() => flushSync(change));
  const done = moving = t.finished.catch(() => {}).then(() => { if (moving === done) moving = null; });
}

// What the page on screen asks for (the frame calls it as the address changes): an issue page's chat comes alone, on
// Chat.
export function arrange(session: string | null) {
  move(dock.layoutAfter(session), () => dock.arrange(session));
}

// Whether the chat in the middle is an issue's, whose details it can show.
const hasIssue = () => dock.center && chatPage.get()?.issue.session === dock.session;

// ] on an issue's chat in the middle while you read it, as [ the sidebar: its issue's details drop open under its head,
// or fold. Its page is no view of it since 1 Nov: its step is in the head, its details drop open under it, and its Plan
// is drawn in the chat ("for content, it's all in the chat huh", the user); its Changes are in the right half
// since 4 Nov (Half.tsx), so Tab, 1 and 2, which walked the chat's views, have nothing to do.
export function detailsKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || !hasIssue() || e.key !== "]") return false;
  dock.setDetails(!dock.details);
  return true;
}

export const Dock = observer(function Dock() {
  const id = dock.center ? dock.session : null;
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("chat-center", Boolean(id));
  }, [id]);
  return (
    <aside className="dock" aria-hidden={!id}>
      {id ? <SessionView key={id} id={id} /> : null}
    </aside>
  );
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

// Nothing said in the chat yet, by either side.
const quiet = (s: LiveSession) => !s.items.length && !s.pending.length && !s.working;

// A chat as the middle shows it; the Inbox draws one in its right pane too.
// A link to another site, clicked in the chat in the middle, opens in its Browser: a tab for its session in desk's app,
// beside the chat ("i want everything on chrome that desk opens sit inside desk. e.g. open a link from agent's result",
// the user, 1 Nov). Ctrl, Shift, Alt or the middle button opens it in your own browser, as before, and so does any
// click in desk in a web page, which has no Browser (lib/desktop.ts).
function browse(e: React.MouseEvent, session: string) {
  if (!APP) return;
  const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
  e.preventDefault();
  dock.setHalf(session, "browser", true);
  void postJson(`/api/live/${session}/browse`, { url: a.href }).then(async (res) => res.ok || toast(await reason(res)));
}

// Whether a step written as parts can show its diagrams in the chat's right half, as only the chat in the middle can, and
// not on a phone, where the half would take the chat's place; and whether the half shows them now (StepHalf.tsx), or
// each part draws its own under its text.
const phone = matchMedia("(max-width: 640px)");
const StepSide = createContext({ can: false, beside: false });

// Your box to a thread the chat follows sits over its composer, once Reply on its card, or Claude's draft, opened it
// (YourReply.tsx).
export const SessionView = observer(function SessionView({ id }: { id: string }) {
  const s = useLive(id)!;
  useSplash(!s.loaded); // desk opening on a chat shows it with its conversation, never "Connecting…"
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true); // following the bottom, as new words come
  // Not following it, which the Jump to latest pill says, "fresh" once words came below, which its dot says.
  const [away, setAway] = useState<false | "quiet" | "fresh">(false);
  const m = s.meta;
  // The chat in the middle, rather than the Inbox's pane showing the same chat.
  const docked = dock.center && dock.session === id;
  const page = chatPage.get(), here = m?.issue && page?.issue.slug === m.issue.slug ? page : null;
  // The chat in the middle may have its right half open beside it, which a step's diagram needs its issue's steps for,
  // and its Changes a step's commit.
  const opened = docked && m?.chat ? dock.halves[id] : undefined;
  const half = (opened === "step" && (phone.matches || !here)) || (opened === "changes" && !anyCommit(here?.plan_steps)) || (opened === "steps" && !here?.plan_steps?.length) ? undefined : opened;
  const side = { can: Boolean(docked && m?.chat && !phone.matches), beside: half === "step" };
  const beside = useRef(false); // the half follows the part being read as the chat scrolls or grows
  beside.current = side.beside;
  // A step ticked with its commit opens the half on its Changes, once, while the issue is open (store/dock.ts).
  const commit = here && !["done", "dropped"].includes(here.issue.state) ? lastCommit(here.plan_steps) : null;
  useEffect(() => { if (commit && side.can) dock.showChanges(id, commit); }, [id, commit, side.can]);

  // Only the reader scrolling up lets go of the end, and coming back near it takes it again. A chat opened cold grows
  // as its pictures load, between a scroll to its end and that scroll's own event, which then finds it far from the
  // end though nobody moved: measured alone, it stopped such a chat 888px short (31 Oct).
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current!;
    if (rising(el)) stuck.current = false; // J, K, Ctrl U and the rest, up (glide.ts)
    else if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stuck.current = true;
    else if (el.scrollTop < lastTop.current) stuck.current = false;
    lastTop.current = el.scrollTop;
    setAway((a) => (stuck.current ? false : a || "quiet"));
    if (beside.current) followParts(el, id);
  };
  // The pill takes the chat back to its end, which it follows again. It jumps there, as a step's jump to its message
  // does (StepsHalf.tsx), and leaves the keys on the conversation as the pill goes.
  const toEnd = () => {
    const el = scroller.current!;
    stuck.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    el.focus({ preventScroll: true });
  };
  const streamed = s.partial.reduce((n, b) => n + b.text.length, 0);
  useLayoutEffect(() => {
    if (stuck.current && !rising(scroller.current!)) scroller.current!.scrollTo({ top: scroller.current!.scrollHeight });
  }, [s.items.length, streamed, s.pending.length, s.asks.length, s.working, s.loaded]);
  useEffect(() => {
    if (!stuck.current) setAway((a) => a && "fresh");
  }, [s.items.length, streamed]);
  // A reply that streams grows the conversation, and a composer that grows or a question card that comes grows the
  // foot over its end: either way the view keeps to the bottom while it was there. The view itself changes size only
  // with the window.
  useEffect(() => {
    const el = scroller.current!;
    const keep = new ResizeObserver(() => {
      if (stuck.current && !rising(el)) el.scrollTo({ top: el.scrollHeight });
      if (beside.current) followParts(el, id);
    });
    keep.observe(el);
    keep.observe(el.firstElementChild!); // the conversation itself, as words stream and steps unfold
    keep.observe(el.lastElementChild!); // the foot: the composer and any question card
    return () => keep.disconnect();
  }, []);

  // The chat openSession opened takes the cursor once it knows whether anything is said in it: an empty one in its
  // composer, any other in its conversation, to read first, where Space scrolls it and Enter goes into the composer
  // (Frame). Only in the middle: the Inbox's pane showing the same chat is on its way out.
  const take = wantsFocus.get() === id && s.loaded ? (quiet(s) ? "type" : "read") : null;
  useEffect(() => {
    const el = scroller.current!;
    if (!take || !el.closest(".dock")) return;
    if (take === "type") el.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    else el.focus({ preventScroll: true });
    runInAction(() => wantsFocus.set(null));
  }, [take]);

  // The composer lies over the conversation's end, as claude.ai's does: the foot sticks to the bottom of the view, and
  // the conversation runs on behind it (dock.css). The chat in the middle may have its right half open beside it, the
  // chat then as wide as you dragged it (--chat-w), the half all the rest.
  return (
    <div className="session-split" style={half ? ({ "--chat-w": `${dock.chatWidth}px` } as CSSProperties) : undefined}>
      <div className="session-view">
        <ChatHead s={s} docked={docked} />
        {here && docked && dock.details && <IssueDetails data={here} />}
        <div className="dock-scroll" ref={scroller} onScroll={onScroll} tabIndex={-1}>
          <div className="convo" onClick={docked && m?.chat ? (e) => browse(e, id) : undefined}>
            {!s.loaded ? <p className="convo-empty">Connecting…</p>
              : quiet(s) ? <p className="convo-empty">{m?.agent ? `Talk to ${m.agent}.`
                : m?.chat && m.issue ? "This issue's chat. Write to carry the issue on: it starts from the issue's document."
                : m?.bare || (m?.chat && s.startAs === "chat") ? `Just Claude, as claude runs in a terminal ${startsIn(s) === "~" ? "from your home folder" : `in ${startsIn(s)}`}: no issue and no desk instructions.`
                : m?.chat ? "Ask desk's agent anything: it files the work and does it here. Start with @ and a name to talk to one of your agents."
                : "Nothing said yet."}</p>
              : null}
            <StepSide.Provider value={side}>
              {m?.issue ? <IssueConversation s={s} slug={m.issue.slug} /> : <Conversation s={s} page={null} slug={null} />}
            </StepSide.Provider>
          </div>
          <div className="dock-foot">
            {away && (
              <button className="jump-latest" type="button" onClick={toEnd}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" /></svg>
                Jump to latest
                {away === "fresh" && <span className="view-dot" />}
              </button>
            )}
            {here && half !== "steps" && <StepsLine steps={here.plan_steps ?? []} />}
            <Running s={s} />
            {s.asks.map((a) => <AskCard key={a.id} s={s} ask={a} />)}
            <YourReply session={id} />
            <Composer s={s} />
          </div>
        </div>
      </div>
      {half && <Half session={id} view={half} issue={here && { slug: here.issue.slug, steps: here.plan_steps ?? [] }} list={half === "steps" && here ? <ChatSteps s={s} here={here} /> : null} />}
    </div>
  );
});

// The issue's steps in the right half (StepsHalf.tsx), each drawn one bringing its latest send in the chat.
const ChatSteps = observer(function ChatSteps({ s, here }: { s: LiveSession; here: IssuePageData }) {
  const sends = s.results.size, steps = here.plan_steps ?? [];
  const sent = useMemo(() => stepSends(s, here.issue.slug, steps), [s.items, sends, here.issue.slug, here.plan_steps]); // eslint-disable-line react-hooks/exhaustive-deps
  return <StepsHalf session={s.id} steps={steps} sent={sent} />;
});

// The chat's head: the sidebar's toggle while it is hidden, as a page's top bar has, then its issue's status and
// title, with a ⌄ that drops the issue's details open under the head (IssueDetails), and at its right the buttons that
// open the half beside it, the issue's steps, its Changes, the terminal and, in desk's app, the globe (1 Nov: "since terminal and
// browser are opened in right sidebar, so having these icons in composer doesn't sound valid"), then the issue's next step, Go
// or Approve (1 Nov: "the approve button is not there, but i have to tab to issue"); the Inbox, which shows a
// chat without its head, has its own. Where its work stands is in its steps
// (StepsHalf.tsx). A chat with no issue is renamed in its title, and shows its folder, which only an issue's Properties would
// show otherwise. Whether the chat works shows in the chat itself, its Working… line and its stop button (28 Oct: "the
// header in chat interface looks kinda tight").
const ChatHead = observer(function ChatHead({ s, docked }: { s: LiveSession; docked: boolean }) {
  const m = s.meta;
  const page = chatPage.get(), here = m?.issue && page?.issue.slug === m.issue.slug ? page : null;
  return (
    <header className="dock-head">
      <button className="side-icon side-toggle" type="button" title="Show sidebar  [" onClick={toggleSidebar}>{SIDE_ICON}</button>
      {here && <HeadStatus issue={here.issue} />}
      <div className="dock-title">
        {m?.chat && !m.issue ? <Title line title={m.title} save={(t) => renameChat(s.id, t)} />
          : <span>{m?.issue?.title ?? m?.title ?? ""}</span>}
        {!m?.issue && startsIn(s) && <span className="dock-folder" title={startsIn(s)}>{startsIn(s)}</span>}
        {here && docked && (
          <button className={`head-details${dock.details ? " open" : ""}`} type="button" aria-expanded={dock.details}
            title={dock.details ? "Hide the issue's details  ]" : "The issue's details  ]"} onClick={() => dock.setDetails(!dock.details)}>{CHEVRON}</button>
        )}
      </div>
      {m?.chat && docked && (
        <span className="head-halves">
          {here && Boolean(here.plan_steps?.length) && <HalfButton id={s.id} view="steps" />}
          {here && anyCommit(here.plan_steps) && <HalfButton id={s.id} view="changes" />}
          <HalfButton id={s.id} view="terminal" />{APP && <HalfButton id={s.id} view="browser" />}
        </span>
      )}
      {here && docked && <HeadStep data={here} />}
    </header>
  );
});

// The issue's next step at the head's right, only while it is a click: Go on a plan, Approve on a last report. Open chat,
// the step while the issue's turn is said in its chat, has no button here, in that chat. The Inbox's pane, which shows
// an issue's chat without this head, puts it in its own top bar (inbox/InboxPage.tsx).
export const HeadStep = observer(function HeadStep({ data, inInbox = false }: { data: IssuePageData; inInbox?: boolean }) {
  const { p, step, trust, act } = useStep(data, inInbox);
  return (
    <div className="chat-acts">
      <StepButtons p={p} step={step} trust={trust} act={act} chat={null} />
    </div>
  );
});

// The step at the head of the chat a box is in, which Ctrl Enter presses from the box while it is empty, as from the
// chat itself (Frame.tsx).
function pressStep(box: HTMLElement) {
  const step = box.closest(".session-view")?.querySelector<HTMLButtonElement>(".chat-acts .step:not(:disabled)");
  step?.click();
  return Boolean(step);
}

// --- the conversation ------------------------------------------------------------------------------------------------

type Section = "Plan" | "Result";
type Row =
  | { kind: "you"; item: Item }
  | { kind: "text"; item: Item }
  | { kind: "note"; item: Item }
  | { kind: "came"; item: Item }
  | { kind: "replied"; key: string; reply: SentReply }
  | { kind: "steps"; key: string; items: Item[] }
  | { kind: "sent"; key: string; section: Section }
  | { kind: "step"; key: string; place: string; title: string | null };

// What a session's command sent of its issue's document: the sections it PUT at their address, once it ran and desk
// took them (a refusal answers with its "detail", api.ts).
const SECTION = /\/api\/issues\/([^/\\"'\s]+)\/sections\/(Plan|Result)\b/g;
function sentBy(tool: Item, result: Item | undefined, slug: string | null): Section[] {
  if (!slug || !result || result.error || result.text?.includes('"detail"') || !/-X\s*PUT\b|--request\s+PUT\b/.test(tool.input ?? "")) return [];
  return [...(tool.input ?? "").matchAll(SECTION)].filter((m) => m[1] === slug).map((m) => m[2] as Section);
}

// The steps a session's command sent their diagram and decisions, by their place (PUT /steps/1.2, api.ts), with the
// step's title from desk's answer when the command kept it: the places move as steps join the list, the title stays.
const STEP_SENT = /\/api\/issues\/([^/\\"'\s]+)\/steps\/([1-9][\d.]*)/g;
function stepsSentBy(tool: Item, result: Item | undefined, slug: string | null): { place: string; title: string | null }[] {
  if (!slug || !result || result.error || result.text?.includes('"detail"') || !/-X\s*PUT\b|--request\s+PUT\b/.test(tool.input ?? "")) return [];
  const title = /"step_title":\s*"((?:[^"\\]|\\.)*)"/.exec(result.text ?? "");
  const named = title ? (JSON.parse(`"${title[1]}"`) as string) : null;
  const places = [...(tool.input ?? "").matchAll(STEP_SENT)].filter((m) => m[1] === slug).map((m) => m[2].replace(/\.$/, ""));
  return places.map((place) => ({ place, title: places.length === 1 ? named : null }));
}

// The items in the order drawn, the tool steps and thoughts between two replies folded into one row. A step that sent
// the issue its plan, or in an older chat its card, leaves the fold and shows as what it sent. replied: what you sent
// from your box to the chat's threads, oldest first, each a line where it went among the items.
function rowsOf(items: Item[], results: Map<string, Item>, slug: string | null, replied: SentReply[] = []): Row[] {
  const rows: Row[] = [];
  let r = 0;
  const upto = (at: number) => {
    for (; r < replied.length && (replied[r].sent ?? replied[r].at) * 1000 <= at; r++) rows.push({ kind: "replied", key: `replied:${replied[r].id}`, reply: replied[r] });
  };
  for (const item of items) {
    if (item.at) upto(item.at);
    const bash = item.t === "tool" && item.name === "Bash";
    const sent = bash ? sentBy(item, results.get(item.id!), slug) : [];
    const drew = bash ? stepsSentBy(item, results.get(item.id!), slug) : [];
    if (sent.length || drew.length) {
      for (const section of sent) rows.push({ kind: "sent", key: `${item.key}:${section}`, section });
      for (const { place, title } of drew) rows.push({ kind: "step", key: `${item.key}:step:${place}`, place, title });
      continue;
    }
    if (item.t === "tool" || item.t === "thinking") {
      const last = rows[rows.length - 1];
      if (last?.kind === "steps") last.items.push(item);
      else rows.push({ kind: "steps", key: item.key, items: [item] });
    } else if (item.t === "you" || item.t === "text" || item.t === "note" || item.t === "came") rows.push({ kind: item.t, item } as Row);
  }
  upto(Infinity);
  return rows;
}

// What you sent from your box to the threads the chat's cards are from (the replies the app holds), since its first card
// of each came: the line in the talk costs no turn.
function repliedIn(items: Item[]): SentReply[] {
  const since = new Map<string, number>();
  for (const i of items) if (i.t === "came" && i.came?.thread && i.at && !since.has(i.came.thread)) since.set(i.came.thread, i.at);
  if (!since.size) return [];
  return [...issues.replies.values()]
    .filter((r) => (r.state === "sent" || r.state === "kept") && (r.sent ?? r.at) * 1000 >= (since.get(r.thread) ?? Infinity))
    .sort((a, b) => (a.sent ?? a.at) - (b.sent ?? b.at));
}

// An issue's chat: its conversation, with the plan its session sent, and an older chat's card, drawn from the issue's
// page, kept current as the issue's page is.
const IssueConversation = observer(function IssueConversation({ s, slug }: { s: LiveSession; slug: string }) {
  const { data, reload } = usePage<IssuePageData>(`/api/page/issue/${slug}`, `${issues.files.get(slug) ?? 0}`);
  useIssueLive(data, reload);
  const page = data?.issue.slug === slug ? data : null;
  useEffect(() => {
    runInAction(() => chatPage.set(page));
    return () => runInAction(() => chatPage.set(null));
  }, [page]);
  return (
    <>
      <ContextFold page={page} />
      <Conversation s={s} page={page} slug={slug} />
    </>
  );
});

// The issue's Context, what you asked, as the chat's first message, folded to its first line as the steps are: the chat
// holds the whole flow from its start (27 Oct).
const ContextFold = observer(function ContextFold({ page }: { page: IssuePageData | null }) {
  const [open, setOpen] = useState(false);
  const html = page?.context_html ?? "";
  const first = useMemo(() => new DOMParser().parseFromString(html, "text/html").body.textContent?.trim().split("\n")[0] ?? "", [html]);
  if (!html.trim()) return null;
  return (
    <div className={`steps context${open ? " open" : ""}`}>
      <button className="steps-head" type="button" onClick={() => setOpen(!open)}>
        <svg className="steps-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5l4 3.5-4 3.5z" /></svg>
        <span className="context-name">Context</span>
        {!open && <span className="context-first">{first}</span>}
      </button>
      {open && <div className="reply body context-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
});

// Where each step's latest send is in the chat (its data-at), by the step's title, for the steps above the composer to
// bring into view.
function stepSends(s: LiveSession, slug: string, steps: PlanStep[]): Map<string, string> {
  const sent = new Map<string, string>();
  for (const r of rowsOf(s.items, s.results, slug)) if (r.kind === "step") sent.set(stepNamed(steps, r)?.title ?? r.title ?? `Step ${r.place}`, r.key);
  return sent;
}

const Conversation = observer(function Conversation({ s, page, slug }: { s: LiveSession; page: IssuePageData | null; slug: string | null }) {
  const sends = s.results.size; // a send shows as what it sent once desk's answer to it is in
  const replied = repliedIn(s.items), went = replied.map((r) => r.id).join();
  const rows = useMemo(() => rowsOf(s.items, s.results, slug, replied), [s.items, sends, slug, went]); // eslint-disable-line react-hooks/exhaustive-deps
  // Desk keeps only the latest plan and card, which show at their last send; an earlier send is a line.
  const latest: Record<Section, number> = { Plan: -1, Result: -1 };
  rows.forEach((r, n) => { if (r.kind === "sent") latest[r.section] = n; });
  // And each step's diagram, at its step's last send.
  const steps = page?.plan_steps ?? [];
  const latestStep = new Map<string, number>();
  rows.forEach((r, n) => { if (r.kind === "step") latestStep.set(stepNamed(steps, r)?.title ?? r.place, n); });
  // The newest step sent, written as parts, opens the half on its diagrams (store/dock.ts, showStep).
  const side = useContext(StepSide);
  const newest = rows.filter((r) => r.kind === "step").at(-1);
  const newestParts = newest?.kind === "step" && stepNamed(steps, newest)?.parts?.length ? newest.key : null;
  useEffect(() => { if (newestParts && side.can) dock.showStep(s.id, newestParts); }, [s.id, newestParts, side.can]);
  // A reply streaming now: its words show as they come, its tool calls join the last fold.
  const liveSteps = s.partial.filter((b) => b.kind === "tool_use" || b.kind === "thinking");
  const liveText = s.partial.filter((b) => b.kind === "text");
  const last = rows[rows.length - 1];
  const lastQueued = s.working ? s.pending.filter((p) => p.mid && !p.lost).at(-1) : undefined; // Send now goes under it
  // One sent while Claude was idle started the reply streaming now, so it goes above it, with any sent before it; those
  // queued since go below.
  const starts = s.pending.reduce((n, p, i) => (p.mid ? n : i + 1), 0);
  const tail = s.working && !starts; // the last fold is the reply's own, and takes its tool calls streaming now
  // The steps Approve runs show under the last step's report, which handed the work over (prompts.ts, STEPS): that is
  // the last turn while the issue waits on Approve, since your reply moves it on.
  const lands = page?.reviewing ? page.lands?.steps ?? null : null;
  const you = (p: (typeof s.pending)[number]) => (
    <You key={p.key} text={p.text} images={p.attached.filter((a) => a.url).length} files={p.attached.filter((a) => !a.url).map((a) => a.name)} queued={s.working && p.mid && !p.lost} lost={p.lost} onSend={() => void s.resend(p)}
      onSendNow={p === lastQueued ? () => void s.sendNow("", []) : undefined} />
  );
  return (
    <>
      {rows.map((r, n) => {
        // One typed mid-turn is in the transcript once Claude takes it in, at its next step: by then it's sent, not queued.
        if (r.kind === "you") return <You key={r.item.key} text={r.item.text ?? ""} images={r.item.images} files={r.item.files} when={r.item.at} />;
        if (r.kind === "text") return <Reply key={r.item.key} at={r.item.key} text={r.item.text ?? ""} when={r.item.at} />;
        if (r.kind === "came") return r.item.came ? <CameCard key={r.item.key} came={r.item.came} at={r.item.at} reply={(thread) => replyTo(s.id, thread)} /> : null;
        if (r.kind === "replied") return <RepliedLine key={r.key} reply={r.reply} />;
        if (r.kind === "sent") return <Sent key={r.key} at={r.key} page={page} section={r.section} latest={n === latest[r.section]} />;
        if (r.kind === "step") {
          const step = stepNamed(steps, r);
          return <StepSent key={r.key} at={r.key} session={s.id} step={step} top={steps[Number(r.place.split(".")[0]) - 1]?.title ?? null} latest={latestStep.get(step?.title ?? r.place) === n} />;
        }
        if (r.kind === "note") {
          const agent = r.item.id ? s.items.find((i) => i.t === "tool" && i.id === r.item.id && (i.name === "Agent" || i.name === "Task")) : undefined;
          return agent ? <AgentNote key={r.item.key} s={s} note={r.item} /> : <p key={r.item.key} className="convo-note">{r.item.text}</p>;
        }
        const current = tail && n === rows.length - 1;
        return <Steps key={r.key} s={s} items={r.items} running={current ? liveSteps : []} live={current} />;
      })}
      {s.pending.slice(0, starts).map(you)}
      {liveSteps.length > 0 && !(tail && last?.kind === "steps") && <Steps s={s} items={[]} running={liveSteps} live />}
      {liveText.map((b) => <Reply key={`${b.msg}:${b.index}`} text={b.text} streaming />)}
      {page && lands && <LandsSent slug={page.issue.slug} steps={lands} />}
      {s.pending.slice(starts).map(you)}
      {s.working && !liveText.length && !s.asks.length && <Working since={s.since} status={s.status} />}
    </>
  );
});

// The plan or the card a session sent, where it sent it: the latest drawn, its text folded under Details; an earlier one
// a line ("A", the user, 1 Nov, drawing the latest plan as the card is). No chat writes a card since 4 Nov: an older
// chat's stays where it was sent.
const Sent = observer(function Sent({ at, page, section, latest }: { at: string; page: IssuePageData | null; section: Section; latest: boolean }) {
  const parts = !page ? null : section === "Plan" ? page.plan_card : page.card ?? (page.result ? [page.result_html, ""] : null);
  const name = section === "Plan" ? "Plan" : "Card";
  if (!latest || !page || !parts) {
    return <p className="sent-line" data-at={at}>{GLYPH.file}<span>{name}</span><span className="sent-when">{latest ? "sent" : "an earlier version, sent"}</span></p>;
  }
  return (
    <div className="sent" data-at={at}>
      <div className="sent-head">{GLYPH.file}<span>{name}</span></div>
      <div className="reply body sent-body" dangerouslySetInnerHTML={{ __html: parts[0] }} />
      {parts[1] && (
        <details className="review-details sent-details">
          <summary>Details</summary>
          <div className="reply body" dangerouslySetInnerHTML={{ __html: parts[1] }} />
        </details>
      )}
    </div>
  );
});

// The steps Approve runs, under the report that handed the work over: you untick one there as on the issue's page, and
// the Approve in the chat's head skips it too.
const LandsSent = observer(function LandsSent({ slug, steps }: { slug: string; steps: string[] }) {
  const [skip, setSkip] = landSkip(slug, steps);
  return <div className="sent lands-sent"><Lands steps={steps} skip={skip} setSkip={setSkip} /></div>;
});

// The step a send names: by its title from desk's answer, else by its place in the list as it stands.
function stepNamed(steps: PlanStep[], r: { place: string; title: string | null }): PlanStep | null {
  if (r.title) {
    const find = (list: PlanStep[]): PlanStep | null => {
      for (const s of list) {
        if (s.title === r.title) return s;
        const inner = find(s.kids ?? []);
        if (inner) return inner;
      }
      return null;
    };
    const found = find(steps);
    if (found) return found;
  }
  let level = steps, step: PlanStep | null = null;
  for (const n of r.place.split(".").map(Number)) {
    step = level[n - 1] ?? null;
    if (!step) return null;
    level = step.kids ?? [];
  }
  return step;
}

// A step's diagram and its decisions under it, where its session sent them, as the step stands now: the latest send of
// each step drawn, an earlier one a line, since desk keeps only the step's latest. The list of steps brings
// it here, the one place a step is read in its chat. A step written as parts shows them, read from the top down, each
// part's diagram in the right half while it shows them, which follows the part being read (StepHalf.tsx).
const StepSent = observer(function StepSent({ at, session, step, top, latest }: { at: string; session: string; step: PlanStep | null; top: string | null; latest: boolean }) {
  const side = useContext(StepSide), reading = dock.reading[session];
  const name = step?.title ?? "A step";
  if (!latest || !step || !isDrawn(step)) {
    return <p className="sent-line" data-at={at}>{GLYPH.file}<span>{name}</span><span className="sent-when">{latest ? "sent" : "an earlier diagram, sent"}</span></p>;
  }
  return (
    <div className="sent step-sent" data-at={at} data-step={step.parts?.length ? step.title : undefined}>
      <div className="sent-head"><StateIcon state={step.state} /><span>{name}</span>{top && top !== name && <span className="step-sent-where">{top}</span>}</div>
      {step.parts?.length ? (
        <StepParts parts={step.parts} said={step.said_html} beside={side.beside} now={reading?.title === step.title ? reading.part : undefined} body="reply body" />
      ) : (
        <>
          {step.diagram_html && <div className="reply body sent-body" dangerouslySetInnerHTML={{ __html: step.diagram_html }} />}
          {step.said_html && <div className="reply body sent-body step-sent-said" dangerouslySetInnerHTML={{ __html: step.said_html }} />}
        </>
      )}
    </div>
  );
});

const LONG = 600; // characters past which a message shows its first lines only, as claude.ai shows a long paste

function You({ text, images, files, when, queued, lost, onSend, onSendNow }: { text: string; images?: number; files?: string[]; when?: number;
  queued?: boolean; lost?: boolean; onSend?: () => void; onSendNow?: () => void }) {
  const [all, setAll] = useState(false);
  const long = text.length > LONG && !all;
  return (
    <div className={`you${queued || lost ? " queued" : ""}`}>
      <div className={`you-bubble${long ? " folded" : ""}`}>
        {images || files?.length ? (
          <span className="you-images">{[...(images ? [images === 1 ? "1 image" : `${images} images`] : []), ...(files ?? [])].join(" · ")}</span>
        ) : null}
        {text}
      </div>
      {long && <button className="you-more" type="button" onClick={() => setAll(true)}>Show all</button>}
      {text && <CopyMessage text={text} when={when} />}
      {queued && (
        <span className="you-queued">
          {GLYPH.clock}Queued
          {onSendNow && <button className="you-more" type="button" title="Send now  Ctrl Enter" onClick={onSendNow}>Send now</button>}
        </span>
      )}
      {lost && (
        <span className="you-queued">
          {GLYPH.none}Not sent
          <button className="you-more" type="button" title="Send it again" onClick={onSend}>Send</button>
        </span>
      )}
    </div>
  );
}

// A reply, marked with where it is (at), with its time (when) and Copy under it once it has all its words.
const Reply = function Reply({ at, text, when, streaming = false }: { at?: string; text: string; when?: number; streaming?: boolean }) {
  const html = useMemo(() => markdown(text), [text]);
  const body = <div className={`reply body${streaming ? " streaming" : ""}`} data-at={at} dangerouslySetInnerHTML={{ __html: html }} />;
  return streaming ? body : <div className="said">{body}<CopyMessage text={text} when={when} /></div>;
};

// A message's Copy, as claude.ai's (measured 1 Nov): a quiet 24px icon under it that puts its text on the clipboard,
// a reply's as its Markdown, and shows a tick for 2 s. It shows while the mouse is on the message, in room kept for it,
// so nothing moves ("add a copy msg button under the msg similar to claude", the user, 1 Nov). The message's time shows
// beside it, at the message's outer edge, the whole date in its tooltip ("i want timestamp under each msg", 1 Nov).
function CopyMessage({ text, when }: { text: string; when?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="msg-actions">
      {when ? <time className="msg-time" dateTime={new Date(when).toISOString()} title={whole(when)}>{sent(when)}</time> : null}
      <button className={`msg-copy${copied ? " copied" : ""}`} type="button" title="Copy" onClick={() => void toClipboard(text).then(() => setCopied(true))}>
        {copied ? GLYPH.check : GLYPH.copy}
      </button>
    </div>
  );
}

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

// A moment as its time today, and with its weekday on another day: 18:40, Thu 04:00.
const moment = (ms: number) =>
  new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;

// Each of the plan's limits, by rate_limit_info's rateLimitType.
const limits: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_overage_included: "Weekly limit",
  overage: "Extra usage limit",
};

// What holds the turn up, in the working line's words.
function held(status: Status): string {
  if (status.kind === "compacting") return "Compacting the conversation";
  if (status.kind === "limit") return `${limits[status.window ?? ""] ?? "Usage limit"} reached${status.resets ? ` · resets ${moment(status.resets * 1000)}` : ""}`; // resetsAt is in seconds
  const wait = Math.ceil((status.until - Date.now()) / 1000);
  return `${wait > 0 ? `Retrying in ${wait}s` : "Retrying"} · ${status.error.replace(/_/g, " ")} · attempt ${status.attempt} of ${status.of}`;
}

function Working({ since, status }: { since: number; status: Status | null }) {
  useTick();
  return (
    <p className="working">
      <span className="spark" aria-hidden="true" />
      {status ? held(status) : `Working${Date.now() - since >= 1000 ? ` · ${elapsed(since)}` : ""}`}
      <span className="working-key">Ctrl C to stop</span>
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

// Open from the start, one line per step, as Claude Code's terminal shows them (20 Oct: "just don't collapse by
// default"); each step's input and output stay a click away.
const Steps = observer(function Steps({ s, items, running, live: isLive }: { s: LiveSession; items: Item[]; running: Block[]; live: boolean }) {
  const [open, setOpen] = useState(true);
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
        <p className="steps-now">{now ? (now.kind === "thinking" ? "Thinking" : now.name ?? "Tool") : `${pendingTool!.name} ${pendingTool!.summary ?? ""}`}</p>
      )}
      {open && (
        <div className="steps-list">
          <StepList s={s} items={items} results={s.results} running={s.working} />
          {running.map((b) => <p key={`${b.msg}:${b.index}`} className="step busy"><span className="step-name">{b.kind === "thinking" ? "Thinking" : b.name}</span></p>)}
        </div>
      )}
    </div>
  );
});

// A fold's steps in order, a line each, but for Claude's commands, which draw as a terminal shows them, one block for
// each run of them ("yep A", the user, 31 Oct, of two mockups). Whether the turn or the subagent still runs, which a
// command with no output yet is running in.
function StepList({ s, items, results, running }: { s: LiveSession; items: Item[]; results: Map<string, Item>; running: boolean }) {
  const runs: (Item | Item[])[] = [];
  for (const i of items) {
    const last = runs[runs.length - 1];
    if (i.t === "tool" && i.name === "Bash") Array.isArray(last) ? last.push(i) : runs.push([i]);
    else runs.push(i);
  }
  return runs.map((r) => Array.isArray(r) ? (
    <div key={r[0].key} className="cmds">
      {r.map((i) => <Command key={i.key} s={s} item={i} result={results.get(i.id!)} running={running} />)}
    </div>
  ) : r.t === "thinking" ? <Thought key={r.key} text={r.text ?? ""} /> : <Step key={r.key} s={s} item={r} result={results.get(r.id!)} />);
}

// A command as a terminal shows it: what Claude said it does, the command after its prompt, then what it printed, a long
// output only its last lines under how many came before, which a click opens whole ("but i'm afraid of long command
// results", the user, 31 Oct). Claude Code gives a command's output only once it ends, so one running shows its seconds.
function Command({ s, item, result, running }: { s: LiveSession; item: Item; result?: Item; running: boolean }) {
  const busy = !result && running;
  useTick(busy);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState<string | null>(null); // the output whole, of which the chat holds only the end (more)
  const command = item.command ?? item.summary ?? "";
  const what = item.summary !== cutTo(command, 120) ? item.summary : ""; // the summary is the command when Claude said nothing
  const out = (whole ?? result?.text ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "");
  const exit = result?.error ? /^Exit code \d+(\n|$)/.exec(out)?.[0] ?? out : ""; // a failure, as Claude Code says it
  const lines = out.length > exit.length ? out.slice(exit.length).split("\n") : [];
  const before = whole === null ? result?.more ?? 0 : 0; // the lines the chat does not hold
  const folds = before > 0 || lines.length >= LAST + FOLDS;
  const shown = folds && !open ? lines.slice(-LAST) : lines;
  const hidden = lines.length - shown.length + before;

  const toggle = async () => {
    if (!open && before && result) {
      const res = await fetch(`/api/live/${s.id}/result/${item.id}`);
      if (res.ok) setWhole(((await res.json()) as { text: string }).text);
      else toast(await reason(res));
    }
    setOpen(!open);
  };

  return (
    <div className="cmd">
      {what && <div className="cmd-what"># {what}</div>}
      <div className="cmd-line"><span className="cmd-prompt">$ </span>{command}</div>
      {exit && <div className="cmd-exit">{exit.trimEnd()}</div>}
      {folds && (
        <button className="cmd-more" type="button" onClick={() => void toggle()}>
          {hidden ? `… ${hidden.toLocaleString()} more line${hidden === 1 ? "" : "s"}` : `… only the last ${LAST} lines`}
        </button>
      )}
      {shown.length > 0 && <div className="cmd-out">{shown.join("\n")}</div>}
      {busy && <div className="cmd-run">running{item.at ? ` · ${elapsed(item.at)}` : ""}</div>}
    </div>
  );
}

// A long output's lines the chat shows, its end, where a build says its error or its result; and the fewest a fold
// hides, since a fold over fewer costs as much room as the lines.
const LAST = 8, FOLDS = 4;

const cutTo = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text); // as the server cuts a summary

// A thought shows its first line, as a step does its summary, and the whole of it on a click.
function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="step thought">
      <button className="step-line" type="button" onClick={() => setOpen(!open)}>
        <span className="step-name">Thought</span>
        <span className="step-what">{text.trim().split("\n")[0]}</span>
      </button>
      {open && <div className="thought-text">{text}</div>}
    </div>
  );
}

function Step({ s, item, result }: { s: LiveSession; item: Item; result?: Item }) {
  const [open, setOpen] = useState(false);
  const agent = item.name === "Agent" || item.name === "Task";
  return (
    <div className={`step${result?.error ? " error" : ""}${result ? "" : " busy"}`}>
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
  // Its words break its steps into runs, each drawn as a fold's are.
  const parts: (Item | Item[])[] = [];
  for (const i of shown) {
    const last = parts[parts.length - 1];
    if (i.t === "text") parts.push(i);
    else if (Array.isArray(last)) last.push(i);
    else parts.push([i]);
  }
  return (
    <div className="steps-list">
      {parts.map((p) => (Array.isArray(p) ? <StepList key={p[0].key} s={s} items={p} results={results} running={Boolean(task)} />
        : <AgentText key={p.key} text={p.text ?? ""} />))}
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
// has run. Only to look at: "i won't try to micromanage each shell or subagents" (the user, 19 Oct). Two or more fold
// into one line counting them by kind, which a click opens ("single task stays one row and multiple is collapsed",
// the user, 1 Nov); once opened, it stays open as they come and go.
const Running = observer(function Running({ s }: { s: LiveSession }) {
  const [open, setOpen] = useState(false);
  useTick(s.tasks.length > 0);
  if (!s.tasks.length) return null;
  const folds = s.tasks.length > 1;
  return (
    <div className={`running${open ? " open" : ""}`} aria-label="Running now">
      {folds && (
        <button type="button" className="running-head" aria-expanded={open} title={open ? "Fold them" : "Show each"} onClick={() => setOpen(!open)}>
          <span className="running-dot" aria-hidden="true" />
          <span className="running-name">{counted(s)}</span>
          <span className="running-fold">{CHEVRON}</span>
        </button>
      )}
      {(!folds || open) && s.tasks.map((t) => (
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

// The tasks counted by kind, in the order each kind first started: "3 shells · 1 scout · 1 watch".
function counted(s: LiveSession): string {
  const kinds = new Map<string, number>();
  for (const t of s.tasks) {
    const name = taskName(s, t).toLowerCase();
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
  }
  return [...kinds].map(([name, n]) => `${n} ${n === 1 ? name : /(s|sh|ch|x)$/.test(name) ? `${name}es` : `${name}s`}`).join(" · ");
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

// The images Claude takes inline, as claude.ai's composer sends them; any other file goes by its path (live.ts, Attachment).
const INLINE = /^image\/(png|jpeg|gif|webp)$/;

// What one message may carry, short of the server's 32 MB for a request once base64 has made it a third bigger.
const MAX_ATTACHED = 22 * 1024 * 1024;

async function readFile(file: File): Promise<Attachment> {
  const url = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
  const type = file.type || "application/octet-stream";
  return { name: file.name || "file", media_type: type, data: url.slice(url.indexOf(",") + 1), size: file.size, ...(INLINE.test(type) ? { url } : {}) };
}

const megabytes = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

// A file's kind under its name, as claude.ai's cards show it: its extension, or FILE.
const kindOf = (name: string) => /\.([^.]{1,8})$/.exec(name)?.[1].toUpperCase() ?? "FILE";

// /model and /effort at the start of a message, as many as typed and in any order (`/model opus /effort med`), set as
// the chip sets them, by a word that starts a model's or an effort's name; what follows them goes as the message.
// Claude Code would take only the first, with the rest as its argument. Null when the message starts with neither, and
// for one alone that desk can't name, such as /effort auto or a full model id, which Claude Code runs as it always has.
const RUNS_CMD = /^\/(model|effort)\s+(\S+)(?:\s+|$)/;

async function runsIn(text: string): Promise<{ set: { model?: string; effort?: string }; shown: Partial<RunsShown>; rest: string } | null> {
  const set: { model?: string; effort?: string } = {}, shown: Partial<RunsShown> = {}, unknown: string[] = [];
  let rest = text, m: RegExpExecArray | null;
  while ((m = RUNS_CMD.exec(rest))) {
    const [, command, word] = m, w = word.toLowerCase(), bare = (name: string) => name.toLowerCase().replace(/\s+/g, "");
    rest = rest.slice(m[0].length);
    if (command === "effort") {
      const effort = EFFORTS.find(([value, label]) => value.startsWith(w) || bare(label).startsWith(w));
      if (effort) set.effort = shown.effort = effort[0];
      else unknown.push(`/effort ${word}`);
    } else {
      const model = (await loadModels().catch(() => [])).find((x) => x.value.toLowerCase().startsWith(w) || bare(x.name).startsWith(w));
      if (!model) unknown.push(`/model ${word}`);
      else {
        set.model = model.value;
        shown.name = model.name;
        if (!model.efforts.length) shown.effort = "";
      }
    }
  }
  if (rest === text) return null;
  if (unknown.length) {
    if (unknown.length === 1 && !set.model && !set.effort && !rest.trim()) return null;
    throw new Error(`desk can't set ${unknown.join(" or ")}: a model is one the chip lists, an effort low, medium, high, xhigh or max.`);
  }
  return { set, shown, rest: rest.trim() };
}

// What is typed and not yet sent, by chat (localStorage.composerDrafts), so a closed or reloaded tab gives it back,
// as claude.ai's composer does. Text only: attached files would soon fill the browser's few megabytes. The 50 chats typed in
// last keep theirs. What Ctrl S put away is kept the same way (localStorage.composerStashes).
type Kept = "composerDrafts" | "composerStashes";

const kept = (store: Kept): Record<string, string> => JSON.parse(localStorage[store] ?? "{}");
const drafts = () => kept("composerDrafts");

function keep(store: Kept, id: string, text: string) {
  const { [id]: _, ...rest } = kept(store);
  const all = Object.entries(rest);
  if (text.trim()) all.push([id, text]);
  localStorage[store] = JSON.stringify(Object.fromEntries(all.slice(-50)));
}

const keepDraft = (id: string, text: string) => keep("composerDrafts", id, text);

// What Ctrl S put away, one per chat, as Claude Code's stash: the text, its files while the page lasts, and where the
// cursor was.
interface Stash { text: string; attached: Attachment[]; caret: number }

const Composer = observer(function Composer({ s }: { s: LiveSession }) {
  const [text, setText] = useState(() => drafts()[s.id] ?? "");
  useEffect(() => keepDraft(s.id, text), [s.id, text]);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [stash, setStash] = useState<Stash | null>(() => {
    const t = kept("composerStashes")[s.id];
    return t ? { text: t, attached: [], caret: t.length } : null;
  });
  useEffect(() => keep("composerStashes", s.id, stash?.text ?? ""), [s.id, stash]);
  const stashBack = usePage<{ stash_back_on_send: boolean }>("/api/settings").data?.stash_back_on_send ?? true;
  const attachedNow = useRef(attached); // the box's files as they stand, for a send that fails after the stash came back
  attachedNow.current = attached;
  const picker = useRef<HTMLInputElement>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [at, setAt] = useState(0);
  const [token, setToken] = useState<ReturnType<typeof tokenAt>>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const commands = useRef<Promise<Pick[]> | null>(null);
  const [known, setKnown] = useState<Set<string> | null>(null); // the names / takes, once asked
  const asked = useRef(0);
  // Messages waiting for Claude's next step, or not sent, which ↑ takes back.
  const queued = s.pending.some((p) => (s.working && p.mid) || p.lost);

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

  // A turn starting means the host holds the session, which lists Claude Code's own commands too: the next / asks again.
  useEffect(() => {
    if (s.working) commands.current = null;
  }, [s.working]);

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
    const typed = text.trim();
    if (!typed && !attached.length) return;
    const sending = attached, giveBack = nextBox(typed);
    const putBack = () => giveBack(typed, sending); // what failed to go
    let t = typed;
    try {
      const runs = await runsIn(typed);
      if (runs) {
        if (!(await s.pick(runs.set, runs.shown))) return putBack();
        const now = s.meta?.runs; // the pick's, drawn at once
        if (now) toast(`Now on ${now.effort ? `${now.name} · ${effortName(now.effort)}` : now.name}`);
        t = runs.rest;
        if (!t && !sending.length) return;
      }
    } catch (error) {
      toast((error as Error).message);
      return putBack();
    }
    if (!(await s.send(t, sending))) putBack();
  }

  // Ctrl+Enter while Claude works, Claude Code's send now: what is typed and what is queued go in at once.
  async function sendNow() {
    const t = text.trim(), sending = attached;
    if (!t && !sending.length && !queued) return; // nothing goes, so the stash stays put
    const putBack = nextBox(t);
    const left = await s.sendNow(t, sending);
    if (left) putBack(left.text, left.attached);
  }

  // Ctrl S, Claude Code's stash: what is typed goes away and the box empties, to write something else first. Ctrl S on
  // an empty box brings it back, and so does the next message entered, unless Settings says to wait for Ctrl S; Ctrl S
  // over both swaps them, so neither is lost.
  function swapStash() {
    const now = text.trim() || attached.length ? { text, attached, caret: box.current!.selectionStart } : null;
    if (!now && !stash) return toast(stashBack ? "Ctrl S puts away what is typed, until the next message is sent." : "Ctrl S puts away what is typed, until Ctrl S again.");
    setStash(now);
    restore(stash ?? { text: "", attached: [], caret: 0 });
  }

  // A message entered leaves the box: the stash comes back into it at once, as Claude Code's does as the message is
  // submitted, not once desk has it, unless Settings says to wait for Ctrl S, or the message is a slash command, which
  // Claude Code's skips. Otherwise the box empties. Gives back what puts a message that failed to go back in the box:
  // a stash that came back goes away again, as the box holds it then.
  function nextBox(typed: string) {
    const back = stashBack && !typed.startsWith("/") ? stash : null;
    if (back) {
      setStash(null);
      restore(back);
      toast("Stash restored");
    } else {
      setText("");
      setAttached([]);
      setPicks([]);
    }
    return (failed: string, files: Attachment[]) => {
      const el = box.current;
      if (back && el && (el.value.trim() || attachedNow.current.length))
        setStash({ text: el.value, attached: attachedNow.current, caret: el.selectionStart });
      setText(failed);
      setAttached(files);
    };
  }

  function restore(back: Stash) {
    setText(back.text);
    setAttached(back.attached);
    setPicks([]);
    requestAnimationFrame(() => {
      const el = box.current!;
      el.focus();
      el.selectionStart = el.selectionEnd = back.caret;
    });
  }

  // ↑ on the box's first line while messages wait: they come back into the box, above what is typed, to edit.
  async function takeBack() {
    const back = await s.withdraw();
    if (!back) return;
    setText((now) => [back.text, now].filter(Boolean).join("\n"));
    setAttached((now) => [...back.attached, ...now]);
    requestAnimationFrame(() => {
      const el = box.current!;
      el.focus();
      el.selectionStart = el.selectionEnd = back.text.length;
    });
  }

  async function attach(files: Iterable<File>) {
    const list = [...files], has = attached.reduce((n, a) => n + a.size, 0), adds = list.reduce((n, f) => n + f.size, 0);
    if (!list.length) return;
    if (has + adds > MAX_ATTACHED) return toast(`A message carries up to ${megabytes(MAX_ATTACHED)} of files${has ? `, and ${megabytes(has)} is attached already` : ""}.`);
    const read = await Promise.all(list.map(readFile));
    setAttached((now) => [...now, ...read]);
  }

  // Ctrl D: the folder chip's menu, which a new chat has until its first message.
  function pickFolder(from: HTMLElement) {
    const chip = from.closest(".composer")?.querySelector<HTMLButtonElement>(".start-in");
    if (chip) chip.click();
    else toast("A chat's folder is picked before its first message.");
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
      {attached.length > 0 && (
        <div className="attached">
          {attached.map((a, n) => (
            <span key={n} className={a.url ? "thumb" : "thumb file"} title={a.name}>
              {a.url ? <img src={a.url} alt="" /> : (
                <>
                  {GLYPH.file}
                  <span className="file-name">{a.name}</span>
                  <span className="file-kind">{kindOf(a.name)}</span>
                </>
              )}
              <button type="button" title="Remove" onClick={() => setAttached(attached.filter((_, k) => k !== n))}>{GLYPH.close}</button>
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
            const files = [...e.clipboardData.files];
            if (files.length) { e.preventDefault(); void attach(files); }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // a Vietnamese or other IME word still being typed
            if (e.key === "Tab" && e.shiftKey && fresh(s)) {
              e.preventDefault(); // Claude Code's key for its modes, here the chip's two
              flipStartAs(s);
            } else if (e.key === "Tab" && e.shiftKey && moded(s)) {
              e.preventDefault(); // once the chat has begun, Manual or Auto
              void s.setAuto(!s.meta?.auto);
            } else if (picks.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setAt(e.key === "ArrowDown" ? (at + 1) % picks.length : (at <= 0 ? picks.length : at) - 1);
            } else if (picks.length && (e.key === "Tab" || (e.key === "Enter" && at >= 0))) {
              e.preventDefault();
              choose(picks[Math.max(at, 0)]);
            } else if (e.key === "Enter" && e.ctrlKey && s.working) {
              e.preventDefault();
              void sendNow();
            } else if (e.key === "Enter" && e.ctrlKey && !text.trim() && !attached.length && pressStep(e.currentTarget)) {
              e.preventDefault();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === "ArrowUp" && queued && !e.currentTarget.value.slice(0, e.currentTarget.selectionStart).includes("\n")) {
              e.preventDefault();
              void takeBack();
            } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && s.working && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
              e.preventDefault(); // a terminal's Ctrl C; with text selected it copies
              void s.interrupt();
            } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyU") {
              e.preventDefault(); // Slack's key to upload a file, and not the browser's page source
              picker.current?.click();
            } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyD") {
              e.preventDefault(); // D for directory, and not the browser's bookmark
              pickFolder(e.currentTarget);
            } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyS") {
              e.preventDefault(); // and not the browser's Save page
              swapStash();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // the frame's Esc would also leave the page: that is the next Esc's to do
              if (picks.length) setPicks([]);
              else e.currentTarget.blur();
            }
          }} />
      </div>
      {/* A tap on its buttons leaves the box focused: on a phone, the box losing focus brings the tabs back, which
          moved the button up before the tap's click reached it, so the first tap did nothing (25 Oct). */}
      <div className="composer-foot" onMouseDown={(e) => e.preventDefault()}>
        <label className="dock-btn attach" title="Attach a file  Ctrl U">
          {GLYPH.plus}
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ""; }} />
        </label>
        {fresh(s) && <StartAs s={s} />}
        {fresh(s) && <StartIn s={s} />}
        {stash && (
          <button className="runs stashed" type="button" title={`${text.trim() || attached.length ? "Swap with the stash" : "Bring back the stash"}  Ctrl S`} onClick={swapStash}>
            {GLYPH.archive}<span>{stash.text.trim().split("\n")[0] || `${stash.attached.length} ${stash.attached.length === 1 ? "file" : "files"}`}</span>
          </button>
        )}
        <span className="spacer" />
        <Used s={s} />
        {moded(s) && <Mode s={s} />}
        <Runs s={s} />
        {s.working && (
          <button className="stop" type="button" title="Stop  Ctrl C" onClick={() => void s.interrupt()}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1.5" /></svg>
          </button>
        )}
        <button className="send" type="button" title={s.working ? "Queue  Enter\nSend now  Ctrl Enter" : "Send  Enter"} disabled={!text.trim() && !attached.length} onClick={() => void send()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
});

// The terminal and the globe in the chat's head: the chat's right half, on its terminal or its browser, open, switched
// to the other or hidden (Half.tsx), each lit while the half shows its view. They are the only place it is, as the half
// has no head of its own ("yeah A", 1 Nov). The globe is only in desk's app, which alone has the Browser (lib/desktop.ts).
// Before them, in an issue's chat with steps, its steps (StepsHalf.tsx), lit too on a step's diagram, which it leaves for
// the list, then, once a step has sent its commit, its Changes: the two you read, then the two Claude drives. The diagram
// has no button: the head is full ("the header in chat interface looks kinda tight", 28 Oct), and it opens from its step.
// Each tooltip names its view and key, open or not, the lit button saying it shows ("just 'diagram' is enough when
// it's showed", the user, 4 Nov).
const HALF_BUTTONS = {
  steps: { icon: GLYPH.steps, label: "Steps", key: "Ctrl ⇧ S" },
  changes: { icon: GLYPH.changes, label: "Changes", key: "Ctrl ⇧ G" },
  terminal: { icon: GLYPH.terminal, label: "Terminal", key: "Ctrl `" },
  browser: { icon: GLYPH.globe, label: "Browser", key: "Ctrl ⇧ B" },
} as const;

const HalfButton = observer(function HalfButton({ id, view }: { id: string; view: keyof typeof HALF_BUTTONS }) {
  const now = dock.halves[id], { icon, label, key } = HALF_BUTTONS[view];
  const open = now === view || (view === "steps" && now === "step");
  return (
    <button className={`dock-btn half-btn half-${view}${open ? " on" : ""}`} type="button" title={`${label}${key && `  ${key}`}`}
      aria-pressed={open} onClick={() => dock.setHalf(id, now === view ? null : view, true)}>{icon}</button>
  );
});

// A new desk chat that nobody has written in yet, whose chip still picks what it becomes.
const fresh = (s: LiveSession) => Boolean(s.meta?.chat && !s.meta.agent && !s.meta.bare && !s.meta.issue) && quiet(s);

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
    <button className="runs start-in" type="button" title="The folder this chat runs in  Ctrl D"
      onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(now, e.currentTarget, (f) => {
        s.startIn(f);
        requestAnimationFrame(focusComposer); // back to typing the first message
      }); }}>
      {GLYPH.folder}<span><bdi>{now}</bdi></span>
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

// desk's own chat, which works an issue or files one: the chats with an agent, and bare ones, have no mode.
const moded = (s: LiveSession) => Boolean(s.meta?.chat && !s.meta.agent && !s.meta.bare && (s.meta.issue || (fresh(s) && s.startAs === "issue")));

// The chip by the model's: Manual stops after each step for the user, and in Auto desk says next for them as a turn
// ends on a step, and go on a plan (the server's auto.ts). "i want modes, adjustable in composer, similar to claude
// code's modes" (the user, 29 Oct); the user picked this chip, always there, from three mockups. Shift Tab flips it
// once the chat has begun: before, it flips Issue and Chat.
const MODES = {
  manual: { label: "Manual", icon: GLYPH.manual, sub: "stops after each step for you" },
  auto: { label: "Auto", icon: GLYPH.auto, sub: "desk says next and go for you" },
} as const;

const Mode = observer(function Mode({ s }: { s: LiveSession }) {
  const now = s.meta?.auto ? "auto" : "manual";
  const items = () => (["manual", "auto"] as const).map((k) => ({ ...MODES[k], group: 1, heading: "Between steps", current: k === now,
    run: () => void s.setAuto(k === "auto") }));
  return (
    <button className={`runs mode${now === "auto" ? " on" : ""}`} type="button" title={fresh(s) ? "Manual or Auto" : "Manual or Auto  Shift Tab"}
      onClick={(e) => { if (!toggled(e.currentTarget)) openMenu({ anchor: e.currentTarget, items }); }}>
      {MODES[now].icon}{MODES[now].label}
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

// The chip by Send: the model and effort the session runs on; its menu picks others and shows the usage.
// The chat's context, outright beside Manual after its grey word, as Claude desktop's ring by its model picker (the
// user, 31 Oct: "display the current context and weekly usage outright"). The 5 hours and the week hold for the whole
// account, so they sit in the window's bar, as the live profile's (frame/StatusBar.tsx; 1 Nov: "so only 5hourly usage
// and weekly usage move to global status bar"). The chip's menu shows all three again.
const Used = observer(function Used({ s }: { s: LiveSession }) {
  const context = s.meta?.usage?.context;
  if (!context) return null;
  return (
    <span className="used">
      <Gauge word="Context" percent={context.percent} title={`Context · ${tokens(context.tokens)} of ${tokens(context.max)}`} />
    </span>
  );
});

// A number shown outright: a ring and its percent, after its grey word, named on hover (the composer's context, the
// window bar's profile numbers). The text replaces the percent where it says more, as api's dollars left, or a dash
// for a meter not read. No colour at any number: "i kinda hate the warning stuff. just gimme the number" (17 Oct), and
// "coloring is bad. usually we should use black and white" (1 Nov).
export function Gauge({ word, percent, text, title }: { word: string; percent: number; text?: string; title: string }) {
  return <span title={title}><span className="word">{word}</span><Ring percent={percent} />{text ?? `${percent}%`}</span>;
}

function Ring({ percent }: { percent: number }) {
  const r = 5.25, round = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" strokeWidth="1.75">
      <circle cx="7" cy="7" r={r} stroke="var(--text-5)" />
      {percent > 0 && <circle cx="7" cy="7" r={r} stroke="currentColor" strokeLinecap="round" transform="rotate(-90 7 7)"
        strokeDasharray={`${(round * Math.min(percent, 100)) / 100} ${round}`} />}
    </svg>
  );
}

const Runs = observer(function Runs({ s }: { s: LiveSession }) {
  const runs = s.meta?.runs;
  if (!runs) return null;
  return (
    <button className="runs" type="button" title="Model and effort" onMouseEnter={warm} onFocus={warm}
      onClick={(e) => { if (!toggled(e.currentTarget)) runsMenu(e.currentTarget, s.id, runs, (set, shown) => void s.pick(set, shown)); }}>
      {runs.name}{runs.effort && <span className="effort"> · {effortName(runs.effort)}</span>}
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
    </button>
  );
});

