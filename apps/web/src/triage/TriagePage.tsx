// Linear's Triage (linear.app/docs/triage): the chats whose issue is not settled yet, newest first, on the left, at
// /triage every one, and at /team/<slug>/triage a team's, as Linear's Triage is each team's; the one
// picked (?i=<slug>) opens on the right as its chat, to talk on, under Linear's bar of triage actions. Accept 1,
// Decline 2 and Duplicate 3 are Linear's keys; Park 4 is desk's own, for work to keep for later.
//
//   Accept     the chat is told to accept it: its agent picks the folder and protocol, and the issue moves In progress
//   Decline    Dropped at once: nothing to do
//   Duplicate  pick the issue it repeats; the chat is told to bind to it, and desk drops this one as its duplicate
//   Park       Backlog at once
//
// Accept and Duplicate go through the chat, since its agent knows what the work needs and whether the other issue can
// take the chat. The list is the issues in Triage the app holds (store/issues.ts), each with where its chat stands
// from the frame (store/frame.ts), so it follows every chat as it works or settles.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { go, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { setField } from "../issues/actions";
import { actionsMenu } from "../issues/menus";
import { fold, fromSlack, shortDate, type State } from "../lib/desk";
import { SessionView } from "../sessions/Dock";
import { live } from "../sessions/live";
import { frame, talkOf } from "../store/frame";
import { issues, type Issue } from "../store/issues";
import { ui } from "../store/ui";
import { GLYPH, StateIcon } from "../ui/icons";
import { openMenu, toggled, type MenuOptions } from "../ui/menu";
import { toast } from "../ui/toast";

type Row = Issue & { now: string };
type Where = Pick<MenuOptions, "anchor" | "x" | "y">;

const NOW: Record<string, string> = { working: "Its chat is working", idle: "Its chat waits for you", none: "It has no chat" };

// Newest first, as chats come in; a team's alone on its page.
const teamHere = () => /^\/team\/([\w-]+)\/triage/.exec(location.pathname)?.[1] ?? "";
const rows = (team = teamHere()): Row[] => issues.triage.filter((i) => !team || i.team === team).map((i) => ({ ...i, now: talkOf(i) }));
const base = (team = teamHere()) => (team ? `/team/${team}/triage` : "/triage");

// After a row leaves Triage, the next one opens, or the one above when it was the last.
function next(slug: string) {
  const all = rows(), at = all.findIndex((r) => r.slug === slug), then = all[at + 1] ?? all[at - 1];
  go(then && then.slug !== slug ? `${base()}?i=${then.slug}` : base(), { replace: true });
}

function tell(p: Row, text: string, done: string) {
  if (!p.session) return toast("This issue has no chat to tell.");
  void live(p.session).send(text, []);
  toast(done);
}

export const ACTIONS: { key: string; label: string; run: (p: Row, where: Where) => unknown }[] = [
  { key: "1", label: "Accept", run: (p) => tell(p, "Accept it: this is work. Set its folder and protocol, bind this chat to it, and carry on by its protocol.", "Accepted: its chat sets it up.") },
  { key: "2", label: "Decline", run: async (p) => { await setField(p.slug, "state", "dropped"); toast("Declined: nothing to do."); next(p.slug); } },
  { key: "3", label: "Duplicate", run: (p, where) => duplicateMenu(p, where) },
  { key: "4", label: "Park", run: async (p) => { await setField(p.slug, "state", "backlog"); toast("Parked in the backlog."); next(p.slug); } },
];

// Linear's Mark as duplicate: the open issues to pick from, best match first.
function duplicateMenu(p: Row, where: Where) {
  const choices: Promise<{ slug: string; title: string; state: State }[]> = fetch("/api/issues").then((res) => res.json());
  openMenu({
    ...where, filter: "input", className: "wide", placeholder: "Duplicate of…", empty: "No open issue matches",
    items: async (q) => {
      const phrase = fold(q).trim(), words = phrase.split(/\s+/).filter(Boolean);
      const text = (i: { slug: string; title: string }) => fold(`${i.title} ${i.slug}`);
      // Another chat's issue in Triage has its own chat, so this one cannot move to it.
      return (await choices).filter((i) => i.state !== "triage" && words.every((w) => text(i).includes(w)))
        .sort((a, b) => Number(!text(a).includes(phrase)) - Number(!text(b).includes(phrase)))
        .map((i) => ({ icon: <StateIcon state={i.state} />, label: i.title,
          run: () => tell(p, `It’s a duplicate of “${i.title}” (${i.slug}): bind this chat to that issue.`, "Marked as a duplicate: its chat moves to that issue.") }));
    },
  });
}

