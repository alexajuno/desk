// An issue, as its page shows it (templates/issue_view.html); the Inbox's right pane shows the same. Its actions sit in
// a row over its Properties (Actions), and its status shows once, in Properties, where a click changes it. Open chat
// opens the issue as its chat, in the middle, with the issue beside it, and hides once the chat is open. Ctrl+Enter
// presses the step and O opens the chat, as the buttons' tooltips say.
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { post, said } from "../api/http";
import { go, Go } from "../app/nav";
import { fromSlack, PRIORITY_NAMES, PROTOCOL_NAMES, STATE_NAMES, type Field, type IssueRow, type Priority, type Protocol, type State, type TreeRow } from "../lib/desk";
import { keyOf } from "../lib/keys";
import { fieldIcon, GLYPH, PrioIcon, ProtoIcon, StateIcon, TRIANGLE } from "../ui/icons";
import { toggled } from "../ui/menu";
import { showFolded } from "../ui/folds";
import { toast } from "../ui/toast";
import { reloadPages, ui } from "../store/ui";
import { copy, setField, setFolder } from "./actions";
import { openSession } from "../sessions/Dock";
import { fieldMenu, folderMenu, milestoneMenu, projectPicker, teamPicker, waitingMenu } from "./menus";
import { datePicker } from "../ui/datepicker";
import { DueChip } from "./Tree";
import { painted } from "./painted";
import { Tree } from "./Tree";
import { Description } from "../editor/Description";

export interface StepButton {
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
  team: { slug: string; title: string } | null;
  all_teams: { slug: string; title: string; state: string }[];
  project: { slug: string; title: string; status: string } | null;
  milestone: string | null; // its title
  trail: { slug: string; title: string }[];
  kids: TreeRow[];
  progress: [number, number];
  agent_files: Record<string, string>; // an older issue's plan.md and result.md, while its document lacks the section
  plan: string; // the Plan, as Markdown, or ""
  result: string; // the Result, as Markdown, or ""
  result_html: string;
  card: [string, string] | null;
  reviewing: boolean; // in review, holding a result to approve rather than a plan or a question
  session_kind: string | null;
  live: string;
  step: { text: string; button: StepButton | null };
  trial: StepButton | null;
  landed: string | null; // in done, where its session said the work landed
}

const Html = ({ className, html }: { className: string; html: string }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
);

const Fold = () => (
  <button className="sec-toggle" type="button" aria-label="Collapse section" aria-expanded="true">{TRIANGLE}</button>
);

// The step's tooltip: its label and key, then where the issue stands when that says more than its status does.
const stepTip = (head: string, text: string, state: State) => (text === STATE_NAMES[state] ? head : `${head}\n${text}`);

// The step of an issue landing (pages.ts, step), drawn at once on Approve.
const LANDING: IssuePageData["step"] = { text: "Landing", button: { label: "Landing…", disabled: true } };

export const IssueView = observer(function IssueView({ data, inInbox = false }: { data: IssuePageData; inInbox?: boolean }) {
  const p = painted(data.issue);
  // Trust folder takes the step's place once starting the issue's session found its folder untrusted.
  const [trustFor, setTrustFor] = useState<string | null>(null);
  // Approve shows Landing while the server is still handing the work to the session, which takes a second or more.
  const landing = p.state === "landing" && data.issue.state !== "landing";
  const step = landing ? LANDING : data.step;

  // A form route of the old pages: Plan, Start, Approve, Try, Trust folder. What its redirect says shows as a toast.
  // From the Inbox, Approve moves on as Linear does: the next notification opens, and a toast says what happened
  // (app.ts, onward).
  async function act(action: string) {
    const slug = p.slug;
    if (action === "approve" || action === "go") {
      ui.paint(slug, "state", action === "go" ? "running" : "landing");
      setTrustFor(null);
    }
    try {
      const res = await post(`/issue/${slug}/${action}`, inInbox ? { src: "inbox" } : {});
      const to = new URL(res.url), note = to.searchParams.get("note");
      if (inInbox && to.pathname === "/inbox" && note) {
        toast(note);
        const next = to.searchParams.get("i");
        go(next ? `/inbox?i=${encodeURIComponent(next)}` : "/inbox", { replace: true });
      } else {
        const { msg, trust } = said(res);
        if (msg) toast(msg);
        setTrustFor(trust ? slug : null);
      }
      await reloadPages();
    } finally {
      ui.unpaint(slug);
    }
  }

  useLayoutEffect(() => showFolded());

  return (
    <>
      <div className="issue" data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
        {...(p.session ? { "data-session": p.session.slice(0, 8) } : {})}>
        <div>
          <Title title={p.title} save={(t) => setField(p.slug, "title", t)} />
          <Chips p={p} team={data.team} project={data.project} />
          {/* In review the card comes first, right under the title, beside the Approve that decides on it. A plan to
              say go to shows as the plan, below. */}
          {p.state === "review" && data.reviewing && (
            <div className="review">
              <div className="section-label" style={{ marginTop: 0 }}>Review</div>
              {data.card ? (
                <>
                  <Html className="body review-card" html={data.card[0]} />
                  <details className="review-details"><summary>Details</summary><Html className="body" html={data.card[1]} /></details>
                </>
              ) : data.result ? <Html className="body" html={data.result_html} />
                : <p className="muted">No result: this was done in a chat, so check the work itself.</p>}
            </div>
          )}
          {/* The issue's one document: its Context, then its Plan and its Result, which its session writes through the
              API. An older issue's plan.md and result.md follow it, in the same order. Then the sub-issues, which the
              agent files, so the section shows only once there is one (Add sub-issue is in the ⋯ menu). */}
          <Description key={p.slug} body={data.body} html={data.body_html} save={(t, base) => setField(p.slug, "body", t, base)} />
          {"plan.md" in data.agent_files && (
            <section className="sec" data-sec="plan.md">
              <div className="section-label sec-head"><Fold />Plan <Go className="muted" to={`/issue/${p.slug}/f/plan.md`} title="Open the plan on its own page, with its contents">plan.md</Go></div>
              <div className="sec-body"><Html className="body plan" html={data.agent_files["plan.md"]} /></div>
            </section>
          )}
          {"result.md" in data.agent_files && !(p.state === "review" && data.reviewing) && <Result html={data.agent_files["result.md"]} />}
          {data.kids.length > 0 && (
            <section className="sec" data-sec="sub-issues">
              <div className="section-label sec-head"><Fold />Sub-issues
                {data.progress[1] > 0 && <span className="pill">{`${data.progress[0]}/${data.progress[1]} done`}</span>}
              </div>
              <div className="sec-body"><Tree items={data.kids} /></div>
            </section>
          )}
        </div>
        <div className="issue-side">
          <Actions p={p} step={step} trial={landing ? null : data.trial} trust={trustFor === p.slug} act={act} />
          <Properties data={data} p={p} />
        </div>
      </div>
    </>
  );
});

