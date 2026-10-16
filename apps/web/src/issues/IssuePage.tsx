// An issue's page (templates/issue.html): the top bar's crumb and its … button, then the issue (IssueView).
import { observer } from "mobx-react-lite";
import { Fragment, useEffect, useRef } from "react";
import { useParams } from "react-router";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { toggled } from "../ui/menu";
import { painted } from "./painted";
import { IssueView, type IssuePageData } from "./IssueView";
import { actionsMenu } from "./menus";

export const IssuePage = observer(function IssuePage() {
  const { slug = "" } = useParams();
  const { data, error, reload } = usePage<IssuePageData>(`/api/page/issue/${slug}`);
  const scroll = useRef<HTMLDivElement>(null);
  // The issue on screen stays until the next one's data is in, as the old pages' soft refresh did: moving between
  // issues never shows an empty page.
  const shown = data;
  const shownSlug = shown?.issue.slug;

  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [shownSlug]);
  useEffect(() => { if (shown) document.title = `${shown.issue.title} · desk`; }, [shown]);

  // A session that starts or stops working changes no file, so the sync socket misses it, yet the strip says it:
  // an open issue with a session asks for its state every 3 s and draws again when it changed (desk.js did the same).
  const live = shown?.issue.session && !["done", "dropped"].includes(shown.issue.state) ? shown.live : null;
  useEffect(() => {
    if (live === null) return;
    const timer = setInterval(async () => {
      try {
        const now = await (await fetch(`/issue/${encodeURIComponent(slug)}/live`, { cache: "no-store" })).text();
        if (now !== live) reload();
      } catch {
        // desk restarting
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [slug, live, reload]);

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
          <button className="more" type="button" title="Actions"
            onClick={(e) => { if (shown && p && !toggled(e.currentTarget)) actionsMenu(p, { anchor: e.currentTarget }, p.slug); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
          </button>
        }
      />
      <div className="scroll" ref={scroll}>
        {shown ? <IssueView data={shown} /> : error ? <p className="muted" style={{ padding: 24 }}>{error}</p> : null}
      </div>
    </>
  );
});
