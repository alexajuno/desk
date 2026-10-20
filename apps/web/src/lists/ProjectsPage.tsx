// Projects, Linear's list of them (linear.app/alexajuno/projects/all, read on 20 Oct): a header row naming the columns,
// then the projects grouped by status, each group's header its status icon, name and count over a hairline, and each
// row 48px tall: the project's cube and name, its team, its target date (red once passed), how many issues it has, and
// its status icon with how far along it is. Linear's New project button at the top bar's end opens the new project
// panel, as N then P does.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { PROJECT_STATUS_NAMES } from "../issues/menus";
import { ui } from "../store/ui";
import { GLYPH, HealthIcon, ProjectStatusIcon } from "../ui/icons";
import type { ProjectRowData } from "./ProjectPage";

interface Group { status: string; label: string; items: ProjectRowData[] }

export const ProjectsPage = observer(function ProjectsPage() {
  const { data } = usePage<Group[]>("/api/page/projects");
  useEffect(() => { document.title = "Projects · desk"; }, []);
  return (
    <>
      <Bar crumb={<span>Projects</span>} tools={
        <button type="button" className="ghost new-project" title="Create new project  N then P" onClick={() => ui.setProjectCreator("")}>{GLYPH.plus}New project</button>
      } />
      <div className="scroll">
        {data && (
          <div className="page projects-list">
            {data.length > 0 && (
              <div className="projects-cols"><span>Name</span><span>Health</span><span>Team</span><span>Target date</span><span>Issues</span><span>Status</span></div>
            )}
            {data.map((g) => (
              <section key={g.status}>
                <div className="projects-group"><ProjectStatusIcon status={g.status} /><span>{g.label}</span><span className="count">{g.items.length}</span></div>
                {g.items.map((p) => (
                  <Go key={p.slug} className={`item projects-row${ui.focused === `project/${p.slug}` ? " focus" : ""}`} to={`/project/${p.slug}`}
                    data-key={`project/${p.slug}`} onMouseMove={() => { if (ui.focused !== `project/${p.slug}`) ui.focus(`project/${p.slug}`, true); }}>
                    <span className="name">{GLYPH.project}<span className="title">{p.title}</span></span>
                    <span className={`health health-${p.health.state}`} title={p.health.posted ? `Last update ${p.health.posted}` : undefined}>
                      <HealthIcon health={p.health.state === "none" ? null : (["missing", "stale"].includes(p.health.state) ? null : p.health.state)} state={p.health.state} />{p.health.label}
                    </span>
                    <span className="muted">{p.team_title ?? ""}</span>
                    <span className={p.late ? "late" : "muted"}>{p.target_label}</span>
                    <span className="num">{p.issues}</span>
                    <span className="status" title={PROJECT_STATUS_NAMES[p.status]}><ProjectStatusIcon status={p.status} progress={p.progress / 100} />{`${p.progress}%`}</span>
                  </Go>
                ))}
              </section>
            ))}
            {!data.length && <p className="muted" style={{ padding: 16 }}>No projects yet. A project groups issues toward an outcome, with a target date, and finishes. Press N then P.</p>}
          </div>
        )}
      </div>
    </>
  );
});
