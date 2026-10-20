// Linear's Issues page: the page's name in the top bar, and under it a row of three tabs, with Filter and Display at its
// right end: All issues (every open issue, by priority unless the tab's view says otherwise), Active (being worked, or
// waiting on someone) and Backlog (parked, not started). Each tab is a page of its own, at its own address, so each
// keeps its own Filter, Display and Layout (lists/view.ts remembers them by path). My issues has them at /issues, every
// issue; a team's Issues, Linear's team Issues, at /team/<slug>/all, active and backlog, its issues alone.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { GLYPH } from "../ui/icons";
import { Listing, Tools, type ListData } from "./parts";
import { useList } from "./useList";

export const TABS = ["active", "backlog"];
const NAMES: Record<string, string> = { "": "All issues", active: "Active", backlog: "Backlog" };
const EMPTY: Record<string, string> = { "": "No open issues.", active: "Nothing is being worked on.", backlog: "Nothing in the backlog." };

// The Backlog page became All issues on 17 Oct: the view and folded groups this browser kept for it carry over.
for (const name of ["views", "collapsed"]) {
  const kept = JSON.parse(localStorage[name] ?? "{}") as Record<string, unknown>;
  const old = Object.keys(kept).filter((k) => k === "/backlog" || k.startsWith("/backlog "));
  for (const k of old) {
    kept[k.replace("/backlog", "/issues")] ??= kept[k];
    delete kept[k];
  }
  if (old.length) localStorage[name] = JSON.stringify(kept);
}

// A tab's address, My issues' or a team's.
export const issuesPath = (tab: string, team = "") => (team ? `/team/${team}/${tab || "all"}` : tab ? `/issues/${tab}` : "/issues");
export const issuesApi = (tab: string, team = "") => (team ? `/api/page/team/${team}/issues` : "/api/page/issues") + (tab ? `/${tab}` : "");

export const IssuesPage = observer(function IssuesPage({ tab, team = "" }: { tab: string; team?: string }) {
  const path = issuesPath(tab, team);
  const { data } = useList<ListData & { team: { slug: string; title: string } | null }>(path, issuesApi(tab, team), (d) => d.view);
  const title = team ? data?.team?.title : "My issues";
  useEffect(() => { if (title) document.title = `${title} › ${NAMES[tab]} · desk`; }, [tab, title]);
  return (
    <>
      <Bar crumb={team ? <span className="bar-title project-crumb">{GLYPH.team}{title}</span> : <span className="bar-title">My issues</span>} />
      <div className="view-bar">
        <nav className="tabs" aria-label="Views">
          {["", ...TABS].map((t) => (
            <Go key={t} className={`tab${t === tab ? " here" : ""}`} to={issuesPath(t, team)} aria-current={t === tab ? "page" : undefined}>{NAMES[t]}</Go>
          ))}
        </nav>
        <span className="right">{data && <Tools view={data.view} />}</span>
      </div>
      <div className="scroll">
        {data && <Listing list={data} empty={EMPTY[tab]} />}
      </div>
    </>
  );
});
