// An issue, as its page shows it (templates/issue_view.html); the Inbox's right pane shows the same. The strip: where
// the issue stands, and its one button, the next step, pinned at the top while the issue scrolls. Open chat opens the
// issue as its chat, in the middle, with the issue beside it; whenever it is not the step, a quiet Open chat sits
// beside it, and it hides once the chat is open. Ctrl+Enter presses the step and O opens the chat, as the buttons' tooltips say.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { post, said } from "../api/http";
import { go, Go } from "../app/nav";
import { fromSlack, PRIORITY_NAMES, PROTOCOL_NAMES, STATE_NAMES, type Field, type IssueRow, type Priority, type Protocol, type State, type TreeRow } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { fieldIcon, PLUS, PrioIcon, ProtoIcon, StateIcon, TRIANGLE } from "../ui/icons";
import { toggled } from "../ui/menu";
import { showFolded } from "../ui/folds";
import { toast } from "../ui/toast";
import { reloadPages, ui } from "../store/ui";
import { setField } from "./actions";
import { openSession } from "../sessions/Dock";
import { fieldMenu, folderMenu, projectPicker, waitingMenu } from "./menus";
import { painted } from "./painted";
import { Tree } from "./Tree";

export interface StripButton {
  label: string;
  action?: string;
  chat?: boolean;
  disabled?: boolean;
  title?: string;
}

export interface IssuePageData {
  issue: IssueRow;
  body: string;
  body_html: string;
  project: { slug: string; title: string } | null;
  all_projects: { slug: string; title: string; state: string }[];
  trail: { slug: string; title: string }[];
  kids: TreeRow[];
  progress: [number, number];
  files: string[];
  agent_files: Record<string, string>;
  card: [string, string] | null;
  session_kind: string | null;
  live: string;
  strip: { text: string; button: StripButton | null };
  trial: StripButton | null;
}

const Html = ({ className, html }: { className: string; html: string }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
);

const Fold = () => (
  <button className="sec-toggle" type="button" aria-label="Collapse section" aria-expanded="true">{TRIANGLE}</button>
);

function OpenChat({ slug, session, primary }: { slug: string; session: string; primary: boolean }) {
  return (
    <button className={`${primary ? "primary strip-go" : "ghost"} large open-chat`} type="button" data-slug={slug}
      title={`Open the issue's chat  ${primary ? "Ctrl Enter or O" : "O"}`}
      onClick={() => openSession(session, slug)}>Open chat</button>
  );
}

// The strip of an issue landing (pages.ts, strip), drawn at once on Approve.
const LANDING: IssuePageData["strip"] = { text: "Landing", button: { label: "Landing…", disabled: true } };

