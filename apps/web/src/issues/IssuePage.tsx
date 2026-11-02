// An issue's page (templates/issue.html): the top bar's crumb and its … button, then the issue (IssueView).
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef } from "react";
import { useParams } from "react-router";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { issues } from "../store/issues";
import { toggled } from "../ui/menu";
import { MORE_ICON } from "../ui/icons";
import { painted } from "./painted";
import { IssueView, type IssuePageData } from "./IssueView";
import { actionsMenu } from "./menus";
import { useLive } from "./useLive";

export const IssuePage = observer(function IssuePage() {
  const { slug = "" } = useParams();
  // Its plan and result, which a session writes.
  const { data, error, reload } = usePage<IssuePageData>(`/api/page/issue/${slug}`, `${issues.files.get(slug) ?? 0}`);
  const scroll = useRef<HTMLDivElement>(null);
  // The issue on screen stays until the next one's data is in, as the old pages' soft refresh did: moving between
  // issues never shows an empty page.
  const shown = data;
  const shownSlug = shown?.issue.slug;

  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [shownSlug]);
  useEffect(() => { if (shown) document.title = `${shown.issue.title} · desk`; }, [shown]);
  useLive(shown, reload);

  const p = shown && painted(shown.issue);
  return (
    <>
      <Bar
        crumb={shown && p ? (
          <>
            {shown.team ? <Go className="crumb" to={`/team/${shown.team.slug}`}>{shown.team.title}</Go> : <Go className="crumb" to="/issues">Issues</Go>}
            {shown.trail.map((a) => (<Fragment key={a.slug}><span className="sep">›</span><Go className="crumb" to={`/issue/${a.slug}`}>{a.title}</Go></Fragment>))}
            <span className="sep">›</span><span className="crumb">{p.title}</span>
          </>
        ) : null}
        tools={
          <button className="more" type="button" title="Actions"
            onClick={(e) => { if (shown && p && !toggled(e.currentTarget)) actionsMenu(p, { anchor: e.currentTarget }, p.slug); }}>{MORE_ICON}</button>
        }
      />
      <div className="scroll" ref={scroll}>
        {shown ? <IssueView data={shown} parents={false} /> : error ? <p className="muted" style={{ padding: 24 }}>{error}</p> : null}
      </div>
    </>
  );
});
