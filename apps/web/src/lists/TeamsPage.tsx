// The teams, each with how many of its issues are open, and a New team button at the top bar's end, as Linear's
// Projects page has its New project, which opens the new team panel.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { ui } from "../store/ui";
import { GLYPH } from "../ui/icons";

interface TeamRow {
  slug: string;
  title: string;
  state: "active" | "archived";
  created_short: string;
  open: number;
}

export const TeamsPage = observer(function TeamsPage() {
  const { data } = usePage<TeamRow[]>("/api/page/teams");
  useEffect(() => { document.title = "Teams · desk"; }, []);
  return (
    <>
      <Bar crumb={<span>Teams</span>} tools={
        <button type="button" className="ghost new-project" title="Create new team" onClick={() => ui.setTeamCreator(true)}>{GLYPH.plus}New team</button>
      } />
      <div className="scroll">
        {data && (
          <div className="page">
            {data.map((pr) => (
              <Go key={pr.slug} className={`item project-row${pr.state === "archived" ? " archived" : ""}${ui.focused === `team/${pr.slug}` ? " focus" : ""}`}
                to={`/team/${pr.slug}`} data-key={`team/${pr.slug}`} onMouseMove={() => { if (ui.focused !== `team/${pr.slug}`) ui.focus(`team/${pr.slug}`, true); }}>
                <span className="title">{pr.title}</span>
                <span className="pill">{`${pr.open} open`}</span>
                <span className="spacer" />{pr.state === "archived" && <span className="muted">Archived</span>}
                <span className="date">{pr.created_short}</span>
              </Go>
            ))}
            {!data.length && <p className="muted" style={{ padding: 16 }}>No teams yet. A team holds ongoing work that is never done, with its issues and projects under it.</p>}
          </div>
        )}
      </div>
    </>
  );
});