export const IssueView = observer(function IssueView({ data, inInbox = false }: { data: IssuePageData; inInbox?: boolean }) {
  const p = painted(data.issue);
  const [note, setNote] = useState<{ slug: string; msg: string | null; trust: boolean }>({ slug: p.slug, msg: null, trust: false });
  const msg = note.slug === p.slug ? note.msg : null, trust = note.slug === p.slug && note.trust;
  // Approve shows Landing while the server is still handing the work to the session, which takes a second or more.
  const landing = p.state === "landing" && data.issue.state !== "landing";
  const strip = landing ? LANDING : data.strip;
  const b = strip.button, t = landing ? null : data.trial;

  // A form route of the old pages: Plan, Start, Approve, Try, Trust folder. Its redirect may say something for the
  // strip. From the Inbox, Approve moves on as Linear does: the next notification opens, and a toast says what
  // happened (app.ts, onward).
  async function act(action: string) {
    const slug = p.slug;
    if (action === "approve") {
      ui.paint(slug, "state", "landing");
      setNote({ slug, msg: null, trust: false });
    }
    try {
      const res = await post(`/issue/${slug}/${action}`, inInbox ? { src: "inbox" } : {});
      const to = new URL(res.url), note = to.searchParams.get("note");
      if (inInbox && to.pathname === "/inbox" && note) {
        toast(note);
        const next = to.searchParams.get("i");
        go(next ? `/inbox?i=${encodeURIComponent(next)}` : "/inbox", { replace: true });
      } else {
        const { msg: m, trust: tr } = said(res);
        setNote({ slug, msg: m, trust: tr });
      }
      await reloadPages();
    } finally {
      ui.unpaint(slug);
    }
  }

  useLayoutEffect(() => showFolded());

  const live = p.session && !["done", "dropped"].includes(p.state);
  return (
    <>
      <div className="strip" data-slug={p.slug} {...(live ? { "data-live": data.live } : {})}>
        <div className="strip-in">
          <span className="strip-state"><StateIcon state={p.state} /></span>
          <span className={`strip-what${msg ? " strip-msg" : ""}`}>{msg || strip.text}</span>
          {p.session && !(b && b.chat) && <OpenChat slug={p.slug} session={p.session} primary={false} />}
          {/* Try, in review: runs the issue's branch in the desk you use (app.try_button). Quiet: Approve stays the step. */}
          {t && (t.disabled
            ? <button className="ghost large" type="button" disabled title={t.title}>{t.label}</button>
            : <button className="ghost large" type="button" title={t.title} onClick={() => act(t.action!)}>{t.label}</button>)}
          {trust ? (
            <button className="primary large strip-go" type="button" title="Tells Claude Code to trust this folder, as accepting its prompt does"
              onClick={() => act("trust")}>Trust folder</button>
          ) : b?.chat && p.session ? <OpenChat slug={p.slug} session={p.session} primary />
            : b?.disabled ? <button className="primary large strip-go" type="button" disabled>{b.label}</button>
            : b ? <button className="primary large strip-go" type="button" title={`${b.label}  Ctrl Enter`} onClick={() => act(b.action!)}>{b.label}</button>
            : null}
        </div>
      </div>
      <div className="issue" data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
        {...(p.session ? { "data-session": p.session.slice(0, 8) } : {})}>
        <div>
          <Title slug={p.slug} title={p.title} />
          <Chips p={p} project={data.project} />
          {/* In review the card comes first, right under the strip whose Approve decides on it. */}
          {p.state === "review" && (
            <div className="review">
              <div className="section-label" style={{ marginTop: 0 }}>Review</div>
              {data.card ? (
                <>
                  <Html className="body review-card" html={data.card[0]} />
                  <details className="review-details"><summary>Details</summary><Html className="body" html={data.card[1]} /></details>
                </>
              ) : "result.md" in data.agent_files ? <Html className="body" html={data.agent_files["result.md"]} />
                : <p className="muted">No result.md: this was done in a chat, so check the work itself.</p>}
            </div>
          )}
          {/* Sub-issues sit right under the title, so a long description or plan never pushes them down the page. */}
          <section className="sec" data-sec="sub-issues">
            <div className="section-label sec-head"><Fold />Sub-issues
              {data.progress[1] > 0 && <span className="pill">{`${data.progress[0]}/${data.progress[1]} done`}</span>}
              <button className="add-sub" type="button" title="Add sub-issue" onClick={() => ui.openCreator({ parent: p.slug, parentTitle: p.title })}>{PLUS}</button>
            </div>
            <div className="sec-body">{data.kids.length > 0 && <Tree items={data.kids} />}</div>
          </section>
          <Description slug={p.slug} body={data.body} html={data.body_html} />
          {Object.entries(data.agent_files).filter(([name]) => !(p.state === "review" && name === "result.md")).map(([name, html]) => (
            <section className="sec" data-sec={name} key={name}>
              {name === "plan.md" ? (
                <>
                  <div className="section-label sec-head"><Fold />Plan <Go className="muted" to={`/issue/${p.slug}/f/plan.md`} title="Open the plan on its own page, with its contents">plan.md</Go></div>
                  <div className="sec-body"><Html className="body plan" html={html} /></div>
                </>
              ) : (
                <>
                  <div className="section-label sec-head"><Fold />{name === "questions.md" ? "Saved questions" : "Result"} <span className="muted">from the agent · {name}</span></div>
                  <div className="sec-body"><Html className="body" html={html} /></div>
                </>
              )}
            </section>
          ))}
        </div>
        <Properties data={data} p={p} />
      </div>
    </>
  );
});

// A pick button: opens the status, priority or protocol menu under itself.
function Pick({ className, slug, field, value, title, children }: { className: string; slug: string; field: Field; value: string; title: string; children: ReactNode }) {
  return (
    <button className={className} type="button" data-slug={slug} data-field={field} {...{ [`data-${field}`]: value }} title={title}
      onClick={(e) => { if (!toggled(e.currentTarget)) fieldMenu(slug, field, value, { anchor: e.currentTarget }); }}>
      {children}
    </button>
  );
}

