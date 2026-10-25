// Projects, Linear's list of them (linear.app/alexajuno/projects/all, read on 20 Oct): a header row naming the columns,
// then the projects grouped by status, each group's header its status icon, name and count over a hairline, and each
// row 48px tall: the project's cube and name, its health, its team, its target date (red once passed), how many issues
// it has, and its status icon with how far along it is. Linear's New project button at the top bar's end opens the new
// project panel, as N then P does. At /projects every project; at /team/<slug>/projects a team's, as Linear's team
// Projects, with no Team column, since every row is that team's. Linear's own list has none on either (measured 20 Oct).
// As Linear's (25 Oct), a group's triangle folds it, and a row's checkbox in its left gutter selects it, as the issue
// lists' do (issues/selection.tsx), for the bar at the bottom to change the status or the team of every one selected.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { usePage } from "../api/page";
import { Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { PROJECT_STATUS_NAMES } from "../issues/menus";
import { projectsMenu, SelectBox, selectTo } from "../issues/selection";
import { issues } from "../store/issues";
import { ui } from "../store/ui";
import { GLYPH, HealthIcon, ProjectStatusIcon, TRIANGLE } from "../ui/icons";
import { useFolded } from "./parts";
import type { ProjectRowData } from "./ProjectPage";

interface Group { status: string; label: string; items: ProjectRowData[] }

export const ProjectsPage = observer(function ProjectsPage({ team = "" }: { team?: string }) {
  const { data } = usePage<Group[]>(team ? `/api/page/team/${team}/projects` : "/api/page/projects");
  const teamTitle = team ? issues.teams.get(team)?.title ?? team : "";
  const { shut, toggle } = useFolded(team ? `/team/${team}/projects` : "/projects", (data ?? []).map((g) => g.status));
  useEffect(() => { document.title = `${teamTitle ? `${teamTitle} › ` : ""}Projects · desk`; }, [teamTitle]);
  return (
    <>
      <Bar crumb={team ? <><span className="bar-title project-crumb">{GLYPH.team}{teamTitle}</span><span className="sep">›</span><span>Projects</span></> : <span>Projects</span>} tools={
        <button type="button" className="ghost new-project" title="Create new project  N then P" onClick={() => ui.setProjectCreator(team)}>{GLYPH.plus}New project</button>
      } />
      <div className="scroll">
        {data && (
          <div className={`page projects-list${team ? " in-team" : ""}`}>
            {data.length > 0 && (
              <div className="projects-cols"><span>Name</span><span>Health</span>{!team && <span>Team</span>}<span>Target date</span><span>Issues</span><span>Status</span></div>
            )}
            {data.map((g) => {
              const folded = shut.includes(g.status);
              return (
                <section key={g.status}>
                  <div className={`projects-group${folded ? " collapsed" : ""}`} data-group={g.status}>
                    <button className="group-toggle" type="button" aria-label="Collapse group" aria-expanded={!folded}
                      onClick={(e) => toggle(g.status, e.altKey, e.currentTarget)}>{TRIANGLE}</button>
                    <ProjectStatusIcon status={g.status} /><span>{g.label}</span><span className="count">{g.items.length}</span>
                  </div>
                  <div className="projects-rows">{g.items.map((p) => <ProjectRow key={p.slug} p={p} team={team} />)}</div>
                </section>
              );
            })}
            {!data.length && <p className="muted" style={{ padding: 16 }}>No projects yet. A project groups issues toward an outcome, with a target date, and finishes. Press N then P.</p>}
          </div>
        )}
      </div>
    </>
  );
});

const ProjectRow = observer(function ProjectRow({ p, team }: { p: ProjectRowData; team: string }) {
  const key = `project/${p.slug}`, selected = ui.selected.has(key);
  return (
    <Go className={`item projects-row${ui.focused === key ? " focus" : ""}${selected ? " selected" : ""}`} to={`/project/${p.slug}`}
      data-key={key} data-status={p.status} data-team={p.team ?? ""} onMouseMove={() => { if (ui.focused !== key) ui.focus(key, true); }}
      onClick={(e) => {
        if (!e.shiftKey) return;
        e.preventDefault(); // Linear's Shift-click selects, where a browser opens the link in a window
        selectTo(key);
      }}
      onContextMenu={(e) => {
        if (!selected) return;
        e.preventDefault();
        projectsMenu({ x: e.clientX, y: e.clientY });
      }}>
      <SelectBox id={key} selected={selected} />
      <span className="name">{GLYPH.project}<span className="title">{p.title}</span></span>
      <span className={`health health-${p.health.state}`} title={p.health.posted ? `Last update ${p.health.posted}` : undefined}>
        <HealthIcon health={p.health.state === "none" ? null : p.health.state} />{p.health.label}
      </span>
      {!team && <span className="muted">{p.team_title ?? ""}</span>}
      <span className={p.late ? "late" : "muted"}>{p.target_label}</span>
      <span className="num">{p.issues}</span>
      <span className="status" title={PROJECT_STATUS_NAMES[p.status]}><ProjectStatusIcon status={p.status} progress={p.progress / 100} />{`${p.progress}%`}</span>
    </Go>
  );
});
