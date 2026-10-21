// An issue's page (templates/issue.html): the top bar's crumb and its … button, then the issue (IssueView).
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef } from "react";
import { useParams } from "react-router";
import { usePage } from "../api/page";
import { go, Go } from "../app/nav";
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
import { placeOf, stepFrom } from "./walk";

// Linear's arrow, from its issue view's Navigate down; turned over for Navigate up.
const ARROW = <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.48 10.326a.75.75 0 0 0-.96-1.152l-1.77 1.475V3.75a.75.75 0 0 0-1.5 0v6.899L5.48 9.174a.75.75 0 0 0-.96 1.152l3 2.5a.75.75 0 0 0 .96 0l3-2.5Z" /></svg>;

// Where the issue stands in the list it was opened from, and the next and previous issue in it, as J and K open them:
// Linear's "7 / 187" and its ↓ ↑ at the top bar's right end. An issue opened from no list has none.
const Walk = observer(function Walk({ slug }: { slug: string }) {
  const place = placeOf(slug);
  if (!place) return null;
  const step = (by: number) => { const to = stepFrom(slug, by); if (to) go(`/issue/${to}`); };
  return (
    <span className="walk">
      <span className="walk-at">{place.at}<span> / {place.of}</span></span>
      <span className="walk-steps">
        <button type="button" title="Navigate down  J" disabled={place.at === place.of} onClick={() => step(1)}>{ARROW}</button>
        <button type="button" title="Navigate up  K" disabled={place.at === 1} onClick={() => step(-1)}>{ARROW}</button>
      </span>
    </span>
  );
});

export const IssuePage = observer(function IssuePage() {
  const { slug = "" } = useParams();
  // Its plan and result, which a session writes, and the line on 8790, which its Try button says.
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
            {shown.team ? <Go to={`/team/${shown.team.slug}`}>{shown.team.title}</Go> : <Go to="/issues">Issues</Go>}
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
            <Walk slug={slug} />
          </>
        }
      />
      <div className="scroll" ref={scroll}>
        {shown ? <IssueView data={shown} /> : error ? <p className="muted" style={{ padding: 24 }}>{error}</p> : null}
      </div>
    </>
  );
});