// The issue's actions, in a row over its Properties, as Linear's issue has Copy issue URL and its kin: Copy link, a quiet
// Open chat whenever the chat is not the step, Try in review, and last the step, the one primary button.
function Actions({ p, step, trial: t, trust, act }: {
  p: IssueRow; step: IssuePageData["step"]; trial: StepButton | null; trust: boolean; act: (action: string) => void;
}) {
  const b = step.button;
  const session = p.session, chat = session ? () => openSession(session, p.slug) : null;
  return (
    <div className="issue-acts">
      <button className="act" type="button" title="Copy link" onClick={() => copy(`${location.origin}/issue/${p.slug}`, "Link copied")}>{GLYPH.link}</button>
      {chat && !b?.chat && <button className="act open-chat" type="button" title="Open the issue's chat  O" onClick={chat}>{GLYPH.chat}</button>}
      {/* Try, in review: runs the issue's branch in the desk you use (pages.ts, tryButton). Not the step: Approve is. */}
      {t && <button type="button" title={t.title} disabled={t.disabled} onClick={() => act(t.action!)}>{t.label}</button>}
      {trust ? (
        <button className="primary step" type="button" title="Tells Claude Code to trust this folder, as accepting its prompt does"
          onClick={() => act("trust")}>Trust folder</button>
      ) : b?.chat ? chat && (
        <button className="primary step open-chat" type="button" title={stepTip("Open the issue's chat  Ctrl Enter or O", step.text, p.state)}
          onClick={chat}>Open chat</button>
      ) : b && (
        <button className="primary step" type="button" disabled={b.disabled} title={b.disabled ? undefined : stepTip(`${b.label}  Ctrl Enter`, step.text, p.state)}
          onClick={() => act(b.action!)}>{b.label}</button>
      )}
    </div>
  );
}

// The result.md an older issue's session wrote, under its own head.
function Result({ html }: { html: string }) {
  return (
    <section className="sec" data-sec="result.md">
      <div className="section-label sec-head"><Fold />Result <span className="muted">from the agent · result.md</span></div>
      <div className="sec-body"><Html className="body" html={html} /></div>
    </section>
  );
}

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
const Chips = observer(function Chips({ p, team, project }: { p: IssueRow; team: { slug: string; title: string } | null; project: { slug: string; title: string } | null }) {
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
      <button className={`field-chip team-chip${p.team ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.team ?? ""} title="Set team"
        onClick={(e) => { if (!toggled(e.currentTarget)) teamPicker(p.team, { anchor: e.currentTarget }, (value) => setField(p.slug, "team", value)); }}>
        {GLYPH.team}
        <span>{team ? team.title : p.team || "Team"}</span>
      </button>
      <button className={`field-chip project-chip${p.project ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.project ?? ""} title="Set project  Shift P"
        onClick={(e) => { if (!toggled(e.currentTarget)) projectPicker(p.project, p.team, { anchor: e.currentTarget }, (value) => setField(p.slug, "project", value)); }}>
        {GLYPH.project}
        <span>{project ? project.title : p.project || "Project"}</span>
      </button>
      <button className={`field-chip folder-pick${p.folder ? "" : " unset"}`} type="button" data-slug={p.slug} data-value={p.folder ?? ""} title="Pick the folder the issue's session starts in; ~ until you pick one"
        onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(p.folder ?? "", e.currentTarget, (f) => setFolder(p.slug, f)); }}>
        <svg className="glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" /></svg>
        <span>{p.folder || "Folder"}</span>
      </button>
    </div>
  );
});