// Linear's Inbox has no room for the Properties column in a pane under 820px, so it shows them as chips here
// instead (desk.css); each opens the same picker as its row in the column.
const Chips = observer(function Chips({ p, project }: { p: IssueRow; project: { slug: string; title: string } | null }) {
  return (
    <div className="chips">
      <Pick className="field-chip pick" slug={p.slug} field="state" value={p.state} title="Change status  S">
        <span className="icon" data-field="state"><StateIcon state={p.state} /></span><span className="field-label" data-field="state">{STATE_NAMES[p.state]}</span>
      </Pick>
      <Pick className={`field-chip pick${p.priority === "none" ? " unset" : ""}`} slug={p.slug} field="priority" value={p.priority} title="Change priority  P">
        <span className="icon" data-field="priority"><PrioIcon level={p.priority} /></span><span className="field-label" data-field="priority">{p.priority === "none" ? "Priority" : PRIORITY_NAMES[p.priority]}</span>
      </Pick>
      <Pick className="field-chip pick" slug={p.slug} field="protocol" value={p.protocol} title="Change protocol: how much plan, and whether it waits for go">
        <span className="icon" data-field="protocol"><ProtoIcon name={p.protocol} /></span><span className="field-label" data-field="protocol">{PROTOCOL_NAMES[p.protocol]}</span>
      </Pick>
      {p.state === "waiting" && (
        <button className={`field-chip waiting-pick${p.waiting_on ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.waiting_on ?? ""} title="Who or what it waits on"
          onClick={(e) => { if (!toggled(e.currentTarget)) waitingMenu(p.slug, p.waiting_on ?? "", { anchor: e.currentTarget }); }}>
          <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3l2 1.25" /></svg>
          <span>{p.waiting_on || "Waiting on"}</span>
        </button>
      )}
      <button className={`field-chip project-chip${p.project ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.project ?? ""} title="Set project"
        onClick={(e) => { if (!toggled(e.currentTarget)) projectPicker(p.project, { anchor: e.currentTarget }, (value) => setField(p.slug, "project", value)); }}>
        <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" /></svg>
        <span>{project ? project.title : p.project || "Project"}</span>
      </button>
      <button className={`field-chip folder-pick${p.folder ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.folder ?? ""} title="Pick the folder the issue's session starts in; ~ until you pick one"
        onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(p.slug, p.folder ?? "", e.currentTarget); }}>
        <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" /></svg>
        <span>{p.folder || "Folder"}</span>
      </button>
    </div>
  );
});

const LIVE_WORDS: Record<string, string> = { working: "working", stopped: "stopped" };

function Properties({ data, p }: { data: IssuePageData; p: IssueRow }) {
  const live = data.live;
  const liveWord = data.session_kind === "interactive" ? "open in a terminal"
    : live === "idle" ? (["done", "dropped", "waiting"].includes(p.state) ? "idle" : "your turn") : LIVE_WORDS[live] ?? "not running";
  return (
    <aside className="props">
      <div className="label">Properties</div>
      <Pick className="prop pick" slug={p.slug} field="state" value={p.state} title="Change status  S">
        <span className="icon" data-field="state">{fieldIcon("state", p.state)}</span><span className="field-label" data-field="state">{STATE_NAMES[p.state as State]}</span>
      </Pick>
      <Pick className="prop pick" slug={p.slug} field="priority" value={p.priority} title="Change priority  P">
        <span className="icon" data-field="priority">{fieldIcon("priority", p.priority)}</span><span className="field-label" data-field="priority">{PRIORITY_NAMES[p.priority as Priority]}</span>
      </Pick>
      {p.state === "waiting" && (
        <>
          {/* Who or what the issue waits on, and since when (issues.STATES). */}
          <div className="label">Waiting on</div>
          <button className="prop waiting-pick" type="button" data-slug={p.slug} data-value={p.waiting_on ?? ""} title="Who or what it waits on"
            onClick={(e) => { if (!toggled(e.currentTarget)) waitingMenu(p.slug, p.waiting_on ?? "", { anchor: e.currentTarget }); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: "var(--text-3)" }} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3l2 1.25" /></svg>
            <span className={p.waiting_on ? undefined : "muted"}>{p.waiting_on || "Who or what?"}</span>
          </button>
          <div className="prop static muted">{`since ${p.waiting_since_short}${p.waited !== "today" ? ` · ${p.waited}` : ""}`}</div>
        </>
      )}
      {/* How much plan the issue gets, and whether its session waits for go (issues.PROTOCOLS). */}
      <div className="label">Protocol</div>
      <Pick className="prop pick" slug={p.slug} field="protocol" value={p.protocol} title="Change protocol: how much plan, and whether it waits for go">
        <span className="icon" data-field="protocol">{fieldIcon("protocol", p.protocol)}</span><span className="field-label" data-field="protocol">{PROTOCOL_NAMES[p.protocol as Protocol]}</span>
      </Pick>
      <div className="label">Project</div>
      <form className="prop project-pick" onSubmit={(e) => e.preventDefault()}>
        <select name="value" aria-label="Project" value={p.project ?? ""} onChange={(e) => setField(p.slug, "project", e.target.value)}>
          <option value="">No project</option>
          {data.all_projects.map((pr) => <option key={pr.slug} value={pr.slug}>{pr.title}{pr.state === "archived" ? " (archived)" : ""}</option>)}
        </select>
      </form>
      <div className="label">Works in</div>
      <button className="prop folder-pick" type="button" data-slug={p.slug} data-value={p.folder ?? ""} title="Pick the folder the issue's session starts in; ~ until you pick one"
        onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(p.slug, p.folder ?? "", e.currentTarget); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" style={{ stroke: "var(--text-3)" }} strokeWidth="1.2" /></svg>
        <span>{p.folder || "~"}</span>
      </button>
      {p.link && (<><div className="label">Link</div><div className="prop static"><a href={p.link}>{fromSlack(p.link) ? "🐧 Slack" : p.link.split("/").pop()}</a></div></>)}
      {data.files.length > 0 && (
        <>
          <div className="label">Files</div>
          {data.files.map((f) => <div className="prop static" key={f}><Go to={`/issue/${p.slug}/f/${f}`}>{f}</Go></div>)}
        </>
      )}
      {p.session && (
        <>
          {/* What the strip's button acts on. Opening it in kitty instead is in the … menu. */}
          <div className="label">Session</div>
          <div className="prop static"><code>{p.session.slice(0, 8)}</code> <span className={`live ${live}`}>{liveWord}</span></div>
        </>
      )}
    </aside>
  );
}

// Enter during composition belongs to the input method, not to the editor.
function useEditorKeys(isSave: (e: React.KeyboardEvent, k: string) => boolean, finish: (keep: boolean) => void) {
  const s = useRef({ composing: false, escDown: false });
  return {
    onCompositionStart: () => { s.current.composing = true; },
    onCompositionEnd: () => { s.current.composing = false; },
    onKeyDown: (e: React.KeyboardEvent) => {
      const k = keyOf(e);
      if (k === "Escape") s.current.escDown = true;
      if (e.nativeEvent.isComposing || s.current.composing) return;
      if (k === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (isSave(e, k)) { e.preventDefault(); finish(true); }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (keyOf(e) === "Escape" && !s.current.escDown) finish(false);
      s.current.escDown = false;
    },
  };
}

// Click the title to edit it: Enter saves, Esc leaves it as it was, and clicking away saves.
function Title({ slug, title }: { slug: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const done = useRef(false);
  function finish(keep: boolean) {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    ui.setEditing(false);
    const next = value.trim().replace(/\s+/g, " ");
    if (keep && next && next !== title) setField(slug, "title", next);
  }
  const keys = useEditorKeys((_e, k) => k === "Enter", finish);
  if (!editing)
    return <h1 className="title" title="Click to edit" onClick={() => { done.current = false; setValue(title); setEditing(true); ui.setEditing(true); }}>{title}</h1>;
  return (
    <input className="title-edit" type="text" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onBlur={() => finish(true)}
      onFocus={(e) => e.currentTarget.setSelectionRange(value.length, value.length)} {...keys} />
  );
}

// The caret goes where you clicked, found by the text around that spot in the Markdown.
function caretAt(e: React.MouseEvent, markdown: string) {
  const spot = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!spot || spot.startContainer.nodeType !== Node.TEXT_NODE) return markdown.length;
  const text = spot.startContainer.textContent ?? "", i = spot.startOffset;
  const before = text.slice(Math.max(0, i - 16), i), after = text.slice(i, i + 16);
  for (const [probe, shift] of [[before + after, before.length], [after, 0], [before, before.length]] as const) {
    const found = probe.trim() ? markdown.indexOf(probe) : -1;
    if (found >= 0) return found + shift;
  }
  return markdown.length;
}

// Click the description to edit its Markdown: Ctrl+Enter saves, Esc leaves it, clicking away saves.
function Description({ slug, body, html }: { slug: string; body: string; html: string }) {
  const [editing, setEditing] = useState<number | null>(null); // the caret, while editing
  const [value, setValue] = useState(body);
  const box = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  function finish(keep: boolean) {
    if (done.current) return;
    done.current = true;
    setEditing(null);
    ui.setEditing(false);
    if (keep && value.trim() !== body.trim()) setField(slug, "body", value);
  }
  const keys = useEditorKeys((e, k) => k === "Enter" && (e.ctrlKey || e.metaKey), finish);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || editing === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  });
  useLayoutEffect(() => {
    if (editing === null || !box.current) return;
    box.current.focus({ preventScroll: true });
    box.current.setSelectionRange(editing, editing);
  }, [editing === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (editing !== null)
    return <textarea ref={box} className="body-edit" placeholder="Add description…" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => finish(true)} {...keys} />;
  const open = (e: React.MouseEvent) => {
    const t = e.target as Element;
    if (t.closest("a, button, input, textarea, img, .d2, .sec-head") || getSelection()?.toString()) return;
    done.current = false;
    setValue(body);
    setEditing(body.trim() ? caretAt(e, body) : 0);
    ui.setEditing(true);
  };
  return body.trim()
    ? <div className="body description" onClick={open} dangerouslySetInnerHTML={{ __html: html }} />
    : <div className="body description empty" onClick={open}>Add description…</div>;
}