// 1 to 4 on the Triage page act on the row in focus, else on the one open; false when the key is not theirs.
export function triageKey(key: string): boolean {
  const open = document.querySelector<HTMLElement>(".triage-open[data-slug]");
  if (!open) return false;
  const action = ACTIONS.find((a) => a.key === key);
  const slug = (ui.focused && rows().some((r) => r.slug === ui.focused) ? ui.focused : null) ?? open.dataset.slug;
  const p = rows().find((r) => r.slug === slug);
  if (!action || !p) return false;
  const button = document.querySelector<HTMLElement>(`.triage-actions [data-key="${key}"]`);
  const box = button?.getBoundingClientRect();
  action.run(p, box ? { x: box.left, y: box.bottom + 4 } : { anchor: button });
  return true;
}

export const TriagePage = observer(function TriagePage({ team = "" }: { team?: string }) {
  const [params] = useSearchParams();
  const all = rows(team), picked = all.find((r) => r.slug === params.get("i")) ?? null;
  const teamTitle = team ? issues.teams.get(team)?.title ?? team : "";
  useEffect(() => { document.title = `${teamTitle ? `${teamTitle} › ` : ""}Triage · desk`; }, [teamTitle]);
  return (
    <>
      <Bar
        crumb={<>{team && <><span className="bar-title project-crumb">{GLYPH.team}{teamTitle}</span><span className="sep">›</span></>}<Go className="inbox-head" to={base(team)}>Triage</Go>{picked && <><span className="sep">›</span><span className="inbox-crumb">{picked.title}</span></>}</>}
        tools={picked && (
          <button className="more" title="Actions" onClick={(e) => { if (!toggled(e.currentTarget)) actionsMenu(picked, { anchor: e.currentTarget }, picked.slug); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
          </button>
        )}
      />
      <div className="scroll">
        {frame.data && (
          <div className="inbox triage">
            <div className="inbox-list" data-keep-scroll="always">
              {all.map((p) => (
                <Go key={p.slug} className={`item inbox-row read${p.slug === picked?.slug ? " selected" : ""}${ui.focused === p.slug ? " focus" : ""}`}
                  to={`${base(team)}?i=${p.slug}`} title={p.title} data-slug={p.slug} data-state={p.state} data-priority={p.priority} data-parent={p.parent ?? ""}
                  onMouseMove={() => { if (ui.focused !== p.slug) ui.focus(p.slug, true); }}
                  onContextMenu={(e) => { e.preventDefault(); ui.focus(p.slug); actionsMenu(p, { x: e.clientX, y: e.clientY }, picked?.slug ?? null); }}>
                  <span className={`triage-now ${p.now}`} title={NOW[p.now]}><StateIcon state="triage" /></span>
                  <span className="lines">
                    <span className="line"><span className="title">{p.title}</span>{fromSlack(p.link) && <span className="from" title="Tagged in Slack">🐧</span>}</span>
                    <span className="line sub"><span className="says">{NOW[p.now]}</span><span className="age" title={p.created}>{shortDate(p.created)}</span></span>
                  </span>
                </Go>
              ))}
            </div>
            <div className="inbox-open triage-open" data-slug={picked?.slug} data-state={picked?.state}>
              {picked ? <Picked p={picked} /> : (
                <div className="inbox-empty">
                  <span>{all.length ? "Pick a chat to settle it" : team ? `Nothing in ${teamTitle}'s Triage` : "Nothing in Triage: every chat is settled"}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
});

function Picked({ p }: { p: Row }) {
  return (
    <div className="triage-pane">
      <div className="triage-actions" role="toolbar" aria-label="Triage">
        {ACTIONS.map((a) => (
          <button key={a.key} type="button" data-key={a.key} className={a.key === "1" ? "primary" : "ghost"} title={`${a.label}  ${a.key}`}
            onClick={(e) => { if (!toggled(e.currentTarget)) a.run(p, { anchor: e.currentTarget }); }}>
            {a.label}<kbd>{a.key}</kbd>
          </button>
        ))}
        <Go className="triage-issue" to={`/issue/${p.slug}`}>Open the issue</Go>
      </div>
      {p.session ? <SessionView key={p.session} id={p.session} /> : <p className="convo-empty">This issue has no chat.</p>}
    </div>
  );
}