function Properties({ data, p }: { data: IssuePageData; p: IssueRow }) {
  const live = data.live;
  const liveWord = data.session_kind === "interactive" ? "open in a terminal"
    : live === "working" ? "working" : ["done", "dropped", "waiting"].includes(p.state) ? "idle" : "your turn";
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
      <div className="label">Team</div>
      <form className="prop project-pick" onSubmit={(e) => e.preventDefault()}>
        <select name="value" aria-label="Team" value={p.team ?? ""} onChange={(e) => setField(p.slug, "team", e.target.value)}>
          <option value="">No team</option>
          {data.all_teams.map((t) => <option key={t.slug} value={t.slug}>{t.title}{t.state === "archived" ? " (archived)" : ""}</option>)}
        </select>
      </form>
      <div className="label">Project</div>
      <button className="prop project-pick-menu" type="button" data-slug={p.slug} data-value={p.project ?? ""} title="Set project  Shift P"
        onClick={(e) => { if (!toggled(e.currentTarget)) projectPicker(p.project, p.team, { anchor: e.currentTarget }, (value) => setField(p.slug, "project", value)); }}>
        <span className="muted-icon">{GLYPH.project}</span>
        <span className={data.project ? undefined : "muted"}>{data.project?.title ?? "Add to project"}</span>
      </button>
      {p.project && (
        <button className="prop milestone-pick" type="button" data-slug={p.slug} title="Set milestone  Shift M"
          onClick={(e) => { if (!toggled(e.currentTarget)) milestoneMenu(p.project, p.milestone, { anchor: e.currentTarget }, (id) => setField(p.slug, "milestone", id)); }}>
          <span className="muted-icon">{GLYPH.milestone}</span>
          <span className={data.milestone ? undefined : "muted"}>{data.milestone ?? "Add to milestone"}</span>
        </button>
      )}
      <div className="label">Due date</div>
      <button className="prop due-pick" type="button" data-slug={p.slug} title="Set due date  Shift D"
        onClick={(e) => { if (!toggled(e.currentTarget)) datePicker({ anchor: e.currentTarget, title: "Due date", current: p.due, kinds: ["day"], set: (t) => setField(p.slug, "due", t ?? "") }); }}>
        {p.due ? <DueChip due={p.due} closed={["done", "dropped"].includes(p.state)} /> : <><span className="muted-icon">{GLYPH.calendar}</span><span className="muted">Set due date</span></>}
      </button>
      <div className="label">Works in</div>
      <button className="prop folder-pick" type="button" data-slug={p.slug} data-value={p.folder ?? ""} title="Pick the folder the issue's session starts in; ~ until you pick one"
        onClick={(e) => { if (!toggled(e.currentTarget)) folderMenu(p.folder ?? "", e.currentTarget, (f) => setFolder(p.slug, f)); }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4.5c0-.83.67-1.5 1.5-1.5h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13 2 12.33 2 11.5v-7z" style={{ stroke: "var(--text-3)" }} strokeWidth="1.2" /></svg>
        <span>{p.folder || "~"}</span>
      </button>
      {p.link && (<><div className="label">Link</div><div className="prop static"><a href={p.link}>{fromSlack(p.link) ? "🐧 Slack" : p.link.split("/").pop()}</a></div></>)}
      {/* Where its session said the work landed, unless that is the pull request the Link above already is. */}
      {data.landed && !(p.link && data.landed.includes(p.link)) && (
        <><div className="label">Landed</div><div className="prop static landed">{data.landed.replace(/`/g, "")}</div></>
      )}
      {p.session && (
        <>
          {/* What Open chat opens. Opening it in kitty instead is in the … menu. */}
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

// The title, an issue's, a project's or a chat's, editable where it is, as Linear's: Enter or clicking away saves, Esc
// leaves it as it was. A chat's stays on one line in its head (line).
export function Title({ title, save, line = false }: { title: string; save: (title: string) => unknown; line?: boolean }) {
  const [value, setValue] = useState(title);
  const box = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(true);
  useEffect(() => { if (done.current) setValue(title); }, [title]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || line) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });
  function finish(keep: boolean) {
    if (done.current) return;
    done.current = true;
    ui.setEditing(false);
    const next = value.trim().replace(/\s+/g, " ");
    if (keep && next && next !== title) save(next);
    else setValue(title);
    box.current?.blur();
  }
  const keys = useEditorKeys((_e, k) => k === "Enter", finish);
  const props = {
    ref: box, className: "title", value, "aria-label": "Title", spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setValue(e.target.value.replace(/\n/g, " ")),
    onFocus: () => { done.current = false; ui.setEditing(true); }, onBlur: () => finish(true), ...keys,
  };
  return line ? <input {...props} title="Rename" /> : <textarea rows={1} {...props} />;
}
