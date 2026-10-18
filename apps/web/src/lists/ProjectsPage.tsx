// The projects (templates/projects.html), each with how many of its issues are open, and Linear's New project button at
// the top bar's end, which opens the new project panel.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { ui } from "../store/ui";
import { GLYPH } from "../ui/icons";

interface ProjectRow {
  slug: string;
  title: string;
  state: "active" | "archived";
  created_short: string;
  open: number;
}

export const ProjectsPage = observer(function ProjectsPage() {
  const { data } = usePage<ProjectRow[]>("/api/page/projects");
  useEffect(() => { document.title = "Projects · desk"; }, []);
  return (
    <>
      <Bar crumb={<span>Projects</span>} tools={
        <button type="button" className="ghost new-project" title="Create new project  N then P" onClick={() => ui.setProjectCreator(true)}>{GLYPH.plus}New project</button>
      } />
      <div className="scroll">
        {data && (
          <div className="page">
            {data.map((pr) => (
              <Go key={pr.slug} className={`item project-row${pr.state === "archived" ? " archived" : ""}${ui.focused === `project/${pr.slug}` ? " focus" : ""}`}
                to={`/project/${pr.slug}`} data-key={`project/${pr.slug}`} onMouseMove={() => { if (ui.focused !== `project/${pr.slug}`) ui.focus(`project/${pr.slug}`, true); }}>
                <span className="title">{pr.title}</span>
                <span className="pill">{`${pr.open} open`}</span>
                <span className="spacer" />{pr.state === "archived" && <span className="muted">Archived</span>}
                <span className="date">{pr.created_short}</span>
              </Go>
            ))}
            {!data.length && <p className="muted" style={{ padding: 16 }}>No projects yet. A project holds ongoing work that is never done, with its issues under it.</p>}
          </div>
        )}
      </div>
    </>
  );
});
