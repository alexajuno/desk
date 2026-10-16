// The projects (templates/projects.html): a box to start one, then each with how many of its issues are open.
import { observer } from "mobx-react-lite";
import { useEffect } from "react";
import { post, reason } from "../api/http";
import { usePage } from "../api/page";
import { go, Go } from "../app/nav";
import { Bar } from "../frame/Bar";
import { ui } from "../store/ui";
import { toast } from "../ui/toast";

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
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const res = await post("/projects", { title: String(new FormData(e.currentTarget).get("title") ?? "") });
    if (!res.ok) return toast(await reason(res));
    go(new URL(res.url).pathname); // the new project's page, where its route redirected
  }
  return (
    <>
      <Bar crumb={<span>Projects</span>} />
      <div className="scroll">
        {data && (
          <div className="page">
            <form className="project-new" onSubmit={create}>
              <input type="text" name="title" placeholder="New project…" autoComplete="off" aria-label="New project title" />
              <button className="primary">Create project</button>
            </form>
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
