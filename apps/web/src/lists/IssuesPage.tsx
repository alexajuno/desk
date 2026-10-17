// Linear's Issues page: three tabs in the top bar, All issues (every open issue, by priority unless the tab's view says
// otherwise), Active (being worked, or waiting on someone) and Backlog (parked, not started). Each tab is a page of its
// own, at its own address, so each keeps its own Filter, Display and Layout (lists/view.ts remembers them by path).
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
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

export const IssuesPage = observer(function IssuesPage({ tab }: { tab: string }) {
  const path = tab ? `/issues/${tab}` : "/issues";
  const { data } = useList<ListData>(path, tab ? `/api/page/issues/${tab}` : "/api/page/issues", (d) => d.view);
  useEffect(() => { document.title = `${NAMES[tab]} · desk`; }, [tab]);
  return (
    <>
      <Bar crumb={<span className="bar-title">Issues</span>} tools={data && <Tools view={data.view} />}>
        <nav className="tabs" aria-label="Views">
          {["", ...TABS].map((t) => (
            <Go key={t} className={`tab${t === tab ? " here" : ""}`} to={t ? `/issues/${t}` : "/issues"} aria-current={t === tab ? "page" : undefined}>{NAMES[t]}</Go>
          ))}
        </nav>
      </Bar>
      <div className="scroll">
        {data && <Listing list={data} empty={EMPTY[tab]} />}
      </div>
    </>
  );
});
