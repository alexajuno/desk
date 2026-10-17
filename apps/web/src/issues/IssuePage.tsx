// An issue's page (templates/issue.html): the top bar's crumb and its … button, then the issue (IssueView).
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef } from "react";
import { useParams } from "react-router";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { lineKey } from "../store/frame";
import { issues } from "../store/issues";
import { toggled } from "../ui/menu";
import { GLYPH } from "../ui/icons";
import { dock } from "../store/dock";
import { offerIssue, readingOf, toggleIssue } from "../sessions/Dock";
import { painted } from "./painted";
import { IssueView, type IssuePageData } from "./IssueView";
import { actionsMenu } from "./menus";
import { useLive } from "./useLive";

export const IssuePage = observer(function IssuePage() {
  const { slug = "" } = useParams();
  // Its plan, questions and result, which a session writes, and the line on 8790, which its Try button says.
  const { data, error, reload } = usePage<IssuePageData>(`/api/page/issue/${slug}`, `${issues.files.get(slug) ?? 0} ${lineKey()}`);
  const scroll = useRef<HTMLDivElement>(null);
  // The issue on screen stays until the next one's data is in, as the old pages' soft refresh did: moving between
  // issues never shows an empty page.
  const shown = data;
  const shownSlug = shown?.issue.slug;

  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [shownSlug]);
  useEffect(() => { if (shown) document.title = `${shown.issue.title} · desk`; }, [shown]);
  useLive(shown, reload);
  // Beside its chat, the issue comes in when the agent writes it something new to read (store/dock.ts).
  const chatHere = dock.center && dock.issue && shown?.issue.slug === slug && shown.issue.session === dock.session;
  const reading = chatHere ? readingOf(shown) : null;
  useEffect(() => { if (reading) void offerIssue(shown!.issue.session!, reading); }, [chatHere, reading?.mark, reading?.want]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = shown && painted(shown.issue);
  return (
    <>
      <Bar
        crumb={shown && p ? (
          <>
            {shown.project ? <Go to={`/project/${shown.project.slug}`}>{shown.project.title}</Go> : <Go to="/backlog">Backlog</Go>}
            {shown.trail.map((a) => (<Fragment key={a.slug}><span className="sep">›</span><Go to={`/issue/${a.slug}`}>{a.title}</Go></Fragment>))}
            <span className="sep">›</span><span>{p.title}</span>
          </>
        ) : null}
        tools={
          <>
            <button className="more" type="button" title="Actions"
              onClick={(e) => { if (shown && p && !toggled(e.currentTarget)) actionsMenu(p, { anchor: e.currentTarget }, p.slug); }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
            </button>
            {/* Beside its chat, × leaves the chat alone; the issue's title in the chat's head brings it back. */}
            {dock.sideShown && <button className="more" type="button" title="Hide the issue  ]" onClick={toggleIssue}>{GLYPH.close}</button>}
          </>
        }
      />
      <div className="scroll" ref={scroll}>
        {shown ? <IssueView data={shown} /> : error ? <p className="muted" style={{ padding: 24 }}>{error}</p> : null}
      </div>
    </>
  );
});
